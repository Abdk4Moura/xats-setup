import type Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { parseDeliveryRow, type DeliverySpec } from '../lib/delivery-spec.js'
import {
  isTmuxAvailable,
  capturePaneTail,
  loadBuffer,
  pasteBuffer,
  sendEnter
} from '../daemon/tmux-cli.js'
import type { ChannelWakeFanout } from '../daemon/channel-wake-fanout.js'
import { dispatchPoke, type TmuxPokeResult } from './transport-dispatch.js'
import { runQuietGuard } from './poke-guard.js'

// allowCrossTeam is for internal auto-poke callers only; MCP tool entry MUST NOT pass it.
export interface PokeDeps {
  db: Database.Database
  callerAgentId: string | null
  allowCrossTeam?: boolean
  channelWakeFanout?: ChannelWakeFanout
}

export interface PokeInput {
  target_agent_id: string
  prompt: string
  skipGuard?: boolean
}

export type PokeResult =
  | {
      ok: true
      transport_used: 'claude-channel'
      channel_session_id: string
    }
  | {
      ok: true
      transport_used: 'tmux-poke'
      pane_id: string
      pane_tail_before: string
      pane_tail_after: string
    }
  | {
      ok: true
      transport_used: 'codex-appserver'
      thread_id: string
    }
  | {
      ok: true
      transport_used: 'opencode-server'
      session_id: string
    }
  | {
      error: string
      detail?: unknown
      transport_used?: 'tmux-poke' | 'codex-appserver' | 'opencode-server'
    }

interface TargetRow {
  agent_id: string
  agent_type: import('../lib/agent-type.js').AgentType | null
  team: string
  tmux_pane_id: string | null
  delivery_kind: string
  delivery_payload: string | null
}

export const PROMPT_MAX_BYTES = 8192
export const PASTE_SETTLE_MS = 400
export const TAIL_LINES = 8

type TmuxStage = 'capture_before' | 'load_buffer' | 'paste_buffer' | 'send_keys' | 'capture_after'

interface StageError {
  stage: TmuxStage
  cause: unknown
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function errorMessage(cause: unknown): string {
  if (cause && typeof cause === 'object') {
    const err = cause as { stderr?: string | Buffer; message?: string }
    if (err.stderr) {
      const s = typeof err.stderr === 'string' ? err.stderr : err.stderr.toString('utf8')
      if (s.length > 0) return s
    }
    if (err.message) return err.message
  }
  return String(cause)
}

export function classifyTmuxError(err: StageError): { error: string; detail: unknown } {
  const msg = errorMessage(err.cause)
  const lower = msg.toLowerCase()
  if (lower.includes("can't find pane") || lower.includes('pane not found') || lower.includes('no such pane')) {
    return { error: 'pane_dead', detail: msg }
  }
  return { error: 'tmux_cmd_failed', detail: { stage: err.stage, stderr: msg } }
}

async function runStage<T>(stage: TmuxStage, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (cause) {
    throw { stage, cause } as StageError
  }
}

async function tmuxPokeImpl(args: {
  pane_id: string
  content: string
  skipGuard?: boolean
}): Promise<TmuxPokeResult> {
  if (!(await isTmuxAvailable())) {
    return { error: 'tmux_unavailable', detail: 'tmux binary not available on PATH' }
  }
  const bufName = `poke-${randomBytes(3).toString('hex')}`
  try {
    if (!args.skipGuard) {
      // Guard inside the try so a pane that dies mid-window is classified
      // (pane_dead / tmux_cmd_failed) instead of throwing out of the primitive.
      const guard = await runStage('capture_before', () => runQuietGuard(args.pane_id))
      if (guard === 'fail') return { error: 'guard_failed' }
    }
    const pane_tail_before = await runStage('capture_before', () => capturePaneTail(args.pane_id, TAIL_LINES))
    await runStage('load_buffer', () => loadBuffer(bufName, args.content))
    await runStage('paste_buffer', () => pasteBuffer(bufName, args.pane_id))
    await delay(PASTE_SETTLE_MS)
    await runStage('send_keys', () => sendEnter(args.pane_id))
    await delay(PASTE_SETTLE_MS)
    const pane_tail_after = await runStage('capture_after', () => capturePaneTail(args.pane_id, TAIL_LINES))
    return { ok: true, pane_tail_before, pane_tail_after }
  } catch (e) {
    return classifyTmuxError(e as StageError)
  }
}

export async function poke(deps: PokeDeps, input: PokeInput): Promise<PokeResult> {
  if (!deps.callerAgentId) return { error: 'unknown_agent' }

  const promptLen = Buffer.byteLength(input.prompt, 'utf8')
  if (promptLen > PROMPT_MAX_BYTES) {
    return { error: 'prompt_too_long', detail: { max: PROMPT_MAX_BYTES, got: promptLen } }
  }

  const target = deps.db
    .prepare(
      `SELECT
         agent_id,
         agent_type,
         team,
         tmux_pane_id,
         delivery_kind,
         delivery_payload
       FROM agents
       WHERE agent_id = ?`
    )
    .get(input.target_agent_id) as TargetRow | undefined
  if (!target) return { error: 'unknown_target' }

  if (target.agent_id === deps.callerAgentId) return { error: 'self_poke_denied' }

  const callerRow = deps.db
    .prepare(`SELECT team FROM agents WHERE agent_id = ?`)
    .get(deps.callerAgentId) as { team: string } | undefined
  if (!callerRow) return { error: 'unknown_agent' }
  if (callerRow.team !== target.team && !deps.allowCrossTeam) {
    return { error: 'cross_team_denied' }
  }

  // Legacy callers may not have ChannelWakeFanout. Keep the historical tmux-only
  // fallback for plain targets, but still allow non-tmux transports that are
  // fully described by the target row itself.
  const fanout = deps.channelWakeFanout
  const delivery = parseDeliveryRow(target) as DeliverySpec
  if (!fanout) {
    if (delivery.kind === 'codex-appserver' || delivery.kind === 'opencode-server') {
      return dispatchPoke(
        { tmuxPoke: tmuxPokeImpl },
        { agent_type: target.agent_type, delivery, tmux_pane_id: target.tmux_pane_id },
        { content: input.prompt, meta: {}, skipGuard: input.skipGuard }
      )
    }

    // Legacy tmux-only path preserved when no fanout supplied by caller.
    if (!target.tmux_pane_id) return { error: 'tmux_pane_not_set' }
    const tr = await tmuxPokeImpl({
      pane_id: target.tmux_pane_id,
      content: input.prompt,
      skipGuard: input.skipGuard
    })
    if ('ok' in tr && tr.ok) {
      return {
        ok: true,
        transport_used: 'tmux-poke',
        pane_id: target.tmux_pane_id,
        pane_tail_before: tr.pane_tail_before,
        pane_tail_after: tr.pane_tail_after
      }
    }
    return { ...(tr as { error: string; detail?: unknown }), transport_used: 'tmux-poke' }
  }

  return dispatchPoke(
    { channelWakeFanout: fanout, tmuxPoke: tmuxPokeImpl },
    { agent_type: target.agent_type, delivery, tmux_pane_id: target.tmux_pane_id },
    { content: input.prompt, meta: {}, skipGuard: input.skipGuard }
  )
}

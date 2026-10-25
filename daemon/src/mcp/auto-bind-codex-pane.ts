import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { CodexPanePreRegRepo, CodexPanePreRegRow } from './codex-pane-pre-register-repo.js'
import type { BindRuntimeIdentityService } from './bind-runtime-identity.js'

const TMUX_LIST_TIMEOUT_MS = 3_000
const PS_LIST_TIMEOUT_MS = 3_000

export interface PaneTtyEntry {
  pane_id: string
  tty: string
}

export interface AutoBindCodexPaneDeps {
  listPanes?: () => Promise<PaneTtyEntry[]>
  ttyProcesses?: (tty: string) => Promise<string[]>
  now?: () => Date
}

export interface AutoBindCodexPaneInput {
  callerAgentId: string
  repo: CodexPanePreRegRepo
  bindRuntimeIdentitySvc: BindRuntimeIdentityService
}

function normalizeTty(raw: string | undefined): string | undefined {
  const value = raw?.trim()
  if (!value) return undefined
  const normalized = value.replace(/^\/dev\//, '')
  if (!normalized || normalized === '?') return undefined
  return normalized
}

async function defaultListPanes(): Promise<PaneTtyEntry[]> {
  const exec = promisify(execFile)
  const { stdout } = await exec(
    'tmux',
    ['list-panes', '-a', '-F', '#{pane_id}\t#{pane_tty}'],
    { timeout: TMUX_LIST_TIMEOUT_MS }
  )
  return stdout
    .split('\n')
    .map(line => line.trimEnd())
    .filter(Boolean)
    .map(line => {
      const [pane_id, pane_tty] = line.split('\t')
      return {
        pane_id,
        tty: normalizeTty(pane_tty) ?? '',
      }
    })
}

async function defaultTtyProcesses(tty: string): Promise<string[]> {
  const exec = promisify(execFile)
  const { stdout } = await exec(
    'ps',
    ['-t', tty, '-o', 'pid=,ppid=,stat=,command='],
    { timeout: PS_LIST_TIMEOUT_MS }
  )
  return stdout
    .split('\n')
    .map(line => line.trimEnd())
    .filter(Boolean)
}

function parsePid(line: string): number | undefined {
  const match = line.trim().match(/^(\d+)\s/)
  if (!match) return undefined
  const pid = Number(match[1])
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  return pid
}

function isCodexRemoteProcess(line: string): boolean {
  if (!/codex/i.test(line)) return false
  if (/codex\s+app-server/i.test(line)) return false
  return /codex(?:-aarch64-a)?\s+.*--remote/i.test(line) || /codex(?:-aarch64-a)?\s+--remote/i.test(line)
}

function argvContainsUuid(line: string, uuid: string): boolean {
  return line.includes(`xats.agent_id="${uuid}"`)
}

interface Candidate {
  row: CodexPanePreRegRow
  pane_id: string
  ui_pid: number
}

/**
 * Scan pending pre-regs, look up tmux panes and their processes, and bind
 * the caller agent row when exactly one pre-reg maps to a live codex --remote
 * process whose argv contains the stored UUID.
 *
 * Returns true only when bind + consume succeeded.  Any error path returns
 * false without propagating.
 */
// Test hook: allows integration tests to override the tmux/ps probes that
// would otherwise need a real tmux session.  Production paths pass `deps`
// explicitly; when they do not, we fall through to these overrides, then to
// the real child_process-backed defaults.
export const __testOverrides: AutoBindCodexPaneDeps = {}

export async function autoBindCodexPane(
  input: AutoBindCodexPaneInput,
  deps: AutoBindCodexPaneDeps = {}
): Promise<boolean> {
  const listPanes = deps.listPanes ?? __testOverrides.listPanes ?? defaultListPanes
  const ttyProcesses = deps.ttyProcesses ?? __testOverrides.ttyProcesses ?? defaultTtyProcesses
  const now = deps.now ?? __testOverrides.now ?? (() => new Date())

  try {
    const nowIso = now().toISOString()
    input.repo.deleteExpired(nowIso)
    const pending = input.repo.listUnexpired(nowIso)
    if (pending.length === 0) return false

    let panes: PaneTtyEntry[]
    try {
      panes = await listPanes()
    } catch {
      return false
    }

    const paneIndex = new Map<string, PaneTtyEntry>()
    for (const pane of panes) {
      if (pane.pane_id) paneIndex.set(pane.pane_id, pane)
    }

    const ttyProcessCache = new Map<string, string[]>()
    const candidates: Candidate[] = []

    for (const row of pending) {
      const pane = paneIndex.get(row.pane_id)
      if (!pane || !pane.tty) continue
      let procs = ttyProcessCache.get(pane.tty)
      if (procs === undefined) {
        try {
          procs = await ttyProcesses(pane.tty)
        } catch {
          procs = []
        }
        ttyProcessCache.set(pane.tty, procs)
      }
      const matching = procs.filter(line =>
        isCodexRemoteProcess(line) && argvContainsUuid(line, row.xats_agent_id)
      )
      if (matching.length !== 1) continue
      const pid = parsePid(matching[0])
      if (pid === undefined) continue
      candidates.push({ row, pane_id: pane.pane_id, ui_pid: pid })
    }

    if (candidates.length !== 1) return false

    const chosen = candidates[0]
    const bindResult = await input.bindRuntimeIdentitySvc.bind({
      callerAgentId: input.callerAgentId,
      agent: 'codex',
      ui_pid: chosen.ui_pid,
    })
    if (!('ok' in bindResult) || !bindResult.ok) return false

    input.repo.takeByPaneId(chosen.pane_id)
    return true
  } catch {
    return false
  }
}

// Stable human-addressable agent references.
//
// A durable mailbox is identified by agent_id. Names are friendly but can be
// renamed, suffixed, or repeated across devices, so they are not sufficient for
// unambiguous addressing. A ref is a deterministic short digest of agent_id:
// it never changes, it survives restarts and reconnects, and it is extended
// only when two refs in the same roster would otherwise collide.
import { createHash } from 'node:crypto'

export const AGENT_REF_MIN_LENGTH = 8
const MAX_REF_LENGTH = 64

export function agentRefPrefix(agent_id: string, length: number = AGENT_REF_MIN_LENGTH): string {
  if (typeof agent_id !== 'string' || agent_id.length === 0) throw new Error('invalid_agent_id')
  if (!Number.isInteger(length) || length < 4 || length > MAX_REF_LENGTH) {
    throw new Error('invalid_ref_length')
  }
  return createHash('sha256').update(agent_id).digest('hex').slice(0, length)
}

/**
 * Deterministic refs for a roster. Distinct agent_ids get distinct refs; if two
 * short prefixes collide, every ref in that roster is lengthened together so the
 * displayed width stays uniform. Never randomized: the same roster yields the
 * same refs across restarts.
 */
export function assignAgentRefs(ids: readonly string[]): Map<string, string> {
  const unique = [...new Set(ids)].sort()
  let length = AGENT_REF_MIN_LENGTH
  for (;;) {
    const refs = new Map<string, string>()
    const seen = new Set<string>()
    let collision = false
    for (const id of unique) {
      const ref = agentRefPrefix(id, length)
      if (seen.has(ref)) {
        collision = true
        break
      }
      seen.add(ref)
      refs.set(id, ref)
    }
    if (!collision) return refs
    if (length >= MAX_REF_LENGTH) throw new Error('agent_ref_collision')
    length = Math.min(length * 2, MAX_REF_LENGTH)
  }
}

export function formatAgentAddress(name: string, ref: string): string {
  return `${name} [${ref}]`
}

// Accepts `name [ref]` and a bare `[ref]`. The name part is only a hint.
const REF_SUFFIX = /^(.*?)\s*\[([0-9a-f]{4,64})\]$/i

export interface ParsedAgentAddress {
  /** Name hint. Empty when the caller supplied a bare ref. */
  name: string
  /** Present only for the explicit `name [ref]` form. */
  ref?: string
}

export function parseAgentAddress(raw: string): ParsedAgentAddress {
  if (typeof raw !== 'string') throw new Error('invalid_address')
  const text = raw.trim()
  if (text.length === 0) throw new Error('empty_address')
  const match = REF_SUFFIX.exec(text)
  if (match) {
    const ref = match[2].toLowerCase()
    // A bare `[ref]` is accepted: the ref alone is unambiguous.
    return { name: match[1]?.trim() ?? '', ref }
  }
  return { name: text }
}

export interface AddressableAgent {
  agent_id: string
  name: string
  device: string
}

export interface AddressCandidate {
  agent_id: string
  name: string
  ref: string
  device: string
}

export type AddressResolution =
  | { ok: true; agent_id: string; name: string; ref: string; device: string; via: 'ref' | 'name' }
  | { error: 'unknown_recipient' }
  | { error: 'ambiguous_address'; candidates: AddressCandidate[] }
  | { error: 'ref_not_found'; candidates: AddressCandidate[] }

/**
 * Resolve a roster address without guessing.
 *
 * - `name [ref]` (or a bare `[ref]`) is authoritative: a ref identifies exactly
 *   one durable identity even after a rename or from another device.
 * - A bare name resolves only when unambiguous. Preferring a device is allowed
 *   because it is a deterministic local-first rule, not a silent pick between
 *   equals; anything still ambiguous is refused with the candidates.
 */
export function resolveAgentAddress(
  raw: string,
  roster: readonly AddressableAgent[],
  opts: { localDevice?: string } = {}
): AddressResolution {
  let parsed: ParsedAgentAddress
  try {
    parsed = parseAgentAddress(raw)
  } catch {
    return { error: 'unknown_recipient' }
  }
  const refs = assignAgentRefs(roster.map((row) => row.agent_id))
  const candidate = (row: AddressableAgent): AddressCandidate => ({
    agent_id: row.agent_id,
    name: row.name,
    ref: refs.get(row.agent_id) ?? agentRefPrefix(row.agent_id),
    device: row.device,
  })

  if (parsed.ref !== undefined) {
    // Compare at the caller's precision. A shortened ref is allowed, but only
    // when it still selects exactly one identity: never guess between two.
    const matches = roster.filter((row) => agentRefPrefix(row.agent_id, parsed.ref!.length) === parsed.ref)
    if (matches.length === 1) {
      const only = matches[0]
      return { ok: true, agent_id: only.agent_id, name: only.name, device: only.device,
        ref: refs.get(only.agent_id)!, via: 'ref' }
    }
    const hinted = matches.length > 1
      ? matches
      : parsed.name ? roster.filter((row) => row.name === parsed.name) : []
    return matches.length > 1
      ? { error: 'ambiguous_address', candidates: hinted.map(candidate) }
      : { error: 'ref_not_found', candidates: hinted.map(candidate) }
  }

  const named = roster.filter((row) => row.name === parsed.name)
  if (named.length === 0) return { error: 'unknown_recipient' }
  if (named.length === 1) {
    const only = named[0]
    return { ok: true, agent_id: only.agent_id, name: only.name, device: only.device,
      ref: refs.get(only.agent_id)!, via: 'name' }
  }
  const local = opts.localDevice === undefined ? [] : named.filter((row) => row.device === opts.localDevice)
  if (local.length === 1) {
    const only = local[0]
    return { ok: true, agent_id: only.agent_id, name: only.name, device: only.device,
      ref: refs.get(only.agent_id)!, via: 'name' }
  }
  return { error: 'ambiguous_address', candidates: named.map(candidate) }
}

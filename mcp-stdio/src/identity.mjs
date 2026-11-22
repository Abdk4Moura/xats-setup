// Pinned identity for stdio-only clients.
//
// A model choosing its own name each session makes the durable xats identity
// unstable: the same agent returns under a new name and therefore a new
// agent_id. When the host supplies XATS_NAME, the bridge enforces it at the
// protocol boundary, so stability does not depend on model obedience.
import { createHash } from 'node:crypto'

// Antigravity stamps the conversation on each tools/call. Using it separates
// concurrent instances of the same agent while keeping one conversation on one
// durable identity across a reload.
const SESSION_META_KEYS = [
  'antigravity.google/root_conversation_id',
  'antigravity.google/conversation_id',
  'conversation_id',
  'session_id',
]

export function sessionKey(meta) {
  if (!meta || typeof meta !== 'object') return undefined
  for (const key of SESSION_META_KEYS) {
    const value = meta[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

/** Short, stable suffix for one agent instance. Never derived from a clock. */
export function instanceSuffix(meta) {
  const key = sessionKey(meta)
  return key ? createHash('sha256').update(key).digest('hex').slice(0, 8) : undefined
}

export function pinIdentity(name, args = {}, team) {
  if (typeof name !== 'string' || !name.trim()) return args
  return {
    ...args,
    name: name.trim(),
    // The agent model derives a team from its working directory, which would
    // hide every other harness on this box from list_agents. The configured
    // team keeps one roster.
    ...(typeof team === 'string' && team.trim() ? { team: team.trim() } : {}),
    // The registration tool has no name_mode: without a session key the daemon
    // treats (device, team, name) as one durable identity, so the same pinned
    // name always resolves to the same agent_id. Never invent a suffix.
    agent_type: args.agent_type ?? 'custom',
    agent_type_name: args.agent_type_name ?? 'Antigravity',
  }
}

/** Apply the pinned identity only to the registration call. */
export function pinnedCall(tool, args, name, meta, team) {
  if (tool !== 'register_agent') return args ?? {}
  const suffix = instanceSuffix(meta)
  // Without a host-provided conversation id there is exactly one identity for
  // this host: multiple instances would then share it, so say so in the docs.
  return pinIdentity(suffix ? `${name}-${suffix}` : name, args ?? {}, team)
}

// Pinned identity for stdio-only clients.
//
// A model choosing its own name each session makes the durable xats identity
// unstable: the same agent returns under a new name and therefore a new
// agent_id. When the host supplies XATS_NAME, the bridge enforces it at the
// protocol boundary, so stability does not depend on model obedience.
export function pinIdentity(name, args = {}) {
  if (typeof name !== 'string' || !name.trim()) return args
  return {
    ...args,
    name: name.trim(),
    // exact: a live agent already holding the name is reported, never
    // silently suffixed into a different durable identity.
    name_mode: 'exact',
    agent_type: args.agent_type ?? 'custom',
    agent_type_name: args.agent_type_name ?? 'Antigravity',
  }
}

/** Apply the pinned identity only to the registration call. */
export function pinnedCall(tool, args, name) {
  return tool === 'register_agent' ? pinIdentity(name, args ?? {}) : (args ?? {})
}

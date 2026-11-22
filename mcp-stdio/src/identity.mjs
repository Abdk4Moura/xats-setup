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
    // The registration tool has no name_mode: without a session key the daemon
    // treats (device, team, name) as one durable identity, so the same pinned
    // name always resolves to the same agent_id. Never invent a suffix.
    agent_type: args.agent_type ?? 'custom',
    agent_type_name: args.agent_type_name ?? 'Antigravity',
  }
}

/** Apply the pinned identity only to the registration call. */
export function pinnedCall(tool, args, name) {
  return tool === 'register_agent' ? pinIdentity(name, args ?? {}) : (args ?? {})
}

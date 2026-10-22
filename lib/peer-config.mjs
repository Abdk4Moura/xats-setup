// peer-config.mjs — one settings file for the peer runtime, shared by the
// runtime, the CLI, and the agent-facing /xats command.
//
// The interesting setting is permissiveness. Two machines that already share a
// network (LAN, tailnet, tunlion mesh) are a meaningful signal, but it is still
// a decision, so the default stays conservative and the levels are explicit:
//
//   manual  — every new peer needs an explicit approval (default)
//   shared  — auto-approve peers discovered on an interface you have explicitly
//             listed in `trustedOverlays`. Sharing a network is not by itself
//             trust: a mesh may also carry CI workers and delegated devices.
//   open    — auto-approve any candidate that completes a pairing handshake
//             (only sensible on a network you fully control)
//
// Invites are unaffected: a peer presenting an invite still needs approval
// unless the policy allows it. Revocation always works.
import fs from 'node:fs';
import path from 'node:path';

export const PEER_POLICIES = ['manual', 'shared', 'open'];
export const DEFAULT_POLICY = 'manual';

const CONFIG_FILE = 'config.json';
const MAX_PEERS = 64;

function configPath(stateDir) {
  return path.join(stateDir, CONFIG_FILE);
}

export function defaultPeerConfig() {
  return {
    version: 1,
    overlay: 'auto',
    overlayPeers: [],
    trustedOverlays: [],
    autoApprove: DEFAULT_POLICY,
    port: null,
  };
}

/** Validate and normalise an arbitrary object into a usable config. */
export function normalizePeerConfig(raw) {
  const base = defaultPeerConfig();
  if (!raw || typeof raw !== 'object') return base;

  const overlay = typeof raw.overlay === 'string' && raw.overlay.trim() ? raw.overlay.trim() : base.overlay;
  const autoApprove = PEER_POLICIES.includes(raw.autoApprove) ? raw.autoApprove : base.autoApprove;
  const overlayPeers = Array.isArray(raw.overlayPeers)
    ? raw.overlayPeers
        .filter((entry) => typeof entry === 'string' && entry.trim())
        .slice(0, MAX_PEERS)
        .map((entry) => entry.trim())
    : [];
  const trustedOverlays = Array.isArray(raw.trustedOverlays)
    ? raw.trustedOverlays
        .filter((entry) => typeof entry === 'string' && entry.trim())
        .slice(0, MAX_PEERS)
        .map((entry) => entry.trim())
    : [];
  const port = Number.isInteger(raw.port) && raw.port > 0 && raw.port <= 65535 ? raw.port : null;

  return { version: 1, overlay, overlayPeers, trustedOverlays, autoApprove, port };
}

export function loadPeerConfig(stateDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(stateDir), 'utf8'));
    return normalizePeerConfig(raw);
  } catch {
    // A missing or corrupt file must never stop the listener from starting.
    return defaultPeerConfig();
  }
}

export function savePeerConfig(stateDir, next) {
  const normalized = normalizePeerConfig(next);
  fs.mkdirSync(stateDir, { recursive: true });
  const file = configPath(stateDir);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  return normalized;
}

/** Set one dotted key (`policy.autoApprove`, `overlay`, `port`). */
export function setPeerConfigValue(stateDir, key, value) {
  const current = loadPeerConfig(stateDir);
  const next = { ...current };
  switch (key) {
    case 'policy':
    case 'autoApprove':
    case 'policy.autoApprove':
      if (!PEER_POLICIES.includes(value)) throw new Error(`invalid policy: ${value} (use ${PEER_POLICIES.join('|')})`);
      next.autoApprove = value;
      break;
    case 'overlay':
      next.overlay = String(value);
      break;
    case 'trustedOverlays':
      next.trustedOverlays = String(value)
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
      break;
    case 'overlayPeers':
      next.overlayPeers = String(value)
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
      break;
    case 'port': {
      const port = Number.parseInt(String(value), 10);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`invalid port: ${value}`);
      next.port = port;
      break;
    }
    default:
      throw new Error(`unknown setting: ${key} (policy|overlay|overlayPeers|trustedOverlays|port)`);
  }
  return savePeerConfig(stateDir, next);
}

/**
 * Precedence for the overlay provider: an explicit env var wins (a one-off run
 * should be able to override the saved default), then the config, then `auto`.
 */
export function effectiveOverlay(env, config) {
  if (env?.XATS_OVERLAY) return env.XATS_OVERLAY;
  return config?.overlay || 'auto';
}

/**
 * Whether a discovered candidate may be trusted without asking.
 *
 * `shared` requires the discovery source to be explicitly listed in
 * `trustedOverlays`. Being on the same network must not imply xats trust: a mesh
 * can also carry CI workers and delegated devices, and transport trust is not
 * identity trust.
 */
export function policyAllowsAutoApprove(policy, candidate, config = {}) {
  const level = PEER_POLICIES.includes(policy) ? policy : DEFAULT_POLICY;
  if (level === 'open') return true;
  if (level === 'shared') {
    const trusted = Array.isArray(config?.trustedOverlays) ? config.trustedOverlays : [];
    const source = candidate && typeof candidate.source === 'string' ? candidate.source : '';
    return Boolean(source) && trusted.includes(source);
  }
  return false;
}

// overlay-discovery.mjs — peer discovery over *any* overlay network.
//
// The xats peer protocol does not care how packets reach a peer. What differs
// between overlays is only:
//
//   1. enumeration — which peers exist and are online
//   2. naming      — what host to dial for a given peer
//
// Everything else (the peer listener on 9110-9120, pinned TLS, explicit
// approval) is overlay-independent. So an overlay is a small adapter returning
// [{ name, host }] and nothing more; discovery never probes, connects, trusts or
// pairs. It only proposes candidates, exactly like the mDNS path.
//
// Supported providers: tunlion, tailscale, netbird, zerotier (best effort), and
// `static` for any overlay without a CLI (XATS_OVERLAY_PEERS=host1,host2).
import { lookup } from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';

export const XATS_OVERLAY_PROTOCOL_VERSION = '1';
export const OVERLAY_PROVIDERS = ['tunlion', 'tailscale', 'netbird', 'zerotier', 'static'];

function validPort(port) {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim().replace(/\.$/, '');
  }
  return null;
}

/* ------------------------------- tunlion -------------------------------- */

export function parseTunlionDevices(payload) {
  const devices = payload?.data?.devices ?? payload?.devices ?? [];
  if (!Array.isArray(devices)) return [];
  // `online` is stale handshake metadata, not reachability: a peer reporting
  // online:false has been observed answering 401 on its overlay address. So it
  // is carried as a hint and never used to hide a peer that has an address.
  return devices
    .filter((d) => d && typeof d.name === 'string' && d.name)
    .map((d) => ({
      name: d.name,
      host: typeof d.mesh === 'string' && d.mesh ? d.mesh : null,
      online: d.online === true,
      // Once tunlion reports L3 state, carry it: an address that is only
      // *derived* is not an address you can dial.
      l3: d.l3 && typeof d.l3 === 'object' ? d.l3 : null,
    }))
    .filter((d) => d.host);
}

/**
 * Advisory only. A peer's reported L3 state is *not* a discovery filter:
 * the roster's own fields are known to be stale (a peer reporting
 * `online:false` answered 401), so treating them as a precondition would hide
 * reachable peers. Discovery answers "who is on this overlay"; whether a dial
 * works is learned by dialling.
 *
 * The dialer may still use this as a hint (prefer `ready`, try others after).
 */
export function isDialablePeer(peer) {
  if (!peer || typeof peer !== 'object') return false;
  const state = peer.l3 && typeof peer.l3.state === 'string' ? peer.l3.state : null;
  return state === null || state === 'ready';
}

/* ------------------------------ tailscale ------------------------------- */

// `tailscale status --json`: Peer is a map of nodekey -> peer.
export function parseTailscaleStatus(payload, selfDnsName = null) {
  const peers = payload?.Peer;
  if (!peers || typeof peers !== 'object') return [];
  const result = [];
  for (const peer of Object.values(peers)) {
    if (!peer || typeof peer !== 'object') continue;
    if (peer.Online === false) continue;
    const dns = firstString(peer.DNSName);
    if (selfDnsName && dns === selfDnsName) continue;
    // Prefer MagicDNS: it survives address changes. Fall back to the raw
    // 100.x / fd7a: address when MagicDNS is disabled.
    const ip = Array.isArray(peer.TailscaleIPs) ? firstString(...peer.TailscaleIPs) : null;
    const host = dns || ip;
    if (!host) continue;
    const name = firstString(peer.HostName, ip, dns);
    if (name) result.push({ name, host });
  }
  return result;
}

/* -------------------------------- netbird ------------------------------- */

// `netbird status --json`: peers.details[] with fqdn / netbirdIp / status.
export function parseNetbirdStatus(payload) {
  const details = payload?.peers?.details ?? payload?.peers ?? [];
  if (!Array.isArray(details)) return [];
  return details
    // Netbird reports "Connected"/"Disconnected"; matching on /connect/ would
    // happily accept the disconnected ones.
    .filter((peer) => peer && !/disconnect|offline|down|unavailable|error/i.test(String(peer.status ?? '')))
    .map((peer) => {
      const host = firstString(peer.fqdn, peer.netbirdIp, peer.ip);
      const name = firstString(peer.fqdn, peer.hostname, peer.netbirdIp);
      return host && name ? { name, host } : null;
    })
    .filter(Boolean);
}

/* ------------------------------- zerotier ------------------------------- */

// zerotier-cli has no "list peers with names". Best effort: peers are addressed
// by managed IP, which only exists in `listnetworks -j` for *this* node. So the
// honest answer is that zerotier needs explicit peer hosts (static provider),
// and this function only returns what a caller already knows.
export function parseZerotierNetworks(payload, knownHosts = []) {
  const networks = Array.isArray(payload) ? payload : [];
  const assigned = networks.flatMap((n) => (Array.isArray(n?.assignedAddresses) ? n.assignedAddresses : []));
  return knownHosts
    .filter((host) => typeof host === 'string' && host)
    .flatMap((host) => {
      // A bare host is fine; an assigned prefix is only informative here.
      const name = host.split('/')[0].split(':')[0];
      return assigned.includes(host) ? [] : [{ name, host: name }];
    });
}

/** `static`: any overlay, hosts listed by hand. */
export function parseStaticPeers(value) {
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      // Accept "host" or "name=host".
      const eq = entry.indexOf('=');
      if (eq > 0) return { name: entry.slice(0, eq).trim(), host: entry.slice(eq + 1).trim() };
      return { name: entry, host: entry };
    })
    .filter((peer) => peer.name && peer.host);
}

/* ------------------------------- dispatch ------------------------------- */

const PROVIDER_COMMANDS = {
  tunlion: ['tunlion', ['devices', '--json']],
  tailscale: ['tailscale', ['status', '--json']],
  netbird: ['netbird', ['status', '--json']],
  zerotier: ['zerotier-cli', ['listnetworks', '-j']],
};

export function providerCommand(provider) {
  return PROVIDER_COMMANDS[provider] ?? null;
}

/** Parse a provider's output into [{ name, host }]. */
export function parseProviderPeers(provider, output, { env = process.env } = {}) {
  let payload;
  try {
    payload = JSON.parse(output);
  } catch {
    return [];
  }
  switch (provider) {
    case 'tunlion':
      return parseTunlionDevices(payload);
    case 'tailscale':
      return parseTailscaleStatus(payload, env.XATS_OVERLAY_SELF ?? null);
    case 'netbird':
      return parseNetbirdStatus(payload);
    case 'zerotier':
      return parseZerotierNetworks(payload, parseStaticPeers(env.XATS_OVERLAY_PEERS ?? '').map((p) => p.host));
    case 'static':
      return parseStaticPeers(env.XATS_OVERLAY_PEERS ?? '');
    default:
      return [];
  }
}

/** Candidate records shaped exactly like the mDNS ones. */
export function overlayCandidates({ peers, port, now = () => Date.now(), source = 'overlay' }) {
  if (!validPort(port) || !Array.isArray(peers)) return [];
  // Only a peer with no address at all is useless; everything else is offered,
  // annotated with whatever the overlay reported, so a stale or pessimistic
  // field can never hide a candidate.
  return peers
    .filter((peer) => peer && typeof peer.host === 'string' && peer.host)
    .map((peer) => ({
      deviceId: peer.name,
      endpoint: { host: peer.host, port },
      serviceName: peer.host,
      protocolVersion: XATS_OVERLAY_PROTOCOL_VERSION,
      discoveredAt: now(),
      source,
      // Advisory only; the dialer decides what to try and records the outcome.
      online: peer.online === true,
      l3: peer.l3 && typeof peer.l3 === 'object' ? peer.l3 : null,
    }));
}

/**
 * Poll an overlay for peers and emit candidates. Returns { stop, scan }.
 *
 * `runCommand([cmd, args])` is injected so tests need no binaries, and so the
 * caller decides which CLI to trust. `resolve` defaults to the system resolver,
 * i.e. exactly the way a person's shell would resolve the name.
 */
export function attachXatsOverlay({
  provider = 'tunlion',
  runCommand,
  port,
  onCandidate,
  onLost = () => {},
  onError = () => {},
  resolve = (host) => lookup(host),
  env = process.env,
  intervalMs = 30_000,
  now = () => Date.now(),
  autoScan = true,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) {
  if (!validPort(port)) throw new TypeError('invalid_peer_port');
  if (typeof onCandidate !== 'function') throw new TypeError('onCandidate_required');

  const staticPeers = provider === 'static';
  if (staticPeers && typeof runCommand !== 'function') {
    // Nothing to execute; parse peers straight from configuration.
    runCommand = async () => '';
  } else if (typeof runCommand !== 'function') {
    throw new TypeError('runCommand_required');
  }

  const known = new Map();
  let stopped = false;

  async function scan() {
    if (stopped) return;
    const peers = staticPeers
      ? parseStaticPeers(env.XATS_OVERLAY_PEERS ?? '')
      : (() => {
          const command = providerCommand(provider);
          if (!command) return null;
          return command;
        })();
    if (peers === null) {
      onError(new Error(`unknown overlay provider: ${provider}`));
      return;
    }

    let list;
    if (staticPeers) {
      list = peers;
    } else {
      try {
        const output = await runCommand(peers);
        list = parseProviderPeers(provider, output, { env });
      } catch (error) {
        // Overlay CLI missing or L3 down is normal; never break the peer service.
        onError(error);
        return;
      }
    }

    const seen = new Set();
    for (const candidate of overlayCandidates({ peers: list, port, now, source: provider })) {
      try {
        await resolve(candidate.endpoint.host);
      } catch (error) {
        onError(error);
        continue;
      }
      const key = `${candidate.deviceId}|${candidate.endpoint.host}|${candidate.endpoint.port}`;
      seen.add(key);
      if (known.has(key)) continue;
      known.set(key, candidate);
      onCandidate({ ...candidate, endpoint: { ...candidate.endpoint } });
    }

    for (const [key, candidate] of known) {
      if (seen.has(key)) continue;
      known.delete(key);
      onLost({ ...candidate, endpoint: { ...candidate.endpoint } });
    }
  }

  if (autoScan) void scan();
  const timer = setIntervalFn(() => {
    void scan();
  }, intervalMs);
  if (typeof timer?.unref === 'function') timer.unref();

  return {
    stop() {
      stopped = true;
      clearIntervalFn(timer);
    },
    scan,
  };
}

/**
 * Minimal PATH lookup, so the peer runtime does not have to ship the installer's
 * platform helpers. Honours PATHEXT on Windows.
 */
export function whichInPath(command, env = process.env, exists = (file) => fs.existsSync(file)) {
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? String(env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      if (exists(candidate)) return candidate;
      if (ext) {
        const lower = path.join(dir, command + ext.toLowerCase());
        if (exists(lower)) return lower;
      }
    }
    const bare = path.join(dir, command);
    if (exists(bare)) return bare;
  }
  return null;
}

/**
 * Resolve an overlay binary even when PATH is minimal (systemd user units, Task
 * Scheduler, launchd all hand the process a much smaller PATH than a login shell).
 */
export function resolveOverlayBinary(command, env = process.env, exists = (f) => fs.existsSync(f)) {
  const fromPath = whichInPath(command, env, exists);
  if (fromPath) return fromPath;
  const home = env.HOME || env.USERPROFILE || '';
  const extra = [
    home ? path.join(home, '.local', 'bin') : null,
    '/usr/local/bin',
    '/opt/homebrew/bin',
    home ? path.join(home, 'bin') : null,
    home ? path.join(home, '.bun', 'bin') : null,
  ].filter(Boolean);
  for (const dir of extra) {
    for (const name of process.platform === 'win32' ? [`${command}.exe`, `${command}.cmd`, command] : [command]) {
      const candidate = path.join(dir, name);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/** Pick a provider: explicit env wins, otherwise the first overlay we can find. */
export function detectProvider({ which, env = process.env } = {}) {
  const explicit = env.XATS_OVERLAY;
  if (explicit && explicit !== 'auto') return OVERLAY_PROVIDERS.includes(explicit) ? explicit : null;
  if (explicit === 'static') return 'static';
  const order = ['tunlion', 'tailscale', 'netbird', 'zerotier'];
  for (const provider of order) {
    const command = providerCommand(provider);
    if (command && typeof which === 'function' && which(command[0])) return provider;
  }
  return parseStaticPeers(env.XATS_OVERLAY_PEERS ?? '').length > 0 ? 'static' : null;
}

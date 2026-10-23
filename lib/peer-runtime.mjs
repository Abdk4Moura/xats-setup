import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { loadOrCreateDeviceIdentity, PeerPairingManager, PeerTrustStore } from './peer-pairing.mjs';
import { loadOrCreatePeerTlsIdentity } from './peer-tls.mjs';
import { createPairRequest, createDiscoveryPairRequest, getTrustedPeerRecord, verifyPeerInvite } from './peer-identity.mjs';
import { createPeerHttpsServer, PEER_API_PREFIX, readPeerInfo, requestPeer } from './peer-transport.mjs';
import { startXatsMdns } from './mdns-discovery.mjs';
import { attachXatsOverlay, detectProvider, providerCommand, whichInPath, resolveOverlayBinary } from './overlay-discovery.mjs';
import { loadPeerConfig, effectiveOverlay } from './peer-config.mjs';
import { PeerFederation } from './peer-federation.mjs';

const CONTROL_PREFIX = '/xats/control/v1';
const DEFAULT_PEER_PORTS = Array.from({ length: 11 }, (_, i) => 9110 + i);
const CONTROL_MAX_BODY = 64 * 1024;

function atomicPrivateWrite(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(filePath), 0o700); } catch { /* best effort */ }
  const temp = `${filePath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch { /* best effort */ }
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

function loadControlToken(filePath) {
  try {
    const token = fs.readFileSync(filePath, 'utf8').trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('invalid_control_token');
    try { fs.chmodSync(filePath, 0o600); } catch { /* best effort */ }
    return token;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const token = randomBytes(32).toString('base64url');
  try {
    const fd = fs.openSync(filePath, 'wx', 0o600);
    fs.writeFileSync(fd, `${token}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    return token;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return loadControlToken(filePath);
  }
}

function endpointForAddress(address, port) {
  const host = address.includes(':') ? `[${address}]` : address;
  return `https://${host}:${port}`;
}

export function getPeerEndpointOptions(port) {
  const result = [];
  for (const [interfaceName, addresses] of Object.entries(os.networkInterfaces())) {
    for (const item of addresses || []) {
      const address = item.address.split('%')[0];
      if (item.internal || !isIP(address) || address.startsWith('fe80:') || address.startsWith('169.254.')) continue;
      result.push({ interface: interfaceName, address, family: item.family, url: endpointForAddress(address, port) });
    }
  }
  return result.sort((a, b) => {
    const aV4 = a.family === 'IPv4' || a.family === 4;
    const bV4 = b.family === 'IPv4' || b.family === 4;
    return Number(bV4) - Number(aV4) || a.interface.localeCompare(b.interface);
  });
}

function readJson(req, maxBytes = CONTROL_MAX_BODY) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(Object.assign(new Error('request_body_too_large'), { statusCode: 413 }));
      req.destroy();
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('request_body_too_large'), { statusCode: 413 }));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(Object.assign(new Error('invalid_json'), { statusCode: 400 })); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function tokenMatches(req, token) {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function peerRecordFromInfo(info, endpoint, label = null) {
  return getTrustedPeerRecord({
    deviceId: info.device_id,
    publicKey: info.public_key,
    tlsCertificate: info.tls_certificate,
    tlsFingerprint: info.tls_fingerprint,
    endpoint,
  }, { label });
}

function encodeInviteBundle(invite, secret) {
  return `xats-pair-v1:${Buffer.from(JSON.stringify({ invite, secret })).toString('base64url')}`;
}

export function decodeInviteBundle(code) {
  if (typeof code !== 'string' || !code.startsWith('xats-pair-v1:')) throw new Error('invalid_invite_code');
  let bundle;
  try { bundle = JSON.parse(Buffer.from(code.slice('xats-pair-v1:'.length), 'base64url').toString('utf8')); }
  catch { throw new Error('invalid_invite_code'); }
  if (!bundle || !verifyPeerInvite(bundle.invite) || typeof bundle.secret !== 'string' || Buffer.from(bundle.secret, 'base64url').length !== 32) {
    throw new Error('invalid_or_expired_invite');
  }
  return bundle;
}

function persistedPeerPort(stateDir, requestedPort) {
  if (Number.isInteger(requestedPort) && requestedPort >= 0 && requestedPort <= 65535) return requestedPort;
  try {
    const value = Number(fs.readFileSync(path.join(stateDir, 'peer-port'), 'utf8').trim());
    if (Number.isInteger(value) && value > 0 && value <= 65535) return value;
  } catch { /* first run */ }
  return null;
}

function resolveDaemonPort(stateDir, requestedPort) {
  if (Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort <= 65535) return requestedPort;
  try {
    const value = Number(fs.readFileSync(path.join(path.dirname(stateDir), 'port'), 'utf8').trim());
    if (Number.isInteger(value) && value > 0 && value <= 65535) return value;
  } catch { /* use the daemon default */ }
  return 9100;
}

async function choosePeerListener({ identity, tlsIdentity, trustStore, pairingManager, federation, host, port }) {
  let lastError;
  const portSet = port === 0 ? [0] : port ? [port] : DEFAULT_PEER_PORTS;
  for (const candidatePort of portSet) {
    const service = createPeerHttpsServer({
      identity,
      tlsIdentity,
      trustStore,
      host,
      port: candidatePort,
      handlers: {
        pairRequest: async (body) => {
          try {
            const result = body?.mode === 'discovery'
              ? pairingManager.submitDiscoveryRequest(body.request)
              : pairingManager.submitRequest(body?.inviteId, body?.request);
            return { statusCode: 202, status: 'pending', pendingId: result.pendingId, mode: result.mode, peer: result.peer };
          } catch (error) {
            const statusCode = /unavailable|expired/.test(error.message) ? 410 : /already_paired|replayed/.test(error.message) ? 409 : 400;
            return { statusCode, error: error.message };
          }
        },
        pairStatus: async (body) => {
          if (typeof body?.pendingId !== 'string' || !/^[a-f0-9]{32}$/.test(body.pendingId)) return { statusCode: 400, error: 'invalid_pending_id' };
          return pairingManager.status(body.pendingId);
        },
        getRoster: () => federation.getPublicRoster(),
        deliverMessage: (body, peer) => federation.deliverMessage(body, peer),
      },
    });
    try {
      const address = await service.listen();
      return { service, address, port: address.port };
    } catch (error) {
      lastError = error;
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  throw lastError || new Error('peer_port_unavailable');
}

export async function pairUsingInvite({ stateDir, code, endpoint = null, label = null, timeoutMs = 5 * 60_000 } = {}) {
  const { invite, secret } = decodeInviteBundle(code);
  const ownIdentity = loadOrCreateDeviceIdentity(path.join(stateDir, 'identity.json'));
  const ownTls = await loadOrCreatePeerTlsIdentity(path.join(stateDir, 'tls-identity.json'), { deviceId: ownIdentity.deviceId });
  const trustStore = new PeerTrustStore(path.join(stateDir, 'peers.json'));
  const localPort = Number(fs.readFileSync(path.join(stateDir, 'peer-port'), 'utf8'));
  const options = getPeerEndpointOptions(localPort);
  const localEndpoint = endpoint || options[0]?.url;
  if (!localEndpoint) throw new Error('no_reachable_local_endpoint; pass --endpoint');
  const peer = getTrustedPeerRecord(invite);
  const request = createPairRequest(invite, secret, ownIdentity, { tlsIdentity: ownTls, endpoint: localEndpoint });
  const submitted = await requestPeer({
    peer,
    identity: ownIdentity,
    url: invite.endpoint,
    method: 'POST',
    path: `${PEER_API_PREFIX}/pair/request`,
    body: { inviteId: invite.inviteId, request },
  });
  if (submitted.status !== 202 || typeof submitted.body.pendingId !== 'string') throw new Error(submitted.body.error || 'pair_request_rejected');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await requestPeer({
      peer,
      identity: ownIdentity,
      url: invite.endpoint,
      method: 'POST',
      path: `${PEER_API_PREFIX}/pair/status`,
      body: { pendingId: submitted.body.pendingId },
    });
    if (result.body.status === 'approved') {
      const peer = { ...invite, endpoint: invite.endpoint, pairedAt: Date.now(), label };
      try {
        await callPeerControl({ stateDir, method: 'POST', endpoint: '/trust', body: { peer } });
      } catch (error) {
        if (error.code !== 'ECONNREFUSED') throw error;
        trustStore.trust(peer);
      }
      return { status: 'paired', deviceId: invite.deviceId, endpoint: invite.endpoint };
    }
    if (result.body.status === 'denied') throw new Error('pairing_denied_by_peer');
    if (result.body.status === 'not_found') throw new Error('pairing_request_expired_or_unknown');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('pairing_approval_timeout');
}

async function pairDiscovered({ candidates, trustStore, identity, tlsIdentity, endpoint, deviceId, label }) {
  const matchingCandidates = candidates.filter((item) => item.deviceId === deviceId);
  if (!matchingCandidates.length) throw new Error('candidate_not_found');
  let remoteEndpoint = null;
  let remotePeer = null;
  let lastError = null;
  for (const candidate of matchingCandidates) {
    const candidateEndpoint = endpointForAddress(candidate.endpoint.host, candidate.endpoint.port);
    try {
      const info = await readPeerInfo(candidateEndpoint, { expectedDeviceId: deviceId });
      remotePeer = peerRecordFromInfo(info, candidateEndpoint);
      remoteEndpoint = candidateEndpoint;
      break;
    } catch (error) { lastError = error; }
  }
  if (!remotePeer || !remoteEndpoint) throw lastError || new Error('candidate_not_reachable');
  const localEndpoint = endpoint;
  if (!localEndpoint) throw new Error('no_reachable_local_endpoint');
  const request = createDiscoveryPairRequest(identity, { tlsIdentity, endpoint: localEndpoint });
  const submitted = await requestPeer({
    peer: remotePeer,
    identity,
    url: remoteEndpoint,
    method: 'POST',
    path: `${PEER_API_PREFIX}/pair/request`,
    body: { mode: 'discovery', request },
  });
  if (submitted.status !== 202 || typeof submitted.body.pendingId !== 'string') throw new Error(submitted.body.error || 'pair_request_rejected');
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const result = await requestPeer({
      peer: remotePeer,
      identity,
      url: remoteEndpoint,
      method: 'POST',
      path: `${PEER_API_PREFIX}/pair/status`,
      body: { pendingId: submitted.body.pendingId },
    });
    if (result.body.status === 'approved') {
      trustStore.trust({ ...remotePeer, label });
      return { status: 'paired', deviceId, endpoint: remoteEndpoint };
    }
    if (result.body.status === 'denied') throw new Error('pairing_denied_by_peer');
    if (result.body.status === 'not_found') throw new Error('pairing_request_expired_or_unknown');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('pairing_approval_timeout');
}

function createControlServer({ token, pairingManager, trustStore, identity, federation, getRuntimeStatus, pairCandidate }) {
  return http.createServer(async (req, res) => {
    try {
      if (req.socket.remoteAddress !== '127.0.0.1' && req.socket.remoteAddress !== '::ffff:127.0.0.1' && req.socket.remoteAddress !== '::1') return sendJson(res, 403, { error: 'loopback_only' });
      if (!tokenMatches(req, token)) return sendJson(res, 401, { error: 'control_auth_required' });
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.search || url.hash || !url.pathname.startsWith(`${CONTROL_PREFIX}/`)) return sendJson(res, 404, { error: 'not_found' });
      if (req.method === 'GET' && url.pathname === `${CONTROL_PREFIX}/status`) return sendJson(res, 200, getRuntimeStatus());
      if (req.method === 'GET' && url.pathname === `${CONTROL_PREFIX}/candidates`) return sendJson(res, 200, { candidates: getRuntimeStatus().candidates });
      if (req.method === 'GET' && url.pathname === `${CONTROL_PREFIX}/pending`) return sendJson(res, 200, { pending: pairingManager.listPending() });
      if (req.method === 'GET' && url.pathname === `${CONTROL_PREFIX}/peers`) return sendJson(res, 200, { peers: trustStore.list().map(({ tlsCertificate, ...peer }) => peer) });
      const body = req.method === 'POST' ? await readJson(req) : {};
      if (req.method === 'POST' && url.pathname === `${CONTROL_PREFIX}/invite`) {
        if (typeof body.endpoint !== 'string') return sendJson(res, 400, { error: 'endpoint_required' });
        const created = pairingManager.createInvite({ ttlMs: body.ttlMs, endpoint: body.endpoint });
        return sendJson(res, 200, { code: encodeInviteBundle(created.invite, created.secret), expiresAt: created.invite.expiresAt });
      }
      if (req.method === 'POST' && url.pathname === `${CONTROL_PREFIX}/approve`) {
        const peer = pairingManager.approve(body.pendingId, { label: body.label || null });
        const { tlsCertificate, ...safePeer } = peer;
        return sendJson(res, 200, { ok: true, peer: safePeer });
      }
      if (req.method === 'POST' && url.pathname === `${CONTROL_PREFIX}/trust`) {
        const peer = trustStore.trust(body.peer);
        const { tlsCertificate, ...safePeer } = peer;
        return sendJson(res, 200, { ok: true, peer: safePeer });
      }
      if (req.method === 'POST' && url.pathname === `${CONTROL_PREFIX}/deny`) return sendJson(res, pairingManager.deny(body.pendingId) ? 200 : 404, { ok: pairingManager.status(body.pendingId).status === 'denied' });
      if (req.method === 'POST' && url.pathname === `${CONTROL_PREFIX}/revoke`) {
        const revoked = trustStore.revoke(body.deviceId);
        if (revoked) await federation.forgetPeer(body.deviceId);
        return sendJson(res, revoked ? 200 : 404, { ok: revoked });
      }
      if (req.method === 'POST' && url.pathname === `${CONTROL_PREFIX}/pair`) {
        const result = await pairCandidate(body);
        return sendJson(res, 200, result);
      }
      if (req.method === 'POST' && url.pathname === `${CONTROL_PREFIX}/exit`) {
        sendJson(res, 200, { ok: true });
        process.nextTick(() => process.emit('SIGTERM'));
        return;
      }
      return sendJson(res, 404, { error: 'not_found' });
    } catch (error) {
      if (!res.headersSent) sendJson(res, Number(error?.statusCode) || 400, { error: error.message || 'peer_control_error' });
      else res.destroy();
    }
  });
}

export async function startPeerRuntime({
  stateDir,
  host = '::',
  port = null,
  controlHost = '127.0.0.1',
  controlPort = 0,
  mdns = true,
  mdnsStarter = startXatsMdns,
  federationEnabled = true,
  daemonPort = null,
  daemonToken = process.env.CROSS_AGENT_TEAMS_MCP_TOKEN,
  onLog = (message) => console.log(`[xats-peer] ${message}`),
} = {}) {
  if (!stateDir) throw new TypeError('peer_state_dir_required');
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(stateDir, 0o700); } catch { /* best effort */ }
  const identity = loadOrCreateDeviceIdentity(path.join(stateDir, 'identity.json'));
  const tlsIdentity = await loadOrCreatePeerTlsIdentity(path.join(stateDir, 'tls-identity.json'), { deviceId: identity.deviceId });
  const trustStore = new PeerTrustStore(path.join(stateDir, 'peers.json'));
  const pairingManager = new PeerPairingManager({ identity, tlsIdentity, trustStore });
  const actualDaemonPort = resolveDaemonPort(stateDir, daemonPort);
  const federation = new PeerFederation({ identity, trustStore, stateDir, daemonPort: actualDaemonPort, daemonToken, onLog });
  const requestedPeerPort = persistedPeerPort(stateDir, port);
  const listener = await choosePeerListener({ identity, tlsIdentity, trustStore, pairingManager, federation, host, port: requestedPeerPort });
  atomicPrivateWrite(path.join(stateDir, 'peer-port'), `${listener.port}\n`);
  const candidates = new Map();
  let discovery = null;
  let meshDiscovery = null;
  let discoveryError = null;
  const acceptCandidate = (candidate, source) => {
    const key = `${candidate.deviceId}|${candidate.endpoint.host}|${candidate.endpoint.port}`;
    candidates.set(key, { ...candidate, source });
    onLog(`discovered ${source} candidate ${candidate.deviceId} at ${candidate.endpoint.host}:${candidate.endpoint.port}`);
  };
  const dropCandidate = (candidate) => candidates.delete(`${candidate.deviceId}|${candidate.endpoint.host}|${candidate.endpoint.port}`);

  // Overlay discovery, opt-in: any overlay (tunlion, tailscale, netbird, or a
  // static host list) replaces mDNS across the network. The overlay only says
  // who exists and what to dial; candidates still need explicit approval.
  const peerConfig = loadPeerConfig(stateDir);
  const overlayChoice = effectiveOverlay(process.env, peerConfig);
  if (overlayChoice !== 'off') {
    try {
      // The saved setting (or an env override) picks the provider; `auto` keeps
      // the old behaviour of taking the first overlay CLI found.
      const provider = overlayChoice && overlayChoice !== 'auto'
        ? overlayChoice
        : detectProvider({ which: (cmd) => whichInPath(cmd, process.env), env: process.env });
      if (!provider) {
        onLog('overlay discovery: no overlay CLI found (set XATS_OVERLAY or XATS_OVERLAY_PEERS)');
      } else {
        const { execFile } = await import('node:child_process');
        const command = providerCommand(provider);
        meshDiscovery = attachXatsOverlay({
          provider,
          port: listener.port,
          runCommand: async ([cmd, args]) => new Promise((resolve, reject) => {
            // Service managers give us a minimal PATH; find the overlay CLI anyway.
            const binary = resolveOverlayBinary(cmd, process.env) || cmd;
            execFile(binary, args, { timeout: 10_000 }, (error, stdout) => {
              if (error) reject(error);
              else resolve(String(stdout));
            });
          }),
          onCandidate: (candidate) => acceptCandidate(candidate, provider),
          onLost: dropCandidate,
          onError: (error) => onLog(`overlay discovery (${provider}): ${error?.message || String(error)}`),
        });
        onLog(`overlay discovery active via ${provider} on :${listener.port}${command ? '' : ' (static list)'}`);
      }
    } catch (error) {
      onLog(`overlay discovery unavailable; invite pairing still works (${error.message})`);
    }
  }

  if (mdns) {
    try {
      discovery = await mdnsStarter({
        deviceId: identity.deviceId,
        port: listener.port,
        onCandidate: (candidate) => acceptCandidate(candidate, 'mdns'),
        onLost: dropCandidate,
        onError: (error) => {
          discoveryError = error?.message || String(error);
          onLog(`mDNS unavailable: ${discoveryError}`);
        },
      });
      onLog(`mDNS peer discovery active on :${listener.port}`);
    } catch (error) {
      onLog(`mDNS unavailable; invite pairing still works (${error.message})`);
    }
  }

  const token = loadControlToken(path.join(stateDir, 'control-token'));
  const pairCandidate = async ({ deviceId, label = null, endpoint = null } = {}) => {
    if (typeof deviceId !== 'string' || !/^[a-f0-9]{32}$/.test(deviceId)) throw new Error('device_id_required');
    const currentCandidates = [...candidates.values()];
    const localEndpoints = getPeerEndpointOptions(listener.port);
    return pairDiscovered({
      candidates: currentCandidates,
      trustStore,
      identity,
      tlsIdentity,
      endpoint: endpoint || localEndpoints[0]?.url,
      deviceId,
      label,
    });
  };
  const getRuntimeStatus = () => ({
    ok: true,
    deviceId: identity.deviceId,
    peerPort: listener.port,
    controlPort: null,
    endpoints: getPeerEndpointOptions(listener.port),
    mdns: Boolean(discovery) && !discoveryError,
    mdnsError: discoveryError,
    candidates: [...candidates.values()],
    pending: pairingManager.listPending(),
    peers: trustStore.list().map(({ tlsCertificate, ...peer }) => peer),
    daemonPort: actualDaemonPort,
    federation: federation.status(),
  });
  const controlServer = createControlServer({ token, pairingManager, trustStore, identity, federation, getRuntimeStatus, pairCandidate });
  await new Promise((resolve, reject) => {
    controlServer.once('error', reject);
    controlServer.listen(controlPort, controlHost, resolve);
  });
  const actualControlPort = controlServer.address().port;
  atomicPrivateWrite(path.join(stateDir, 'control-port'), `${actualControlPort}\n`);
  onLog(`secure peer listener on [${host}]:${listener.port}; local control at 127.0.0.1:${actualControlPort}`);
  if (federationEnabled) federation.start();

  let closed = false;
  return {
    identity,
    tlsIdentity,
    trustStore,
    pairingManager,
    peerPort: listener.port,
    controlPort: actualControlPort,
    controlToken: token,
    candidates,
    federation,
    status: getRuntimeStatus,
    close: async () => {
      if (closed) return;
      closed = true;
      if (discovery) await discovery.close();
      if (meshDiscovery) meshDiscovery.stop();
      await federation.close();
      await new Promise((resolve) => controlServer.close(() => resolve()));
      await listener.service.close();
      const controlPortPath = path.join(stateDir, 'control-port');
      try {
        if (Number(fs.readFileSync(controlPortPath, 'utf8').trim()) === actualControlPort) fs.rmSync(controlPortPath, { force: true });
      } catch { /* stale or already removed */ }
    },
  };
}

export async function callPeerControl({ stateDir, method = 'GET', endpoint, body = null } = {}) {
  const port = Number(fs.readFileSync(path.join(stateDir, 'control-port'), 'utf8').trim());
  const token = fs.readFileSync(path.join(stateDir, 'control-token'), 'utf8').trim();
  const raw = body == null ? null : Buffer.from(JSON.stringify(body));
  const url = `http://127.0.0.1:${port}${CONTROL_PREFIX}${endpoint}`;
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(raw ? { 'content-type': 'application/json', 'content-length': raw.length } : {}),
      },
      timeout: 15 * 60_000,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode >= 400) reject(new Error(data.error || `peer_control_http_${res.statusCode}`));
          else resolve(data);
        } catch (error) { reject(error); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('peer_control_timeout')));
    req.on('error', reject);
    if (raw) req.write(raw);
    req.end();
  });
}

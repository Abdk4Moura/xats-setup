import https from 'node:https';
import { createHash, createPublicKey, randomBytes, sign, verify, X509Certificate } from 'node:crypto';
import { validateDeviceIdentity } from './peer-identity.mjs';
import { peerTlsServerOptions, validatePeerTlsIdentity } from './peer-tls.mjs';

export const PEER_API_PREFIX = '/xats/peer/v1';
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_CLOCK_SKEW_MS = 2 * 60 * 1000;
const NONCE_TTL_MS = 5 * 60 * 1000;
const NONCE_LIMIT = 20_000;
const NONCE_RE = /^[a-f0-9]{32}$/;
const DEVICE_ID_RE = /^[a-f0-9]{32}$/;

function stableJson(value) {
  return JSON.stringify(value);
}

function idForPublicKey(pem) {
  const der = createPublicKey(pem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex').slice(0, 32);
}

function bodyHash(body) {
  return createHash('sha256').update(body).digest('hex');
}

function rawCertificateFingerprint(raw) {
  return createHash('sha256').update(raw).digest('hex');
}

function requestSigningBytes({ deviceId, method, path, timestamp, nonce, hash }) {
  return Buffer.from(stableJson({
    version: 1,
    deviceId,
    method: method.toUpperCase(),
    path,
    timestamp,
    nonce,
    bodyHash: hash,
  }));
}

export function createPeerAuthHeaders(identity, { method, path, body = '', timestamp = Date.now(), nonce } = {}) {
  validateDeviceIdentity(identity);
  if (typeof method !== 'string' || typeof path !== 'string' || !path.startsWith(`${PEER_API_PREFIX}/`)) throw new Error('invalid_peer_request_target');
  if (!Number.isSafeInteger(timestamp)) throw new Error('invalid_peer_request_timestamp');
  nonce ??= randomBytes(16).toString('hex');
  if (!NONCE_RE.test(nonce)) throw new Error('invalid_peer_request_nonce');
  const rawBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const bytes = requestSigningBytes({ deviceId: identity.deviceId, method, path, timestamp, nonce, hash: bodyHash(rawBody) });
  return {
    'x-xats-device-id': identity.deviceId,
    'x-xats-timestamp': String(timestamp),
    'x-xats-nonce': nonce,
    'x-xats-signature': sign(null, bytes, identity.privateKey).toString('base64url'),
  };
}

function verifyPeerRequest(req, body, trustStore, replay, now) {
  const deviceId = req.headers['x-xats-device-id'];
  const rawTimestamp = req.headers['x-xats-timestamp'];
  const nonce = req.headers['x-xats-nonce'];
  const signature = req.headers['x-xats-signature'];
  if (typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId) || typeof rawTimestamp !== 'string' || !/^\d{13}$/.test(rawTimestamp) || typeof nonce !== 'string' || !NONCE_RE.test(nonce) || typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature)) {
    return { ok: false, status: 401, error: 'peer_auth_required' };
  }
  const timestamp = Number(rawTimestamp);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > MAX_CLOCK_SKEW_MS) return { ok: false, status: 401, error: 'peer_request_expired' };
  const peer = trustStore.get(deviceId);
  if (!peer || idForPublicKey(peer.publicKey) !== deviceId) return { ok: false, status: 403, error: 'peer_not_trusted' };
  const path = req.url;
  if (typeof path !== 'string' || !path.startsWith(`${PEER_API_PREFIX}/`) || path.includes('#')) return { ok: false, status: 400, error: 'invalid_peer_request_target' };
  const bytes = requestSigningBytes({ deviceId, method: req.method || '', path, timestamp, nonce, hash: bodyHash(body) });
  let signatureBytes;
  try { signatureBytes = Buffer.from(signature, 'base64url'); } catch { return { ok: false, status: 401, error: 'invalid_peer_signature' }; }
  if (!verify(null, bytes, peer.publicKey, signatureBytes)) return { ok: false, status: 401, error: 'invalid_peer_signature' };
  const replayKey = `${deviceId}:${nonce}`;
  replay.prune(now);
  if (replay.entries.has(replayKey)) return { ok: false, status: 409, error: 'peer_request_replayed' };
  if (replay.entries.size >= NONCE_LIMIT) return { ok: false, status: 429, error: 'peer_replay_cache_full' };
  replay.entries.set(replayKey, now + NONCE_TTL_MS);
  return { ok: true, peer };
}

function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (Number.isFinite(declared) && declared > limit) {
      reject(Object.assign(new Error('request_body_too_large'), { statusCode: 413 }));
      req.destroy();
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('request_body_too_large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks);
        resolve({ raw, value: raw.length ? JSON.parse(raw.toString('utf8')) : {} });
      } catch {
        reject(Object.assign(new Error('invalid_json'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function readResponse(res, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    res.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('peer_response_too_large'));
        res.destroy();
      } else chunks.push(chunk);
    });
    res.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve({ status: res.statusCode || 0, body: raw ? JSON.parse(raw) : {} }); }
      catch { reject(new Error('invalid_peer_response')); }
    });
    res.on('error', reject);
  });
}

export function createPeerHttpsServer({
  identity,
  tlsIdentity,
  trustStore,
  handlers = {},
  host = '::',
  port = 0,
  now = () => Date.now(),
  maxBodyBytes = MAX_BODY_BYTES,
  pairRateLimit = 12,
  pairRateWindowMs = 60_000,
} = {}) {
  validateDeviceIdentity(identity);
  validatePeerTlsIdentity(tlsIdentity);
  if (!trustStore || typeof trustStore.get !== 'function') throw new TypeError('peer_trust_store_required');
  const replay = {
    entries: new Map(),
    prune(at) {
      for (const [key, expires] of this.entries) if (expires <= at) this.entries.delete(key);
    },
  };
  const pairAttempts = new Map();

  const server = https.createServer(peerTlsServerOptions(tlsIdentity), async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'https://xats.invalid');
      if (url.hash || url.search) return sendJson(res, 400, { error: 'query_not_supported' });
      if (req.method === 'GET' && url.pathname === `${PEER_API_PREFIX}/info`) {
        const info = {
          version: 1,
          device_id: identity.deviceId,
          public_key: identity.publicKey,
          tls_fingerprint: tlsIdentity.fingerprint,
          tls_certificate: tlsIdentity.certificate,
        };
        info.signature = sign(null, Buffer.from(stableJson(info)), identity.privateKey).toString('base64url');
        return sendJson(res, 200, info);
      }
      const { raw, value } = await readJsonBody(req, maxBodyBytes);
      if (req.method === 'POST' && url.pathname === `${PEER_API_PREFIX}/pair/status`) {
        if (typeof handlers.pairStatus !== 'function') return sendJson(res, 503, { error: 'pairing_unavailable' });
        const result = await handlers.pairStatus(value);
        return sendJson(res, result?.statusCode || 200, result || { status: 'not_found' });
      }
      if (req.method === 'POST' && url.pathname === `${PEER_API_PREFIX}/pair/request`) {
        const remote = req.socket.remoteAddress || 'unknown';
        const t = now();
        for (const [ip, seen] of pairAttempts) if (seen.started + pairRateWindowMs <= t) pairAttempts.delete(ip);
        if (!pairAttempts.has(remote) && pairAttempts.size >= 4096) return sendJson(res, 429, { error: 'pair_rate_limited' });
        let bucket = pairAttempts.get(remote);
        if (!bucket || bucket.started + pairRateWindowMs <= t) bucket = { started: t, count: 0 };
        bucket.count++;
        pairAttempts.set(remote, bucket);
        if (bucket.count > pairRateLimit) return sendJson(res, 429, { error: 'pair_rate_limited' });
        if (typeof handlers.pairRequest !== 'function') return sendJson(res, 503, { error: 'pairing_unavailable' });
        const result = await handlers.pairRequest(value, { remoteAddress: remote, now: t });
        return sendJson(res, result?.statusCode || 202, result || { ok: true, status: 'pending' });
      }
      const auth = verifyPeerRequest(req, raw, trustStore, replay, now());
      if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
      if (req.method === 'GET' && url.pathname === `${PEER_API_PREFIX}/agents/roster`) {
        if (typeof handlers.getRoster !== 'function') return sendJson(res, 503, { error: 'roster_unavailable' });
        return sendJson(res, 200, await handlers.getRoster(auth.peer));
      }
      if (req.method === 'POST' && url.pathname === `${PEER_API_PREFIX}/messages/deliver`) {
        if (typeof handlers.deliverMessage !== 'function') return sendJson(res, 503, { error: 'message_relay_unavailable' });
        return sendJson(res, 200, await handlers.deliverMessage(value, auth.peer));
      }
      return sendJson(res, 404, { error: 'not_found' });
    } catch (error) {
      if (!res.headersSent) sendJson(res, Number(error?.statusCode) || 500, { error: error?.statusCode ? error.message : 'peer_internal_error' });
      else res.destroy();
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.maxHeadersCount = 40;
  server.on('clientError', (_error, socket) => socket.destroy());

  return {
    server,
    listen: () => new Promise((resolve, reject) => {
      const onError = (error) => { server.removeListener('listening', onListening); reject(error); };
      const onListening = () => { server.removeListener('error', onError); resolve(server.address()); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    }),
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function peerInfoFields(info) {
  return {
    version: info.version,
    device_id: info.device_id,
    public_key: info.public_key,
    tls_fingerprint: info.tls_fingerprint,
    tls_certificate: info.tls_certificate,
  };
}

export function verifyPeerInfo(info, { expectedDeviceId = null } = {}) {
  try {
    if (!info || info.version !== 1 || typeof info.device_id !== 'string' || !DEVICE_ID_RE.test(info.device_id)) return false;
    if (idForPublicKey(info.public_key) !== info.device_id || (expectedDeviceId && expectedDeviceId !== info.device_id)) return false;
    const certificate = new X509Certificate(info.tls_certificate);
    if (certificate.fingerprint256.replaceAll(':', '').toLowerCase() !== info.tls_fingerprint) return false;
    if (typeof info.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(info.signature)) return false;
    return verify(null, Buffer.from(stableJson(peerInfoFields(info))), info.public_key, Buffer.from(info.signature, 'base64url'));
  } catch {
    return false;
  }
}

// Fetches only public identity metadata from an as-yet-untrusted candidate. The
// response's Ed25519 signature binds its claimed id to the TLS certificate. No
// credentials or agent data are sent over this first-contact request.
export function readPeerInfo(url, { expectedDeviceId = null, timeoutMs = 5000 } = {}) {
  const target = new URL(url);
  if (target.protocol !== 'https:') throw new Error('peer_info_requires_https');
  return new Promise((resolve, reject) => {
    const req = https.get(target, {
      path: `${PEER_API_PREFIX}/info`,
      rejectUnauthorized: false,
      timeout: timeoutMs,
    }, async (res) => {
      try {
        const liveCert = res.socket?.getPeerCertificate?.().raw;
        const result = await readResponse(res, 16 * 1024);
        if (result.status !== 200 || !verifyPeerInfo(result.body, { expectedDeviceId })) throw new Error('unverified_peer_info');
        if (!liveCert || rawCertificateFingerprint(liveCert) !== result.body.tls_fingerprint) throw new Error('peer_info_tls_certificate_mismatch');
        resolve(result.body);
      } catch (error) { reject(error); }
    });
    req.once('timeout', () => req.destroy(new Error('peer_info_timeout')));
    req.once('error', reject);
  });
}

function verifyPinnedCertificate(peer, certificate) {
  if (!peer || typeof peer.tlsCertificate !== 'string' || typeof peer.tlsFingerprint !== 'string') throw new Error('peer_tls_pin_missing');
  const actual = new X509Certificate(certificate.raw).fingerprint256.replaceAll(':', '').toLowerCase();
  if (actual !== peer.tlsFingerprint) return new Error('peer_tls_pin_mismatch');
  return undefined;
}

export function requestPeer({ peer, identity, url = peer?.endpoint, method = 'GET', path, body = null, timeoutMs = 10_000, now = Date.now(), nonce } = {}) {
  validateDeviceIdentity(identity);
  const target = new URL(url);
  if (target.protocol !== 'https:' || !target.hostname || !target.port || target.username || target.password || target.search || target.hash || target.pathname !== '/' || (path && (path.startsWith('//') || !path.startsWith(`${PEER_API_PREFIX}/`)))) throw new Error('invalid_peer_url');
  const requestPath = path || `${PEER_API_PREFIX}/info`;
  const raw = body == null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const headers = createPeerAuthHeaders(identity, { method, path: requestPath, body: raw, timestamp: now, nonce });
  if (raw.length) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = raw.length;
  }
  return new Promise((resolve, reject) => {
    const req = https.request(target, {
      method,
      path: requestPath,
      headers,
      ca: peer?.tlsCertificate,
      rejectUnauthorized: true,
      checkServerIdentity: (_hostname, cert) => verifyPinnedCertificate(peer, cert),
      timeout: timeoutMs,
    }, async (res) => {
      try { resolve(await readResponse(res, MAX_RESPONSE_BYTES)); }
      catch (error) { reject(error); }
    });
    req.once('timeout', () => req.destroy(new Error('peer_request_timeout')));
    req.once('error', reject);
    if (raw.length) req.write(raw);
    req.end();
  });
}

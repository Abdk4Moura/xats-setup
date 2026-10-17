import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  X509Certificate,
  generateKeyPairSync,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
} from 'node:crypto';

const INVITE_VERSION = 1;
const MAX_INVITE_TTL_MS = 10 * 60 * 1000;
const ID_RE = /^[a-f0-9]{32}$/;

function canonical(value) {
  return JSON.stringify(value);
}

function publicId(publicKey) {
  const der = Buffer.isBuffer(publicKey)
    ? publicKey
    : createPublicKey(publicKey).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex').slice(0, 32);
}

function inviteFields(invite) {
  return {
    version: invite.version,
    inviteId: invite.inviteId,
    issuedAt: invite.issuedAt,
    expiresAt: invite.expiresAt,
    deviceId: invite.deviceId,
    publicKey: invite.publicKey,
    endpoint: invite.endpoint,
    tlsFingerprint: invite.tlsFingerprint,
    tlsCertificate: invite.tlsCertificate,
  };
}

function requestFields(request) {
  return {
    version: request.version,
    inviteId: request.inviteId,
    nonce: request.nonce,
    deviceId: request.deviceId,
    publicKey: request.publicKey,
    tlsFingerprint: request.tlsFingerprint,
    tlsCertificate: request.tlsCertificate,
    endpoint: request.endpoint,
  };
}

function decodeBase64Url(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`invalid_${label}`);
  }
  return Buffer.from(value, 'base64url');
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function certificateFingerprint(certificate) {
  return new X509Certificate(certificate).fingerprint256.replaceAll(':', '').toLowerCase();
}

function validateEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > 512) return false;
  try {
    const url = new URL(endpoint);
    const port = Number(url.port);
    return url.protocol === 'https:' && Boolean(url.hostname) && Number.isInteger(port) && port > 0 && port <= 65535 && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function validTlsBinding(certificate, fingerprint) {
  if (typeof certificate !== 'string' || typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) return false;
  try {
    const x509 = new X509Certificate(certificate);
    const now = Date.now();
    return x509.fingerprint256.replaceAll(':', '').toLowerCase() === fingerprint &&
      Date.parse(x509.validFrom) <= now && Date.parse(x509.validTo) > now && x509.verify(x509.publicKey);
  } catch { return false; }
}

export function createDeviceIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return { version: 1, deviceId: publicId(publicKey.export({ type: 'spki', format: 'der' })), publicKey: publicPem, privateKey: privatePem };
}

export function validateDeviceIdentity(identity) {
  if (!identity || identity.version !== 1 || typeof identity.publicKey !== 'string' || typeof identity.privateKey !== 'string') {
    throw new Error('invalid_device_identity');
  }
  try {
    const publicKey = createPublicKey(identity.publicKey);
    const privateKey = createPrivateKey(identity.privateKey);
    const publicDer = publicKey.export({ type: 'spki', format: 'der' });
    if (!ID_RE.test(identity.deviceId) || publicId(publicDer) !== identity.deviceId) throw new Error('invalid_device_identity');
    // Prove that both keys belong together without exposing private key material.
    const challenge = randomBytes(32);
    const signature = sign(null, challenge, privateKey);
    if (!verify(null, challenge, publicKey, signature)) throw new Error('invalid_device_identity');
  } catch {
    throw new Error('invalid_device_identity');
  }
  return identity;
}

// Creates a signed, short-lived invitation. The secret is returned separately and must
// be transferred privately (for example, a QR code or copyable invite string).
export function createPeerInvite(identity, { endpoint, tlsIdentity, now = Date.now(), ttlMs = 5 * 60 * 1000 } = {}) {
  validateDeviceIdentity(identity);
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > MAX_INVITE_TTL_MS) {
    throw new Error('invalid_invite_lifetime');
  }
  if (!validateEndpoint(endpoint) || !validTlsBinding(tlsIdentity?.certificate, tlsIdentity?.fingerprint)) throw new Error('invalid_invite_endpoint_or_tls');
  const invite = {
    version: INVITE_VERSION,
    inviteId: randomBytes(16).toString('hex'),
    issuedAt: now,
    expiresAt: now + ttlMs,
    deviceId: identity.deviceId,
    publicKey: identity.publicKey,
    endpoint,
    tlsFingerprint: tlsIdentity.fingerprint,
    tlsCertificate: tlsIdentity.certificate,
  };
  invite.signature = sign(null, Buffer.from(canonical(inviteFields(invite))), identity.privateKey).toString('base64url');
  return { invite, secret: randomBytes(32).toString('base64url') };
}

export function verifyPeerInvite(invite, { now = Date.now() } = {}) {
  try {
    if (!invite || invite.version !== INVITE_VERSION || typeof invite.inviteId !== 'string' || !/^[a-f0-9]{32}$/.test(invite.inviteId)) return false;
    if (!Number.isSafeInteger(invite.issuedAt) || !Number.isSafeInteger(invite.expiresAt) || !Number.isSafeInteger(now)) return false;
    if (invite.expiresAt <= now || invite.issuedAt > now + 30_000 || invite.expiresAt - invite.issuedAt > MAX_INVITE_TTL_MS) return false;
    if (typeof invite.publicKey !== 'string' || publicId(publicDer(invite.publicKey)) !== invite.deviceId) return false;
    if (!validateEndpoint(invite.endpoint) || !validTlsBinding(invite.tlsCertificate, invite.tlsFingerprint)) return false;
    const signature = decodeBase64Url(invite.signature, 'invite_signature');
    return verify(null, Buffer.from(canonical(inviteFields(invite))), invite.publicKey, signature);
  } catch {
    return false;
  }
}

function publicDer(publicKey) {
  return createPublicKey(publicKey).export({ type: 'spki', format: 'der' });
}

export function createPairRequest(invite, secret, identity, { tlsIdentity, endpoint, nonce = randomBytes(16).toString('hex'), now = Date.now() } = {}) {
  validateDeviceIdentity(identity);
  if (!verifyPeerInvite(invite, { now })) throw new Error('invalid_or_expired_invite');
  if (!validTlsBinding(tlsIdentity?.certificate, tlsIdentity?.fingerprint)) throw new Error('invalid_pair_request_tls');
  if (!validateEndpoint(endpoint)) throw new Error('invalid_pair_request_endpoint');
  const secretBytes = decodeBase64Url(secret, 'invite_secret');
  if (secretBytes.length !== 32 || !/^[a-f0-9]{32}$/.test(nonce)) throw new Error('invalid_pair_request');
  const request = {
    version: INVITE_VERSION,
    inviteId: invite.inviteId,
    nonce,
    deviceId: identity.deviceId,
    publicKey: identity.publicKey,
    tlsFingerprint: tlsIdentity.fingerprint,
    tlsCertificate: tlsIdentity.certificate,
    endpoint,
  };
  const signed = Buffer.from(canonical(requestFields(request)));
  request.signature = sign(null, signed, identity.privateKey).toString('base64url');
  request.proof = createHmac('sha256', secretBytes).update(signed).digest('base64url');
  return request;
}

// Verifies both possession of the one-time invite secret and possession of the
// requester's private identity key. Caller must still ask the user to approve and
// atomically consume the invite; validity alone never means trusted.
export function verifyPairRequest(invite, secret, request, { now = Date.now() } = {}) {
  try {
    if (!verifyPeerInvite(invite, { now }) || request?.version !== INVITE_VERSION || request.inviteId !== invite.inviteId) return false;
    if (typeof request.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(request.nonce)) return false;
    if (typeof request.publicKey !== 'string' || publicId(publicDer(request.publicKey)) !== request.deviceId) return false;
    if (!validTlsBinding(request.tlsCertificate, request.tlsFingerprint) || !validateEndpoint(request.endpoint)) return false;
    const fields = Buffer.from(canonical(requestFields(request)));
    const secretBytes = decodeBase64Url(secret, 'invite_secret');
    if (secretBytes.length !== 32) return false;
    const expectedProof = createHmac('sha256', secretBytes).update(fields).digest();
    const suppliedProof = decodeBase64Url(request.proof, 'pair_proof');
    if (!safeEqual(expectedProof, suppliedProof)) return false;
    const signature = decodeBase64Url(request.signature, 'pair_signature');
    return verify(null, fields, request.publicKey, signature);
  } catch {
    return false;
  }
}

export function getTrustedPeerRecord(request, { pairedAt = Date.now(), label = null } = {}) {
  if (!request || !ID_RE.test(request.deviceId) || typeof request.publicKey !== 'string' || publicId(publicDer(request.publicKey)) !== request.deviceId || !validTlsBinding(request.tlsCertificate, request.tlsFingerprint)) {
    throw new Error('invalid_peer_record');
  }
  if (!Number.isSafeInteger(pairedAt) || pairedAt < 0 || (label !== null && (typeof label !== 'string' || label.length > 80))) throw new Error('invalid_peer_record');
  return { version: 1, deviceId: request.deviceId, publicKey: request.publicKey, tlsCertificate: request.tlsCertificate, tlsFingerprint: request.tlsFingerprint, endpoint: request.endpoint, label, pairedAt };
}

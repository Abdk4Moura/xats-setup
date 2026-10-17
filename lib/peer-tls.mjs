import fs from 'node:fs';
import path from 'node:path';
import { createHash, createPrivateKey, createPublicKey, timingSafeEqual, X509Certificate, randomBytes } from 'node:crypto';

function fingerprintFor(certPem) {
  const x509 = new X509Certificate(certPem);
  return x509.fingerprint256.replaceAll(':', '').toLowerCase();
}

function keyMatchesCertificate(privatePem, certPem) {
  const privateKey = createPrivateKey(privatePem);
  const privatePublic = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const certificatePublic = new X509Certificate(certPem).publicKey.export({ type: 'spki', format: 'der' });
  return privatePublic.length === certificatePublic.length && timingSafeEqual(privatePublic, certificatePublic);
}

export function validatePeerTlsIdentity(identity) {
  if (!identity || identity.version !== 1 || typeof identity.certificate !== 'string' || typeof identity.privateKey !== 'string') {
    throw new Error('invalid_peer_tls_identity');
  }
  try {
    if (!keyMatchesCertificate(identity.privateKey, identity.certificate)) throw new Error('tls_key_mismatch');
    const x509 = new X509Certificate(identity.certificate);
    const now = Date.now();
    if (Date.parse(x509.validFrom) > now || Date.parse(x509.validTo) <= now) throw new Error('tls_certificate_expired');
    if (!x509.verify(x509.publicKey)) throw new Error('tls_certificate_signature_invalid');
    const fingerprint = fingerprintFor(identity.certificate);
    if (identity.fingerprint !== fingerprint) throw new Error('tls_fingerprint_mismatch');
    return identity;
  } catch {
    throw new Error('invalid_peer_tls_identity');
  }
}

function writePrivateJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(filePath), 0o700); } catch { /* best effort on Windows */ }
  const temp = `${filePath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.linkSync(temp, filePath);
    fs.unlinkSync(temp);
    try { fs.chmodSync(filePath, 0o600); } catch { /* best effort on Windows */ }
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

export async function loadOrCreatePeerTlsIdentity(filePath, { deviceId, generate = null } = {}) {
  if (!/^[a-f0-9]{32}$/.test(deviceId || '')) throw new Error('invalid_device_id');
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(filePath), 0o700); } catch { /* best effort on Windows */ }
  try {
    const stored = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    validatePeerTlsIdentity(stored);
    try { fs.chmodSync(filePath, 0o600); } catch { /* best effort on Windows */ }
    return stored;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`invalid_or_unreadable_peer_tls_identity: ${error.message}`);
  }

  let generated;
  if (generate) {
    generated = await generate(deviceId);
  } else {
    const imported = await import('selfsigned');
    const selfsigned = imported.default ?? imported;
    const result = await selfsigned.generate([{ name: 'commonName', value: `xats-${deviceId}` }], {
      algorithm: 'sha256',
      keyType: 'ec',
      curve: 'P-256',
      notAfterDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    });
    generated = { certificate: result.cert, privateKey: result.private };
  }
  const identity = {
    version: 1,
    certificate: generated.certificate,
    privateKey: generated.privateKey,
    fingerprint: fingerprintFor(generated.certificate),
  };
  validatePeerTlsIdentity(identity);
  try {
    writePrivateJson(filePath, identity);
    return identity;
  } catch (error) {
    // Another process may have won initialization; only accept its valid keypair.
    try {
      const winner = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return validatePeerTlsIdentity(winner);
    } catch {
      throw error;
    }
  }
}

export function peerTlsServerOptions(identity) {
  validatePeerTlsIdentity(identity);
  return { key: identity.privateKey, cert: identity.certificate, minVersion: 'TLSv1.2' };
}

export function peerTlsFingerprintFromRaw(rawCertificate) {
  if (!Buffer.isBuffer(rawCertificate)) throw new TypeError('certificate_raw_buffer_required');
  return createHash('sha256').update(rawCertificate).digest('hex');
}

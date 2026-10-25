import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDeviceIdentity } from '../lib/peer-identity.mjs';
import { loadOrCreatePeerTlsIdentity, peerTlsServerOptions, validatePeerTlsIdentity } from '../lib/peer-tls.mjs';

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'xats-peer-tls-')); }

test('TLS certificate identity persists, pins the keypair, and is owner-only', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const device = createDeviceIdentity();
  const file = path.join(dir, 'state', 'peer-tls.json');
  const first = await loadOrCreatePeerTlsIdentity(file, { deviceId: device.deviceId });
  const second = await loadOrCreatePeerTlsIdentity(file, { deviceId: device.deviceId });
  assert.equal(second.fingerprint, first.fingerprint);
  assert.equal(validatePeerTlsIdentity(first), first);
  assert.equal(peerTlsServerOptions(first).cert, first.certificate);
  assert.throws(() => validatePeerTlsIdentity({ ...first, fingerprint: '0'.repeat(64) }), /invalid_peer_tls_identity/);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  }
});

test('TLS identity refuses a private key that does not match its certificate', async () => {
  const dir = tempDir();
  try {
    const first = createDeviceIdentity();
    const second = createDeviceIdentity();
    const a = await loadOrCreatePeerTlsIdentity(path.join(dir, 'a.json'), { deviceId: first.deviceId });
    const b = await loadOrCreatePeerTlsIdentity(path.join(dir, 'b.json'), { deviceId: second.deviceId });
    assert.throws(() => validatePeerTlsIdentity({ ...a, privateKey: b.privateKey }), /invalid_peer_tls_identity/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

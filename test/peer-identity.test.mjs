import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createDeviceIdentity,
  createPeerInvite,
  createPairRequest,
  getTrustedPeerRecord,
  validateDeviceIdentity,
  verifyPairRequest,
  verifyPeerInvite,
} from '../lib/peer-identity.mjs';
import { loadOrCreatePeerTlsIdentity } from '../lib/peer-tls.mjs';

const NOW = 1_800_000_000_000;
const ENDPOINT = 'https://127.0.0.1:9110';

async function tlsIdentity(t, deviceId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xats-peer-identity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return loadOrCreatePeerTlsIdentity(path.join(dir, 'tls.json'), { deviceId });
}

test('device identity has a stable public-key-derived id and matching keypair', () => {
  const identity = createDeviceIdentity();
  assert.equal(validateDeviceIdentity(identity), identity);
  assert.match(identity.deviceId, /^[a-f0-9]{32}$/);
  assert.throws(() => validateDeviceIdentity({ ...identity, deviceId: '0'.repeat(32) }), /invalid_device_identity/);
});

test('signed invite binds endpoint and TLS certificate, expires, and rejects tampering', async (t) => {
  const inviter = createDeviceIdentity();
  const tls = await tlsIdentity(t, inviter.deviceId);
  const { invite } = createPeerInvite(inviter, { endpoint: ENDPOINT, tlsIdentity: tls, now: NOW, ttlMs: 60_000 });
  assert.equal(verifyPeerInvite(invite, { now: NOW + 1 }), true);
  assert.equal(verifyPeerInvite(invite, { now: NOW + 60_000 }), false);
  assert.equal(verifyPeerInvite({ ...invite, deviceId: 'f'.repeat(32) }, { now: NOW }), false);
  assert.equal(verifyPeerInvite({ ...invite, endpoint: 'http://127.0.0.1:9110' }, { now: NOW }), false);
  assert.throws(() => createPeerInvite(inviter, { endpoint: ENDPOINT, tlsIdentity: tls, now: NOW, ttlMs: 10 * 60 * 1000 + 1 }), /invalid_invite_lifetime/);
  assert.throws(() => createPeerInvite(inviter, { endpoint: 'http://127.0.0.1:9110', tlsIdentity: tls, now: NOW }), /invalid_invite_endpoint_or_tls/);
});

test('pair request proves invite-secret and identity-key possession; trust still explicit', async (t) => {
  const inviter = createDeviceIdentity();
  const joiner = createDeviceIdentity();
  const inviterTls = await tlsIdentity(t, inviter.deviceId);
  const joinerTls = await tlsIdentity(t, joiner.deviceId);
  const { invite, secret } = createPeerInvite(inviter, { endpoint: ENDPOINT, tlsIdentity: inviterTls, now: NOW });
  const request = createPairRequest(invite, secret, joiner, { tlsIdentity: joinerTls, endpoint: 'https://127.0.0.1:9111', now: NOW, nonce: 'a'.repeat(32) });
  assert.equal(verifyPairRequest(invite, secret, request, { now: NOW }), true);
  assert.equal(verifyPairRequest(invite, 'A'.repeat(43), request, { now: NOW }), false);
  assert.equal(verifyPairRequest(invite, secret, { ...request, deviceId: '0'.repeat(32) }, { now: NOW }), false);
  assert.equal(verifyPairRequest(invite, secret, { ...request, tlsFingerprint: '0'.repeat(64) }, { now: NOW }), false);
  assert.equal(verifyPairRequest(invite, secret, request, { now: NOW + 6 * 60 * 1000 }), false);
  const peer = getTrustedPeerRecord(request, { pairedAt: NOW, label: 'homelab' });
  assert.equal(peer.deviceId, joiner.deviceId);
  assert.equal(peer.tlsFingerprint, joinerTls.fingerprint);
});

test('invite secret is high entropy and pair-request nonce is mandatory', async (t) => {
  const inviter = createDeviceIdentity();
  const joiner = createDeviceIdentity();
  const inviterTls = await tlsIdentity(t, inviter.deviceId);
  const joinerTls = await tlsIdentity(t, joiner.deviceId);
  const { invite, secret } = createPeerInvite(inviter, { endpoint: ENDPOINT, tlsIdentity: inviterTls, now: NOW });
  assert.equal(Buffer.from(secret, 'base64url').length, 32);
  assert.throws(() => createPairRequest(invite, secret, joiner, { tlsIdentity: joinerTls, endpoint: 'https://127.0.0.1:9111', now: NOW, nonce: 'bad' }), /invalid_pair_request/);
});

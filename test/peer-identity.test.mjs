import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDeviceIdentity,
  createPeerInvite,
  createPairRequest,
  getTrustedPeerRecord,
  validateDeviceIdentity,
  verifyPairRequest,
  verifyPeerInvite,
} from '../lib/peer-identity.mjs';

const NOW = 1_800_000_000_000;

test('device identity has a stable public-key-derived id and matching keypair', () => {
  const identity = createDeviceIdentity();
  assert.equal(validateDeviceIdentity(identity), identity);
  assert.match(identity.deviceId, /^[a-f0-9]{32}$/);
  assert.throws(() => validateDeviceIdentity({ ...identity, deviceId: '0'.repeat(32) }), /invalid_device_identity/);
});

test('signed invite expires and rejects tampering', () => {
  const inviter = createDeviceIdentity();
  const { invite } = createPeerInvite(inviter, { now: NOW, ttlMs: 60_000 });
  assert.equal(verifyPeerInvite(invite, { now: NOW + 1 }), true);
  assert.equal(verifyPeerInvite(invite, { now: NOW + 60_000 }), false);
  assert.equal(verifyPeerInvite({ ...invite, deviceId: 'f'.repeat(32) }, { now: NOW }), false);
  assert.throws(() => createPeerInvite(inviter, { now: NOW, ttlMs: 10 * 60 * 1000 + 1 }), /invalid_invite_lifetime/);
});

test('pair request proves invite-secret and identity-key possession; trust still explicit', () => {
  const inviter = createDeviceIdentity();
  const joiner = createDeviceIdentity();
  const { invite, secret } = createPeerInvite(inviter, { now: NOW });
  const request = createPairRequest(invite, secret, joiner, { now: NOW, nonce: 'a'.repeat(32) });
  assert.equal(verifyPairRequest(invite, secret, request, { now: NOW }), true);
  assert.equal(verifyPairRequest(invite, 'A'.repeat(43), request, { now: NOW }), false);
  assert.equal(verifyPairRequest(invite, secret, { ...request, deviceId: '0'.repeat(32) }, { now: NOW }), false);
  assert.equal(verifyPairRequest(invite, secret, request, { now: NOW + 6 * 60 * 1000 }), false);
  assert.equal(getTrustedPeerRecord(request, { pairedAt: NOW, label: 'homelab' }).deviceId, joiner.deviceId);
});

test('invite secret is high entropy and pair-request nonce is mandatory', () => {
  const inviter = createDeviceIdentity();
  const joiner = createDeviceIdentity();
  const { invite, secret } = createPeerInvite(inviter, { now: NOW });
  assert.equal(Buffer.from(secret, 'base64url').length, 32);
  assert.throws(() => createPairRequest(invite, secret, joiner, { now: NOW, nonce: 'bad' }), /invalid_pair_request/);
});

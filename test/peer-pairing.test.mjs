import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDeviceIdentity, createPairRequest } from '../lib/peer-identity.mjs';
import { loadOrCreateDeviceIdentity, PeerPairingManager, PeerTrustStore } from '../lib/peer-pairing.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xats-pairing-'));
}

test('device identity persists securely and remains stable', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state', 'identity.json');
  const first = loadOrCreateDeviceIdentity(file);
  const second = loadOrCreateDeviceIdentity(file);
  assert.equal(second.deviceId, first.deviceId);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('pairing requires explicit approval, consumes invite once, and persists/revokes trust', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = 1_800_000_000_000;
  const trust = new PeerTrustStore(path.join(dir, 'peers.json'));
  const inviter = new PeerPairingManager({ identity: createDeviceIdentity(), trustStore: trust, now: () => now });
  const invitee = createDeviceIdentity();
  const { invite, secret } = inviter.createInvite();
  const request = createPairRequest(invite, secret, invitee, { now });
  const candidate = inviter.submitRequest(invite.inviteId, request);
  assert.equal(trust.get(invitee.deviceId), null);
  assert.equal(inviter.listPending().length, 1);
  assert.throws(() => inviter.submitRequest(invite.inviteId, request), /replayed_pair_request/);
  const peer = inviter.approve(candidate.pendingId, { label: 'homelab' });
  assert.equal(peer.deviceId, invitee.deviceId);
  assert.equal(trust.get(invitee.deviceId).label, 'homelab');
  assert.throws(() => inviter.submitRequest(invite.inviteId, request), /invite_unavailable/);
  assert.equal(new PeerTrustStore(path.join(dir, 'peers.json')).get(invitee.deviceId).deviceId, invitee.deviceId);
  assert.equal(inviter.revoke(invitee.deviceId), true);
  assert.equal(trust.get(invitee.deviceId), null);
});

test('denying a request does not grant trust and expired invites cannot be approved', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = 1_800_000_000_000;
  const manager = new PeerPairingManager({ identity: createDeviceIdentity(), trustStore: new PeerTrustStore(path.join(dir, 'peers.json')), now: () => now });
  const invitee = createDeviceIdentity();
  const { invite, secret } = manager.createInvite({ ttlMs: 1000 });
  const request = createPairRequest(invite, secret, invitee, { now });
  const pending = manager.submitRequest(invite.inviteId, request);
  assert.equal(manager.deny(pending.pendingId), true);
  assert.equal(manager.listPending().length, 0);
  assert.equal(manager.trustStore.get(invitee.deviceId), null);
  const second = manager.createInvite({ ttlMs: 1000 });
  const request2 = createPairRequest(second.invite, second.secret, invitee, { now });
  const pending2 = manager.submitRequest(second.invite.inviteId, request2);
  now += 1001;
  assert.throws(() => manager.approve(pending2.pendingId), /pending_pairing_not_found|invite_unavailable/);
});

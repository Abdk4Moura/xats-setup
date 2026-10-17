import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDeviceIdentity, createPairRequest } from '../lib/peer-identity.mjs';
import { loadOrCreateDeviceIdentity, PeerPairingManager, PeerTrustStore } from '../lib/peer-pairing.mjs';
import { loadOrCreatePeerTlsIdentity } from '../lib/peer-tls.mjs';

const ENDPOINT = 'https://127.0.0.1:9110';
function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'xats-pairing-')); }
async function tlsIdentity(dir, identity) {
  return loadOrCreatePeerTlsIdentity(path.join(dir, `${identity.deviceId}-tls.json`), { deviceId: identity.deviceId });
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

test('pairing requires explicit approval, consumes invite once, and persists/revokes trust', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = 1_800_000_000_000;
  const trust = new PeerTrustStore(path.join(dir, 'peers.json'));
  const inviterIdentity = createDeviceIdentity();
  const inviter = new PeerPairingManager({ identity: inviterIdentity, tlsIdentity: await tlsIdentity(dir, inviterIdentity), endpoint: ENDPOINT, trustStore: trust, now: () => now });
  const invitee = createDeviceIdentity();
  const inviteeTls = await tlsIdentity(dir, invitee);
  const { invite, secret } = inviter.createInvite();
  const request = createPairRequest(invite, secret, invitee, { tlsIdentity: inviteeTls, endpoint: 'https://127.0.0.1:9111', now });
  const candidate = inviter.submitRequest(invite.inviteId, request);
  assert.equal(trust.get(invitee.deviceId), null);
  assert.equal(inviter.listPending().length, 1);
  assert.throws(() => inviter.submitRequest(invite.inviteId, request), /replayed_pair_request/);
  const peer = inviter.approve(candidate.pendingId, { label: 'homelab' });
  assert.equal(peer.deviceId, invitee.deviceId);
  assert.equal(peer.tlsFingerprint, inviteeTls.fingerprint);
  assert.equal(trust.get(invitee.deviceId).label, 'homelab');
  assert.throws(() => inviter.submitRequest(invite.inviteId, request), /invite_unavailable/);
  assert.equal(new PeerTrustStore(path.join(dir, 'peers.json')).get(invitee.deviceId).deviceId, invitee.deviceId);
  assert.equal(inviter.revoke(invitee.deviceId), true);
  assert.equal(trust.get(invitee.deviceId), null);
});

test('denying a request does not grant trust and expired invites cannot be approved', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = 1_800_000_000_000;
  const identity = createDeviceIdentity();
  const manager = new PeerPairingManager({ identity, tlsIdentity: await tlsIdentity(dir, identity), endpoint: ENDPOINT, trustStore: new PeerTrustStore(path.join(dir, 'peers.json')), now: () => now });
  const invitee = createDeviceIdentity();
  const inviteeTls = await tlsIdentity(dir, invitee);
  const { invite, secret } = manager.createInvite({ ttlMs: 1000 });
  const request = createPairRequest(invite, secret, invitee, { tlsIdentity: inviteeTls, endpoint: 'https://127.0.0.1:9111', now });
  const pending = manager.submitRequest(invite.inviteId, request);
  assert.equal(manager.deny(pending.pendingId), true);
  assert.equal(manager.listPending().length, 0);
  assert.equal(manager.trustStore.get(invitee.deviceId), null);
  assert.throws(() => manager.submitRequest(invite.inviteId, request), /invite_unavailable/);
  const second = manager.createInvite({ ttlMs: 1000 });
  const request2 = createPairRequest(second.invite, second.secret, invitee, { tlsIdentity: inviteeTls, endpoint: 'https://127.0.0.1:9111', now });
  const pending2 = manager.submitRequest(second.invite.inviteId, request2);
  now += 1001;
  assert.throws(() => manager.approve(pending2.pendingId), /pending_pairing_not_found|invite_unavailable/);
});

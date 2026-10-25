import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDeviceIdentity, createDiscoveryPairRequest, createPairRequest } from '../lib/peer-identity.mjs';
import { loadOrCreateDeviceIdentity, PeerPairingManager, PeerTrustStore } from '../lib/peer-pairing.mjs';
import { loadOrCreatePeerTlsIdentity } from '../lib/peer-tls.mjs';

const ENDPOINT = 'https://127.0.0.1:9110';
function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'xats-pairing-')); }
async function tlsIdentity(dir, identity) {
  return loadOrCreatePeerTlsIdentity(path.join(dir, `${identity.deviceId}-tls.json`), { deviceId: identity.deviceId });
}

function createManager({ dir, identity, tlsIdentity, now = () => Date.now() }) {
  return new PeerPairingManager({ identity, tlsIdentity, endpoint: ENDPOINT, trustStore: new PeerTrustStore(path.join(dir, 'peers.json')), now });
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

test('invite pairing requires explicit approval, consumes invite once, and persists/revokes trust', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = 1_800_000_000_000;
  const inviterIdentity = createDeviceIdentity();
  const inviter = createManager({ dir, identity: inviterIdentity, tlsIdentity: await tlsIdentity(dir, inviterIdentity), now: () => now });
  const invitee = createDeviceIdentity();
  const inviteeTls = await tlsIdentity(dir, invitee);
  const { invite, secret } = inviter.createInvite();
  const request = createPairRequest(invite, secret, invitee, { tlsIdentity: inviteeTls, endpoint: 'https://127.0.0.1:9111', now });
  const candidate = inviter.submitRequest(invite.inviteId, request);
  assert.equal(inviter.trustStore.get(invitee.deviceId), null);
  assert.equal(inviter.status(candidate.pendingId).status, 'pending');
  assert.equal(inviter.listPending().length, 1);
  assert.throws(() => inviter.submitRequest(invite.inviteId, request), /replayed_pair_request/);
  const peer = inviter.approve(candidate.pendingId, { label: 'homelab' });
  assert.equal(peer.deviceId, invitee.deviceId);
  assert.equal(peer.tlsFingerprint, inviteeTls.fingerprint);
  assert.equal(inviter.trustStore.get(invitee.deviceId).label, 'homelab');
  assert.equal(inviter.status(candidate.pendingId).status, 'approved');
  assert.throws(() => inviter.submitRequest(invite.inviteId, request), /invite_unavailable/);
  assert.equal(new PeerTrustStore(path.join(dir, 'peers.json')).get(invitee.deviceId).deviceId, invitee.deviceId);
  assert.equal(inviter.revoke(invitee.deviceId), true);
  assert.equal(inviter.trustStore.get(invitee.deviceId), null);
});

test('LAN discovery pairing is pending until approval; duplicate request is idempotent', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = 1_800_000_000_000;
  const hostIdentity = createDeviceIdentity();
  const host = createManager({ dir, identity: hostIdentity, tlsIdentity: await tlsIdentity(dir, hostIdentity), now: () => now });
  const candidateIdentity = createDeviceIdentity();
  const request = createDiscoveryPairRequest(candidateIdentity, {
    tlsIdentity: await tlsIdentity(dir, candidateIdentity), endpoint: 'https://127.0.0.1:9111', now,
  });
  const first = host.submitDiscoveryRequest(request);
  const retry = host.submitDiscoveryRequest(request);
  assert.equal(first.pendingId, retry.pendingId);
  assert.equal(host.status(first.pendingId).status, 'pending');
  assert.equal(host.trustStore.get(candidateIdentity.deviceId), null);
  const peer = host.approve(first.pendingId, { label: 'studio' });
  assert.equal(peer.deviceId, candidateIdentity.deviceId);
  assert.equal(host.status(first.pendingId).status, 'approved');
  assert.throws(() => host.submitDiscoveryRequest(request), /peer_already_paired/);
});

test('denying a request burns invites and discovery requests never grant trust', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = 1_800_000_000_000;
  const inviter = createDeviceIdentity();
  const manager = createManager({ dir, identity: inviter, tlsIdentity: await tlsIdentity(dir, inviter), now: () => now });
  const invitee = createDeviceIdentity();
  const inviteeTls = await tlsIdentity(dir, invitee);
  const { invite, secret } = manager.createInvite({ ttlMs: 1000 });
  const request = createPairRequest(invite, secret, invitee, { tlsIdentity: inviteeTls, endpoint: 'https://127.0.0.1:9111', now });
  const pending = manager.submitRequest(invite.inviteId, request);
  assert.equal(manager.deny(pending.pendingId), true);
  assert.equal(manager.status(pending.pendingId).status, 'denied');
  assert.equal(manager.listPending().length, 0);
  assert.equal(manager.trustStore.get(invitee.deviceId), null);
  assert.throws(() => manager.submitRequest(invite.inviteId, request), /invite_unavailable/);
  const second = manager.createInvite({ ttlMs: 1000 });
  const request2 = createPairRequest(second.invite, second.secret, invitee, { tlsIdentity: inviteeTls, endpoint: 'https://127.0.0.1:9111', now });
  const pending2 = manager.submitRequest(second.invite.inviteId, request2);
  now += 1001;
  assert.throws(() => manager.approve(pending2.pendingId), /pairing_request_expired/);
});

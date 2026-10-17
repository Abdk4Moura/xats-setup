import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  createDeviceIdentity,
  createPeerInvite,
  getTrustedPeerRecord,
  validateDeviceIdentity,
  verifyDiscoveryPairRequest,
  verifyPairRequest,
} from './peer-identity.mjs';

const INVITE_TTL_MS = 5 * 60 * 1000;

function writeJsonPrivate(filePath, value, { exclusive = false } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(filePath), 0o700); } catch { /* best effort on Windows */ }
  const tempPath = `${filePath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (exclusive) {
      fs.linkSync(tempPath, filePath);
      fs.unlinkSync(tempPath);
    } else {
      fs.renameSync(tempPath, filePath);
    }
    try { fs.chmodSync(filePath, 0o600); } catch { /* best effort on platforms without POSIX modes */ }
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.rmSync(tempPath, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

export function loadOrCreateDeviceIdentity(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(filePath), 0o700); } catch { /* best effort on Windows */ }
  try {
    const identity = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    validateDeviceIdentity(identity);
    try { fs.chmodSync(filePath, 0o600); } catch { /* best effort on Windows */ }
    return identity;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`invalid_or_unreadable_device_identity: ${error.message}`);
  }
  const identity = createDeviceIdentity();
  try {
    writeJsonPrivate(filePath, identity, { exclusive: true });
  } catch (error) {
    // Another process may have initialized the identity at the same time.
    try {
      const winner = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return validateDeviceIdentity(winner);
    } catch {
      throw error;
    }
  }
  return identity;
}

export class PeerTrustStore {
  constructor(filePath) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    try { fs.chmodSync(path.dirname(filePath), 0o700); } catch { /* best effort on Windows */ }
    this.peers = new Map();
    this.#load();
  }

  #load() {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw new Error(`invalid_peer_store: ${error.message}`);
    }
    if (data?.version !== 1 || !Array.isArray(data.peers)) throw new Error('invalid_peer_store');
    for (const peer of data.peers) {
      const checked = getTrustedPeerRecord(peer, { pairedAt: peer.pairedAt, label: peer.label });
      if (this.peers.has(checked.deviceId)) throw new Error('duplicate_peer_identity');
      this.peers.set(checked.deviceId, checked);
    }
    try { fs.chmodSync(this.filePath, 0o600); } catch { /* best effort on Windows */ }
  }

  #save() {
    writeJsonPrivate(this.filePath, { version: 1, peers: this.list() });
  }

  list() {
    return [...this.peers.values()].map((peer) => ({ ...peer }));
  }

  get(deviceId) {
    const peer = this.peers.get(deviceId);
    return peer ? { ...peer } : null;
  }

  trust(peer) {
    const checked = getTrustedPeerRecord(peer, { pairedAt: peer.pairedAt, label: peer.label });
    this.peers.set(checked.deviceId, checked);
    this.#save();
    return { ...checked };
  }

  revoke(deviceId) {
    if (!this.peers.delete(deviceId)) return false;
    this.#save();
    return true;
  }
}

// Owns the inviter-side state machine. Receiving a valid proof creates a pending
// candidate only; trust is persisted only after explicit approve(). Invites and
// pending requests are in-memory, expiring state and cannot survive a restart.
export class PeerPairingManager {
  constructor({ identity, tlsIdentity, endpoint, trustStore, now = () => Date.now() }) {
    this.identity = validateDeviceIdentity(identity);
    this.tlsIdentity = tlsIdentity;
    this.endpoint = endpoint;
    this.trustStore = trustStore;
    this.now = now;
    this.invites = new Map();
    this.pending = new Map();
    this.decisions = new Map();
    this.seenNonces = new Map();
  }

  createInvite({ ttlMs = INVITE_TTL_MS, endpoint = this.endpoint } = {}) {
    this.#prune();
    if (this.invites.size >= 20) throw new Error('too_many_active_invites');
    const created = createPeerInvite(this.identity, { endpoint, tlsIdentity: this.tlsIdentity, now: this.now(), ttlMs });
    this.invites.set(created.invite.inviteId, { ...created, consumed: false });
    return created;
  }

  submitRequest(inviteId, request) {
    this.#prune();
    if (this.pending.size >= 100) throw new Error('too_many_pending_pairings');
    const record = this.invites.get(inviteId);
    const now = this.now();
    if (!record || record.consumed || record.invite.expiresAt <= now) throw new Error('invite_unavailable');
    if (!verifyPairRequest(record.invite, record.secret, request, { now })) throw new Error('invalid_pair_request');
    const nonceKey = `${inviteId}:${request.nonce}`;
    if (this.seenNonces.has(nonceKey)) throw new Error('replayed_pair_request');
    if (this.trustStore.get(request.deviceId)) throw new Error('peer_already_paired');
    this.seenNonces.set(nonceKey, record.invite.expiresAt);
    const pendingId = randomBytes(16).toString('hex');
    this.pending.set(pendingId, { pendingId, inviteId, mode: 'invite', request, receivedAt: now, expiresAt: record.invite.expiresAt });
    return { pendingId, mode: 'invite', peer: { deviceId: request.deviceId, publicKey: request.publicKey } };
  }

  submitDiscoveryRequest(request) {
    this.#prune();
    if (this.pending.size >= 100) throw new Error('too_many_pending_pairings');
    const now = this.now();
    if (!verifyDiscoveryPairRequest(request, { now })) throw new Error('invalid_discovery_pair_request');
    if (request.deviceId === this.identity.deviceId || this.trustStore.get(request.deviceId)) throw new Error('peer_already_paired');
    const nonceKey = `discovery:${request.deviceId}:${request.requestId}`;
    const existing = [...this.pending.values()].find((item) => item.mode === 'discovery' && item.request.deviceId === request.deviceId && item.request.requestId === request.requestId);
    if (existing) return { pendingId: existing.pendingId, mode: 'discovery', peer: { deviceId: request.deviceId, publicKey: request.publicKey } };
    if (this.seenNonces.has(nonceKey)) throw new Error('replayed_pair_request');
    this.seenNonces.set(nonceKey, request.issuedAt + 60_000);
    const pendingId = randomBytes(16).toString('hex');
    this.pending.set(pendingId, { pendingId, mode: 'discovery', request, receivedAt: now, expiresAt: now + 60_000 });
    return { pendingId, mode: 'discovery', peer: { deviceId: request.deviceId, publicKey: request.publicKey } };
  }

  listPending() {
    this.#prune();
    const now = this.now();
    return [...this.pending.values()]
      .filter((p) => p.expiresAt > now)
      .map((p) => ({ pendingId: p.pendingId, mode: p.mode, receivedAt: p.receivedAt, deviceId: p.request.deviceId }));
  }

  approve(pendingId, { label = null } = {}) {
    const pending = this.pending.get(pendingId);
    if (!pending) throw new Error('pending_pairing_not_found');
    const now = this.now();
    if (pending.expiresAt <= now) {
      this.pending.delete(pendingId);
      throw new Error('pairing_request_expired');
    }
    const invite = pending.mode === 'invite' ? this.invites.get(pending.inviteId) : null;
    if (pending.mode === 'invite' && (!invite || invite.consumed || invite.invite.expiresAt <= now)) {
      this.pending.delete(pendingId);
      throw new Error('invite_unavailable');
    }
    const peer = this.trustStore.trust(getTrustedPeerRecord(pending.request, { pairedAt: now, label }));
    if (invite) {
      invite.consumed = true;
      this.invites.delete(pending.inviteId);
      for (const [id, item] of this.pending) if (item.inviteId === pending.inviteId) this.pending.delete(id);
    } else {
      this.pending.delete(pendingId);
    }
    this.decisions.set(pendingId, { status: 'approved', deviceId: peer.deviceId, expiresAt: now + 5 * 60_000 });
    return peer;
  }

  deny(pendingId) {
    const pending = this.pending.get(pendingId);
    if (!pending) return false;
    this.pending.delete(pendingId);
    if (pending.mode === 'invite') {
      // A denied invite is burned so repeated requests cannot keep generating prompts.
      this.invites.delete(pending.inviteId);
      for (const [id, item] of this.pending) if (item.inviteId === pending.inviteId) this.pending.delete(id);

    }
    this.decisions.set(pendingId, { status: 'denied', deviceId: pending.request.deviceId, expiresAt: this.now() + 5 * 60_000 });
    return true;
  }

  status(pendingId) {
    this.#prune();
    const pending = this.pending.get(pendingId);
    if (pending) return { status: 'pending', deviceId: pending.request.deviceId };
    const result = this.decisions.get(pendingId);
    return result ? { status: result.status, deviceId: result.deviceId } : { status: 'not_found' };
  }

  revoke(deviceId) {
    return this.trustStore.revoke(deviceId);
  }

  #prune() {
    const now = this.now();
    const activeInviteIds = new Set();
    for (const [id, invite] of this.invites) {
      if (invite.invite.expiresAt <= now || invite.consumed) this.invites.delete(id);
      else activeInviteIds.add(id);
    }
    for (const [id, pending] of this.pending) {
      if (pending.expiresAt <= now || (pending.mode === 'invite' && !activeInviteIds.has(pending.inviteId))) this.pending.delete(id);
    }
    for (const [id, decision] of this.decisions) if (decision.expiresAt <= now) this.decisions.delete(id);
    for (const [key, expiresAt] of this.seenNonces) if (expiresAt <= now) this.seenNonces.delete(key);
  }
}

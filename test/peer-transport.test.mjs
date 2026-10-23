import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { createDeviceIdentity, getTrustedPeerRecord } from '../lib/peer-identity.mjs';
import { loadOrCreatePeerTlsIdentity } from '../lib/peer-tls.mjs';
import { createPeerAuthHeaders, createPeerHttpsServer, PEER_API_PREFIX, readPeerInfo, requestPeer, verifyPeerInfo } from '../lib/peer-transport.mjs';
import { PeerTrustStore } from '../lib/peer-pairing.mjs';

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'xats-peer-transport-')); }
async function tlsIdentity(dir, identity) {
  return loadOrCreatePeerTlsIdentity(path.join(dir, `${identity.deviceId}.tls.json`), { deviceId: identity.deviceId });
}
function peerRecord(identity, tls) {
  return getTrustedPeerRecord({
    deviceId: identity.deviceId,
    publicKey: identity.publicKey,
    tlsCertificate: tls.certificate,
    tlsFingerprint: tls.fingerprint,
    endpoint: 'https://127.0.0.1:9112',
  });
}

async function startServer(t, { dir, identity, tls, trust, handlers }) {
  const service = createPeerHttpsServer({ identity, tlsIdentity: tls, trustStore: trust, handlers, host: '127.0.0.1', port: 0 });
  const address = await service.listen();
  t.after(async () => {
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { service, url: `https://127.0.0.1:${address.port}` };
}

test('HTTPS peer service encrypts traffic and serves data only to signed paired identities', async (t) => {
  const dir = tempDir();
  const serverIdentity = createDeviceIdentity();
  const serverTls = await tlsIdentity(dir, serverIdentity);
  const clientIdentity = createDeviceIdentity();
  const clientTls = await tlsIdentity(dir, clientIdentity);
  const outsiderIdentity = createDeviceIdentity();
  const calls = { roster: 0, deliver: 0 };
  const trust = new PeerTrustStore(path.join(dir, 'trusted-peers.json'));
  trust.trust(peerRecord(clientIdentity, clientTls));
  const { url } = await startServer(t, {
    dir, identity: serverIdentity, tls: serverTls, trust,
    handlers: {
      getRoster: async (peer) => { calls.roster++; return { agents: [{ name: 'pi-home', peer: peer.deviceId }] }; },
      deliverMessage: async (body) => { calls.deliver++; return { ok: true, message_id: body.message_id }; },
    },
  });
  const serverRecord = peerRecord(serverIdentity, serverTls);
  const info = await readPeerInfo(url, { expectedDeviceId: serverIdentity.deviceId });
  assert.equal(verifyPeerInfo(info), true);
  assert.equal(info.tls_fingerprint, serverTls.fingerprint);
  await assert.rejects(readPeerInfo(url, { expectedDeviceId: clientIdentity.deviceId }), /unverified_peer_info/);
  const ok = await requestPeer({ peer: serverRecord, identity: clientIdentity, url, path: `${PEER_API_PREFIX}/agents/roster` });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.agents[0].peer, clientIdentity.deviceId);
  assert.equal(calls.roster, 1);

  const denied = await requestPeer({ peer: serverRecord, identity: outsiderIdentity, url, path: `${PEER_API_PREFIX}/agents/roster` });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error, 'peer_not_trusted');
  assert.equal(calls.roster, 1);

  const delivered = await requestPeer({
    peer: serverRecord, identity: clientIdentity, url, method: 'POST', path: `${PEER_API_PREFIX}/messages/deliver`,
    body: { message_id: 'm-001', body: 'private message' },
  });
  assert.equal(delivered.status, 200);
  assert.deepEqual(delivered.body, { ok: true, message_id: 'm-001' });
  assert.equal(calls.deliver, 1);
});

test('peer transport rejects replay, tampered bodies, and TLS certificate substitution', async (t) => {
  const dir = tempDir();
  const serverIdentity = createDeviceIdentity();
  const serverTls = await tlsIdentity(dir, serverIdentity);
  const clientIdentity = createDeviceIdentity();
  const clientTls = await tlsIdentity(dir, clientIdentity);
  const trust = new PeerTrustStore(path.join(dir, 'trusted-peers.json'));
  trust.trust(peerRecord(clientIdentity, clientTls));
  const called = [];
  const { url } = await startServer(t, {
    dir, identity: serverIdentity, tls: serverTls, trust,
    handlers: { deliverMessage: async (body) => { called.push(body); return { ok: true }; } },
  });
  const serverRecord = peerRecord(serverIdentity, serverTls);
  const method = 'POST';
  const requestPath = `${PEER_API_PREFIX}/messages/deliver`;
  const nonce = 'c'.repeat(32);
  const first = await requestPeer({ peer: serverRecord, identity: clientIdentity, url, method, path: requestPath, body: { body: 'x' }, nonce });
  assert.equal(first.status, 200);
  const replay = await requestPeer({ peer: serverRecord, identity: clientIdentity, url, method, path: requestPath, body: { body: 'x' }, nonce });
  assert.equal(replay.status, 409);
  assert.equal(replay.body.error, 'peer_request_replayed');

  const signedBody = Buffer.from(JSON.stringify({ body: 'signed' }));
  const headers = createPeerAuthHeaders(clientIdentity, { method, path: requestPath, body: signedBody, nonce: 'd'.repeat(32) });
  headers['content-type'] = 'application/json';
  headers['content-length'] = signedBody.length;
  const tampered = await new Promise((resolve, reject) => {
    const req = https.request(url, {
      method, path: requestPath, headers, ca: serverTls.certificate, rejectUnauthorized: true,
      checkServerIdentity: (_host, cert) => cert.fingerprint256.replaceAll(':', '').toLowerCase() === serverTls.fingerprint ? undefined : new Error('pin_mismatch'),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ body: 'forged' }));
  });
  assert.equal(tampered.status, 401);
  assert.equal(tampered.body.error, 'invalid_peer_signature');
  assert.equal(called.length, 1);

  const otherTls = await tlsIdentity(dir, createDeviceIdentity());
  const wrongPin = { ...serverRecord, tlsCertificate: otherTls.certificate, tlsFingerprint: otherTls.fingerprint };
  let pinRejected = false;
  try {
    await requestPeer({ peer: wrongPin, identity: clientIdentity, url, path: `${PEER_API_PREFIX}/agents/roster` });
  } catch {
    pinRejected = true;
  }
  assert.equal(pinRejected, true);
});

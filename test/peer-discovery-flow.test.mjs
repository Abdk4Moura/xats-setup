import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { attachXatsMdns, XATS_MDNS_TYPE, XATS_PEER_PROTOCOL_VERSION } from '../lib/mdns-discovery.mjs';
import { startPeerRuntime, callPeerControl } from '../lib/peer-runtime.mjs';
import { mainPeer } from '../lib/peer-cli.mjs';

function reachableIPv4() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const item of entries || []) {
      const family = typeof item.family === 'string' ? item.family : item.family === 4 ? 'IPv4' : 'IPv6';
      if (family === 'IPv4' && !item.internal && net.isIP(item.address) === 4) return item.address;
    }
  }
  return null;
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function fakeBonjour() {
  const browser = new EventEmitter();
  browser.stop = () => {};
  const service = new EventEmitter();
  service.stop = (done) => done?.();
  return {
    browser,
    find: () => browser,
    publish: () => service,
    destroy: (done) => done?.(),
  };
}

async function waitForPending(stateDir, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await callPeerControl({ stateDir, endpoint: '/pending' });
    if (result.pending.length) return result.pending[0];
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('pairing_request_not_received');
}

test('mDNS candidates flow through CLI pairing, fallback addresses, pinned HTTPS, and explicit approval', async (t) => {
  const address = reachableIPv4();
  if (!address) return t.skip('no non-loopback IPv4 interface available for direct peer test');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'xats-peer-discovery-flow-'));
  const leftDir = path.join(base, 'left');
  const rightDir = path.join(base, 'right');
  const leftBonjour = fakeBonjour();
  const rightBonjour = fakeBonjour();
  let left;
  let right;
  t.after(async () => {
    await left?.close();
    await right?.close();
    fs.rmSync(base, { recursive: true, force: true });
  });

  left = await startPeerRuntime({
    stateDir: leftDir,
    host: '::',
    port: 0,
    mdns: true,
    mdnsStarter: (options) => attachXatsMdns({ ...options, bonjour: leftBonjour }),
    federationEnabled: false,
    onLog() {},
  });
  right = await startPeerRuntime({
    stateDir: rightDir,
    host: '::',
    port: 0,
    mdns: true,
    mdnsStarter: (options) => attachXatsMdns({ ...options, bonjour: rightBonjour }),
    federationEnabled: false,
    onLog() {},
  });
  const leftEndpoint = `https://${address}:${left.peerPort}`;
  const rightEndpoint = `https://${address}:${right.peerPort}`;

  // Simulate two mDNS address records for one candidate: the first port is dead,
  // so the pairing flow must try the next advertised candidate endpoint.
  const deadPort = await unusedPort();
  const baseAnnouncement = {
    type: XATS_MDNS_TYPE,
    protocol: 'tcp',
    name: `xats-${right.identity.deviceId}`,
    txt: { xats_v: XATS_PEER_PROTOCOL_VERSION, xats_id: right.identity.deviceId },
    addresses: [address],
  };
  leftBonjour.browser.emit('up', { ...baseAnnouncement, port: deadPort });
  leftBonjour.browser.emit('up', { ...baseAnnouncement, port: right.peerPort });
  assert.equal(left.status().candidates.filter((candidate) => candidate.deviceId === right.identity.deviceId).length, 2);
  assert.equal(left.trustStore.get(right.identity.deviceId), null);

  const pairing = mainPeer(['pair', right.identity.deviceId, '--endpoint', leftEndpoint, '--label', 'lan-right'], { stateDir: leftDir });
  const pending = await waitForPending(rightDir);
  assert.equal(right.trustStore.get(left.identity.deviceId), null, 'candidate request alone does not create trust');
  await mainPeer(['approve', pending.pendingId, '--label', 'lan-left'], { stateDir: rightDir });
  const paired = await pairing;

  assert.equal(paired, undefined);
  assert.equal(left.trustStore.get(right.identity.deviceId).label, 'lan-right');
  assert.equal(right.trustStore.get(left.identity.deviceId).label, 'lan-left');
  assert.equal(left.trustStore.get(right.identity.deviceId).tlsFingerprint, right.tlsIdentity.fingerprint);
  assert.equal(right.trustStore.get(left.identity.deviceId).tlsFingerprint, left.tlsIdentity.fingerprint);
});

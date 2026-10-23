// Manual multicast smoke: starts two real Bonjour browsers/listeners, discovers a candidate,
// then drives signed pairing through the same CLI used by xats-setup peer pair/approve.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { startPeerRuntime, callPeerControl } from '../lib/peer-runtime.mjs';
import { mainPeer } from '../lib/peer-cli.mjs';

function reachableIPv4() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const item of entries || []) {
      const family = typeof item.family === 'string' ? item.family : item.family === 4 ? 'IPv4' : 'IPv6';
      if (family === 'IPv4' && !item.internal && net.isIP(item.address) === 4) return item.address;
    }
  }
  throw new Error('no_non_loopback_ipv4_interface');
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { const result = await check(); if (result) return result; }
    catch (error) { lastError = error; }
    await delay(100);
  }
  throw lastError || new Error('mdns_pairing_timeout');
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'xats-peer-real-mdns-'));
const leftDir = path.join(base, 'left');
const rightDir = path.join(base, 'right');
let left;
let right;
try {
  const address = reachableIPv4();
  left = await startPeerRuntime({ stateDir: leftDir, host: '::', port: 0, mdns: true, federationEnabled: false, onLog: console.log });
  right = await startPeerRuntime({ stateDir: rightDir, host: '::', port: 0, mdns: true, federationEnabled: false, onLog: console.log });
  const leftEndpoint = `https://${address}:${left.peerPort}`;
  const rightDeviceId = right.identity.deviceId;
  const candidate = await waitFor(() => left.status().candidates.find((item) => item.deviceId === rightDeviceId));
  assert.equal(left.trustStore.get(rightDeviceId), null, 'mDNS discovery does not grant trust');

  const pairing = mainPeer(['pair', rightDeviceId, '--endpoint', leftEndpoint, '--label', 'left-instance'], { stateDir: leftDir });
  const pending = await waitFor(async () => (await callPeerControl({ stateDir: rightDir, endpoint: '/pending' })).pending[0]);
  await mainPeer(['approve', pending.pendingId, '--label', 'right-instance'], { stateDir: rightDir });
  await pairing;
  assert.equal(left.trustStore.get(rightDeviceId).tlsFingerprint, right.tlsIdentity.fingerprint);
  assert.equal(right.trustStore.get(left.identity.deviceId).tlsFingerprint, left.tlsIdentity.fingerprint);
  console.log(JSON.stringify({ ok: true, discovery: 'real-mDNS', candidate: candidate.endpoint, explicitlyPaired: rightDeviceId }));
} finally {
  await left?.close();
  await right?.close();
  fs.rmSync(base, { recursive: true, force: true });
}

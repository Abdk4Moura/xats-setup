import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startPeerRuntime, callPeerControl } from '../lib/peer-runtime.mjs';
import { mainPeer } from '../lib/peer-cli.mjs';

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'xats-peer-runtime-')); }
async function waitForPending(stateDir, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const result = await callPeerControl({ stateDir, endpoint: '/pending' });
    if (result.pending.length) return result.pending[0];
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('pending_pairing_timeout');
}

test('peer status reports a stopped listener without treating it as a command failure', async () => {
  const stateDir = tempDir();
  const lines = [];
  const originalLog = console.log;
  console.log = (...values) => lines.push(values.join(' '));
  try { await mainPeer(['status'], { stateDir }); }
  finally { console.log = originalLog; fs.rmSync(stateDir, { recursive: true, force: true }); }
  assert.match(lines.join('\n'), /Peer service is not running/);
});

test('two local xats peer runtimes pair over pinned HTTPS only after explicit approval', async (t) => {
  const leftDir = tempDir();
  const rightDir = tempDir();
  const left = await startPeerRuntime({ stateDir: leftDir, host: '127.0.0.1', port: 0, mdns: false, federationEnabled: false, onLog() {} });
  const right = await startPeerRuntime({ stateDir: rightDir, host: '127.0.0.1', port: 0, mdns: false, federationEnabled: false, onLog() {} });
  t.after(async () => {
    await left.close();
    await right.close();
    fs.rmSync(leftDir, { recursive: true, force: true });
    fs.rmSync(rightDir, { recursive: true, force: true });
  });

  const leftEndpoint = `https://127.0.0.1:${left.peerPort}`;
  const rightEndpoint = `https://127.0.0.1:${right.peerPort}`;
  const invitePath = path.join(leftDir, 'transfer.invite');
  await mainPeer(['invite', '--endpoint', leftEndpoint, '--out', invitePath], { stateDir: leftDir });
  assert.match(fs.readFileSync(invitePath, 'utf8'), /^xats-pair-v1:/);

  const pairing = mainPeer(['pair', '--invite-file', invitePath, '--endpoint', rightEndpoint, '--label', 'test-left'], { stateDir: rightDir });
  const pending = await waitForPending(leftDir);
  assert.equal(left.trustStore.get(right.identity.deviceId), null);
  assert.equal(pending.deviceId, right.identity.deviceId);
  await mainPeer(['pending'], { stateDir: leftDir });
  await mainPeer(['approve', pending.pendingId, '--label', 'test-right'], { stateDir: leftDir });
  await pairing;

  assert.equal(right.trustStore.get(left.identity.deviceId).deviceId, left.identity.deviceId);
  assert.equal(left.trustStore.get(right.identity.deviceId).label, 'test-right');
  assert.equal(right.trustStore.get(left.identity.deviceId).label, 'test-left');
  assert.equal(left.status().peers.length, 1);
  assert.equal(right.status().peers.length, 1);

  await mainPeer(['revoke', right.identity.deviceId], { stateDir: leftDir });
  assert.equal(left.trustStore.get(right.identity.deviceId), null);
  assert.equal(left.status().peers.length, 0);
  assert.ok(right.trustStore.get(left.identity.deviceId), 'revocation is enforced by the revoking instance');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderPeerSystemdUnit, renderPeerLaunchAgent, renderPeerWindowsTaskCommand, isPeerServiceEnabled, startPeerService, stopPeerService, PEER_SERVICE_NAME } from '../lib/peer-service.mjs';

test('peer service configurations launch the isolated listener only on explicit service enable', () => {
  const entry = '/home/example/.xats/peer/peer.mjs';
  const node = '/usr/bin/node';
  const unit = renderPeerSystemdUnit(entry, node);
  assert.match(unit, /After=network-online\.target/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /ExecStart="\/usr\/bin\/node" "\/home\/example\/\.xats\/peer\/peer\.mjs" run/);
  assert.match(unit, /WantedBy=default\.target/);

  const plist = renderPeerLaunchAgent('/Users/A&B/.xats/peer/peer.mjs', '/Applications/Node & npm/node');
  assert.match(plist, /com\.xats\.peer/);
  assert.match(plist, /A&amp;B/);
  assert.match(plist, /Node &amp; npm/);
  assert.match(plist, /<string>run<\/string>/);

  assert.equal(renderPeerWindowsTaskCommand('C:\\Users\\A B\\.xats\\peer\\peer.mjs', 'C:\\Program Files\\node.exe'), '"C:\\Program Files\\node.exe" "C:\\Users\\A B\\.xats\\peer\\peer.mjs" run');
  assert.equal(PEER_SERVICE_NAME, 'xats-peer');
});

test('peer autostart remains opt-in until a service marker is present', () => {
  const xatsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xats-peer-service-'));
  try {
    const paths = { xatsRoot };
    assert.equal(isPeerServiceEnabled(paths), false);
    assert.equal(stopPeerService(paths).unmanaged, true);
    assert.throws(() => startPeerService(paths), /autostart is not enabled/);
  } finally { fs.rmSync(xatsRoot, { recursive: true, force: true }); }
});

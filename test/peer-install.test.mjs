import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installPeer } from '../lib/peer.mjs';
import { isPeerServiceEnabled } from '../lib/peer-service.mjs';
import { setDry } from '../lib/log.mjs';

test('peer runtime installation is a dry, opt-in install and still previews pinned dependencies', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xats-peer-install-'));
  const paths = { xatsRoot: path.join(root, '.xats') };
  const messages = [];
  const originalLog = console.log;
  setDry(true);
  console.log = (message) => messages.push(String(message));
  try {
    const result = installPeer(paths);
    assert.equal(result.updated, true);
    assert.equal(isPeerServiceEnabled(paths), false);
    assert.equal(fs.existsSync(result.dir), false, 'dry-run creates no runtime files');
    assert.ok(messages.some((message) => message.includes('npm install --prefix')), 'dependency installation is still included in the plan');
  } finally {
    console.log = originalLog;
    setDry(false);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

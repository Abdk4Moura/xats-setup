import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('reset --only=peer stops the listener, purges shadows, and removes peer state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xats-peer-reset-'));
  const home = path.join(root, 'home');
  const xatsRoot = path.join(home, '.xats');
  const peerDir = path.join(xatsRoot, 'peer');
  const callsFile = path.join(root, 'peer-calls.txt');
  fs.mkdirSync(peerDir, { recursive: true });
  fs.writeFileSync(path.join(peerDir, 'peer.mjs'), "import fs from 'node:fs'; fs.appendFileSync(process.env.XATS_PEER_RESET_CALLS, process.argv[2] + '\\n');\n");
  const script = `import { reset } from ${JSON.stringify(new URL('../lib/reset.mjs', import.meta.url).href)};\nreset({ xatsRoot: ${JSON.stringify(xatsRoot)} }, new Set(['peer']));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: repoRoot,
    env: { ...process.env, HOME: home, XATS_PEER_RESET_CALLS: callsFile },
    encoding: 'utf8',
    timeout: 15_000,
  });
  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.readFileSync(callsFile, 'utf8'), 'stop\nclean-shadows\n');
    assert.equal(fs.existsSync(peerDir), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

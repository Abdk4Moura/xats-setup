import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { daemonLayout, installDaemon, preflightDaemon } from '../lib/daemon.mjs';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const built = fs.existsSync(path.join(repo, 'daemon/dist/cli.js'));
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xats-dependency-safety-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const paths = { xatsRoot: path.join(home, '.xats') };
  const lay = daemonLayout(paths);
  fs.mkdirSync(path.dirname(lay.entry), { recursive: true });
  fs.writeFileSync(path.join(lay.prefix, 'package.json'), '{"name":"old-runtime","dependencies":{}}\n');
  fs.writeFileSync(path.join(lay.pkgDir, 'package.json'), '{"name":"old-daemon"}\n');
  fs.writeFileSync(lay.entry, '// locally edited old build\n');
  return { paths, lay };
}

test('failed dependency install restores prior manifest and CLI, and the next run repairs rather than skips', { skip: !built }, t => {
  const { paths, lay } = fixture(t);
  const manifest = fs.readFileSync(path.join(lay.prefix, 'package.json'));
  const cli = fs.readFileSync(lay.entry);
  let calls = 0;
  assert.throws(() => installDaemon(paths, { npmRunner() {
    calls++;
    fs.rmSync(lay.pkgDir, { recursive: true, force: true });
    return { ok: false, code: 2, stderr: 'simulated offline installation failure' };
  } }), /base install failed/);
  assert.deepEqual(fs.readFileSync(path.join(lay.prefix, 'package.json')), manifest);
  assert.deepEqual(fs.readFileSync(lay.entry), cli);
  assert.ok(fs.existsSync(path.join(lay.prefix, '.runtime-install-pending')));
  assert.equal(preflightDaemon(paths).updated, true);
  const result = installDaemon(paths, { npmRunner() { calls++; return { ok: true }; } });
  assert.equal(calls, 2, 'a failed attempt must not establish a successful installation fingerprint');
  assert.equal(result.existed, true);
  assert.equal(fs.existsSync(path.join(lay.prefix, '.runtime-install-pending')), false);
  const backup = fs.readdirSync(path.dirname(lay.entry)).find(name => name.startsWith('cli.js.xats-backup-'));
  assert.ok(backup, 'customized managed code must have a recoverable backup');
  assert.deepEqual(fs.readFileSync(path.join(path.dirname(lay.entry), backup)), cli);
});

test('successful npm pruning cannot erase evidence that a running daemon build existed', { skip: !built }, t => {
  const { paths, lay } = fixture(t);
  const result = installDaemon(paths, { npmRunner() {
    fs.rmSync(lay.pkgDir, { recursive: true, force: true });
    return { ok: true };
  } });
  assert.equal(result.existed, true, 'restart decisions must use pre-install existence');
  assert.equal(result.updated, true);
  assert.ok(fs.existsSync(lay.entry));
});

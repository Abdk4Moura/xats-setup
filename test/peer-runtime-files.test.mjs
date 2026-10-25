import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const libDir = path.join(root, 'lib');

// The peer runtime is installed as a standalone copy of a subset of lib/. Twice
// now a new module was imported by the runtime but left off this list, and the
// installed runtime died at startup with MODULE_NOT_FOUND — a failure that only
// shows up after install, on someone else's machine. This guard makes it a test.
function runtimeFiles() {
  const source = fs.readFileSync(path.join(libDir, 'peer.mjs'), 'utf8');
  const block = source.match(/RUNTIME_FILES\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(block, 'RUNTIME_FILES not found in lib/peer.mjs');
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test('every module the peer runtime imports is shipped with it', () => {
  const files = runtimeFiles();
  assert.ok(files.length > 5, 'sanity: runtime file list looks empty');

  const missing = [];
  for (const file of files) {
    const source = fs.readFileSync(path.join(libDir, file), 'utf8');
    for (const match of source.matchAll(/from '\.\/([^']+)'/g)) {
      const dep = match[1];
      if (!fs.existsSync(path.join(libDir, dep))) continue;      // node builtin or elsewhere
      if (!files.includes(dep)) missing.push(`${file} -> ${dep}`);
    }
  }
  assert.deepEqual(missing, [], `add to RUNTIME_FILES in lib/peer.mjs: ${missing.join(', ')}`);
});

test('every listed runtime file exists', () => {
  for (const file of runtimeFiles()) {
    assert.ok(fs.existsSync(path.join(libDir, file)), `missing lib/${file}`);
  }
});

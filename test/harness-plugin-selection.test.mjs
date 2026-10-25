import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensurePluginConfig, isOpenCodeV2Version } from '../lib/harness.mjs';

test('detects OpenCode v2 version output', () => {
  assert.equal(isOpenCodeV2Version('opencode v2.0.27'), true);
  assert.equal(isOpenCodeV2Version('2.1.0'), true);
  assert.equal(isOpenCodeV2Version('opencode v1.18.29'), false);
  assert.equal(isOpenCodeV2Version('mimocode v1.0.0'), false);
  assert.equal(isOpenCodeV2Version(''), false);
});

test('moves xats entries into the native OpenCode v2 plugins key', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xats-opencode-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'opencode.json');
  fs.writeFileSync(file, JSON.stringify({
    plugin: ['./plugins/xats-register.ts', './plugins/notify-unified.ts', 'legacy-plugin'],
    plugins: ['native-plugin'],
  }));

  ensurePluginConfig('opencode', root, true);

  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(config.plugin, ['legacy-plugin']);
  assert.deepEqual(config.plugins, [
    'native-plugin', './plugins/xats-register.ts',
  ]);
});

test('opts OpenCode v2 xats tools into Code Mode', () => {
  const source = fs.readFileSync(new URL('../assets/plugins/xats-register-v2.ts', import.meta.url), 'utf8');
  assert.match(source, /options:\s*\{\s*codemode:\s*true\s*\}/);
});

test('preserves the legacy plugin key for OpenCode v1 and Mimocode', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xats-legacy-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'mimocode.json');
  fs.writeFileSync(file, JSON.stringify({ plugins: ['other-plugin'] }));

  ensurePluginConfig('mimocode', root, false);

  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(config.plugins, ['other-plugin']);
  assert.deepEqual(config.plugin, ['./plugins/xats-register.ts']);
});

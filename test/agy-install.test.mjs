import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installAgy } from '../lib/agy.mjs';
import { reset } from '../lib/reset.mjs';

test('installs the Antigravity plugin with the selected daemon port', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xats-agy-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pluginDir = path.join(root, '.gemini', 'config', 'plugins', 'xats');

  installAgy({ agyPlugin: pluginDir }, { port: 9103 });

  const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8'));
  const config = JSON.parse(fs.readFileSync(path.join(pluginDir, 'mcp_config.json'), 'utf8'));
  assert.equal(manifest.name, 'xats');
  assert.equal(config.mcpServers.bus.command, 'npx');
  assert.equal(config.mcpServers.bus.env.XATS_PORT, '9103');
  assert.ok(fs.existsSync(path.join(pluginDir, 'skills', 'xats', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(pluginDir, 'assets', 'xats.svg')));

  reset({ agyPlugin: pluginDir }, new Set(['agy']));
  assert.equal(fs.existsSync(pluginDir), false);
});

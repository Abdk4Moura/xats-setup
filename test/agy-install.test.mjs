import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installAgy } from '../lib/agy.mjs';
import { reset } from '../lib/reset.mjs';
import { setDry } from '../lib/log.mjs';

function snapshot(dir, prefix = '') {
  const result = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name), full = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(result, snapshot(full, relative));
    else result[relative] = { bytes: fs.readFileSync(full).toString('base64'), mode: fs.statSync(full).mode & 0o777 };
  }
  return result;
}

test('installs the Antigravity plugin with the selected daemon port', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xats-agy-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pluginDir = path.join(root, '.gemini', 'config', 'plugins', 'xats');

  const xatsRoot = path.join(root, 'xats');
  installAgy({ agyPlugin: pluginDir, xatsRoot }, { port: 9103 });

  const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8'));
  const config = JSON.parse(fs.readFileSync(path.join(pluginDir, 'mcp_config.json'), 'utf8'));
  assert.equal(manifest.name, 'xats');
  // The plugin runs our local bridge, not a download, so the identity pinning
  // and pane binding ship with the installer.
  assert.equal(config.mcpServers.bus.command, process.execPath);
  assert.equal(config.mcpServers.bus.args[0], path.join(xatsRoot, 'mcp', 'xats-mcp.mjs'));
  assert.ok(fs.existsSync(path.join(xatsRoot, 'mcp', 'identity.mjs')));
  assert.ok(fs.existsSync(path.join(xatsRoot, 'mcp', 'pane.mjs')));
  assert.equal(config.mcpServers.bus.env.XATS_TEAM, 'default');
  assert.match(config.mcpServers.bus.env.XATS_NAME, /^agy-/);
  assert.equal(config.mcpServers.bus.env.XATS_PORT, '9103');
  assert.ok(fs.existsSync(path.join(pluginDir, 'skills', 'xats', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(pluginDir, 'assets', 'xats.svg')));

  reset({ agyPlugin: pluginDir, xatsRoot }, new Set(['agy']));
  assert.equal(fs.existsSync(pluginDir), false);
});

test('Antigravity rerun preserves additions, MCP options, and edited assets without duplicate backups', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xats-agy-rerun-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const pluginDir = path.join(root, 'xats');
  const paths = { agyPlugin: pluginDir, xatsRoot: path.join(root, 'state') };
  installAgy(paths, { port: 9123 });
  const file = path.join(pluginDir, 'mcp_config.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  config.customSentinel = 'keep';
  config.mcpServers.user = { command: 'user-server' };
  config.mcpServers.bus.headers = { 'X-Custom': 'keep' };
  config.mcpServers.bus.env.CUSTOM_SENTINEL = 'keep';
  fs.writeFileSync(file, JSON.stringify(config, null, 4));
  fs.writeFileSync(path.join(pluginDir, 'user-added.txt'), 'keep this file');
  fs.writeFileSync(path.join(pluginDir, 'assets/xats.svg'), 'locally edited icon');
  installAgy(paths, { port: 9123 });
  const result = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(result.customSentinel, 'keep');
  assert.equal(result.mcpServers.user.command, 'user-server');
  assert.equal(result.mcpServers.bus.headers['X-Custom'], 'keep');
  assert.equal(result.mcpServers.bus.env.CUSTOM_SENTINEL, 'keep');
  assert.equal(result.mcpServers.bus.env.XATS_PORT, '9123');
  assert.equal(fs.readFileSync(path.join(pluginDir, 'user-added.txt'), 'utf8'), 'keep this file');
  const backup = fs.readdirSync(path.join(pluginDir, 'assets')).find(name => name.startsWith('xats.svg.xats-backup-'));
  assert.equal(fs.readFileSync(path.join(pluginDir, 'assets', backup), 'utf8'), 'locally edited icon');
  const before = snapshot(root);
  installAgy(paths, { port: 9123 });
  assert.deepEqual(snapshot(root), before, 'same nondefault port must not create a default-port backup round trip');
  setDry(true);
  t.after(() => setDry(false));
  installAgy(paths, { port: 9124 });
  assert.deepEqual(snapshot(root), before);
});

test('malformed Antigravity config stops before plugin files change', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xats-agy-invalid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  fs.writeFileSync(path.join(root, 'mcp_config.json'), '{invalid user settings');
  fs.writeFileSync(path.join(root, 'user-added.txt'), 'keep');
  const before = snapshot(root);
  assert.throws(() => installAgy({ agyPlugin: root, xatsRoot: path.join(root, 'state') }), /invalid JSON/);
  assert.deepEqual(snapshot(root), before);
});

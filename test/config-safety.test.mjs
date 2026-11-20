import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson, readConfigJson, writeConfigFile, writeConfigJson, copyConfigTree, copyFile, setDry } from '../lib/log.mjs';
import { installClaude } from '../lib/claude.mjs';
import { ensurePluginConfig, installOpencode, installHarnesses } from '../lib/harness.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xats-config-safety-'));
  t.after(() => { setDry(false); fs.rmSync(home, { recursive: true, force: true }); });
  const paths = {
    home, xatsRoot: path.join(home, '.xats'), claudeDir: path.join(home, '.claude'),
    claudeSettings: path.join(home, '.claude/settings.json'), claudeJson: path.join(home, '.claude.json'),
    opencodePlugins: path.join(home, 'opencode/plugins'), mimocodePlugins: path.join(home, 'mimocode/plugins'),
  };
  fs.mkdirSync(paths.claudeDir);
  return { home, paths };
}
function snapshot(root) {
  const out = {};
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      out[path.relative(root, file)] = [fs.statSync(file).mode & 0o777, entry.isDirectory() ? null : fs.readFileSync(file).toString('base64')];
      if (entry.isDirectory()) walk(file);
    }
  }
  walk(root);
  return out;
}
function backups(file) {
  return fs.readdirSync(path.dirname(file)).filter(n => n.startsWith(path.basename(file) + '.xats-backup-'));
}

test('ordinary managed-file copies preserve customized bytes and mode in a backup', t => {
  const { home } = fixture(t);
  const source = path.join(home, 'source'), dest = path.join(home, 'extension.ts');
  fs.writeFileSync(source, 'updated managed code');
  fs.writeFileSync(dest, 'user-edited managed code', { mode: 0o640 });
  const mode = fs.statSync(dest).mode & 0o777;
  assert.equal(copyFile(source, dest), true);
  assert.equal(fs.statSync(dest).mode & 0o777, mode);
  assert.equal(backups(dest).length, 1);
  assert.equal(fs.readFileSync(path.join(home, backups(dest)[0]), 'utf8'), 'user-edited managed code');
  assert.equal(copyFile(source, dest), false);
  assert.equal(backups(dest).length, 1);
});

test('strict config reader falls back only on ENOENT and never logs content', t => {
  const { home } = fixture(t);
  const file = path.join(home, 'config.json');
  const fallback = {};
  assert.equal(readConfigJson(file, fallback), fallback);
  for (const raw of ['{SECRET-invalid', 'null', '[]', 'true', '42', '"text"']) {
    fs.writeFileSync(file, raw);
    assert.throws(() => readConfigJson(file, fallback), error => error.message.includes(file) && !error.message.includes(raw));
    assert.deepEqual(readJson(file, fallback), raw === '{SECRET-invalid' ? fallback : JSON.parse(raw));
  }
  assert.throws(() => readConfigJson(home, fallback), /cannot read file/);
});

test('config writes preserve raw bytes, existing modes and private unique backups only on changes', t => {
  const { home } = fixture(t);
  const file = path.join(home, 'config.jsonc');
  const raw = Buffer.from('// custom comment\r\n{ "secret": "private", }\r\n');
  fs.writeFileSync(file, raw, { mode: 0o640 });
  assert.equal(writeConfigJson(file, { secret: 'private' }), true);
  const [backup] = backups(file);
  assert.ok(backup);
  assert.deepEqual(fs.readFileSync(path.join(home, backup)), raw);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(home, backup)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  }
  const before = snapshot(home);
  assert.equal(writeConfigJson(file, { secret: 'private' }), false);
  assert.deepEqual(snapshot(home), before);
  writeConfigFile(file, 'changed');
  assert.equal(backups(file).length, 2);
  const fresh = path.join(home, 'fresh.json');
  const oldMask = process.umask(0o077);
  try { writeConfigJson(fresh, {}); }
  finally { process.umask(oldMask); }
  if (process.platform !== 'win32') assert.equal(fs.statSync(fresh).mode & 0o777, 0o600);
  setDry(true);
  const dryBefore = snapshot(home);
  writeConfigFile(file, 'dry change');
  assert.deepEqual(snapshot(home), dryBefore);
});

test('Claude rejects invalid JSON and known sections before its first owned mutation', t => {
  const { home, paths } = fixture(t);
  const cases = ['{broken', '[]', '{"env":[]}', '{"env":{"CLAUDE_CODE_PLUGIN_DIRS":[]}}', '{"hooks":[]}', '{"hooks":{"SessionStart":{}}}', '{"hooks":{"SessionStart":[{"hooks":[null]}]}}', '{"hooks":{"SessionStart":[{"hooks":[{"command":1}]}]}}'];
  for (const raw of cases) {
    fs.writeFileSync(paths.claudeSettings, raw);
    const before = snapshot(home);
    assert.throws(() => installClaude(paths), /Cannot update config/);
    assert.deepEqual(snapshot(home), before);
  }
  fs.writeFileSync(paths.claudeSettings, '{}');
  for (const raw of ['{broken', 'null', '{"mcpServers":[]}', '{"mcpServers":{"cross-agent-teams":false}}']) {
    fs.writeFileSync(paths.claudeJson, raw);
    const before = snapshot(home);
    assert.throws(() => installClaude(paths), /Cannot update config/);
    assert.deepEqual(snapshot(home), before);
  }
});

test('Claude preserves unrelated settings, hooks, env and custom MCP options across endpoint updates', t => {
  const { home, paths } = fixture(t);
  const hook = { matcher: 'Bash', custom: true, hooks: [{ type: 'command', command: 'echo user' }] };
  fs.writeFileSync(paths.claudeSettings, JSON.stringify({ theme: 'dark', env: { CUSTOM: 'yes', CLAUDE_CODE_PLUGIN_DIRS: '/custom' }, hooks: { SessionStart: [hook], Notification: [] } }));
  fs.writeFileSync(paths.claudeJson, JSON.stringify({ unrelated: 3, mcpServers: { other: { command: 'other' }, 'cross-agent-teams': { type: 'http', url: 'http://old/mcp', headers: { Authorization: 'custom' }, custom: true } } }));
  installClaude(paths, { baseUrl: 'http://localhost:9199' });
  const settings = readConfigJson(paths.claudeSettings);
  assert.equal(settings.theme, 'dark');
  assert.equal(settings.env.CUSTOM, 'yes');
  assert.ok(settings.env.CLAUDE_CODE_PLUGIN_DIRS.startsWith('/custom'));
  assert.deepEqual(settings.hooks.SessionStart[0], hook);
  assert.deepEqual(settings.hooks.Notification, []);
  const cj = readConfigJson(paths.claudeJson);
  assert.deepEqual(cj.mcpServers.other, { command: 'other' });
  assert.equal(cj.unrelated, 3);
  assert.deepEqual(cj.mcpServers['cross-agent-teams'], { type: 'http', url: 'http://localhost:9199/mcp', headers: { Authorization: 'custom' }, custom: true });
  const before = snapshot(home);
  installClaude(paths, { baseUrl: 'http://localhost:9199' });
  assert.deepEqual(snapshot(home), before);
});

test('dry-run does not unlink a stale Claude bind hook', t => {
  const { home, paths } = fixture(t);
  fs.mkdirSync(paths.xatsRoot);
  fs.writeFileSync(path.join(paths.xatsRoot, 'xats-bind-hook.mjs'), 'custom stale hook');
  const before = snapshot(home);
  setDry(true);
  installClaude(paths);
  assert.deepEqual(snapshot(home), before);
});

test('managed directory updates preserve custom additions and recover edited managed files', t => {
  const { home } = fixture(t);
  const source = path.join(home, 'source');
  const dest = path.join(home, 'managed');
  fs.mkdirSync(source);
  fs.mkdirSync(dest);
  fs.writeFileSync(path.join(source, 'plugin.mjs'), 'managed');
  fs.writeFileSync(path.join(dest, 'plugin.mjs'), 'custom edit');
  fs.writeFileSync(path.join(dest, 'custom.txt'), 'addition');
  copyConfigTree(source, dest);
  assert.equal(fs.readFileSync(path.join(dest, 'custom.txt'), 'utf8'), 'addition');
  const [backup] = backups(path.join(dest, 'plugin.mjs'));
  assert.equal(fs.readFileSync(path.join(dest, backup), 'utf8'), 'custom edit');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dest, backup)).mode & 0o777, 0o600);
  const before = snapshot(home);
  copyConfigTree(source, dest);
  assert.deepEqual(snapshot(home), before);
});

test('harness rejects invalid sections and both variants before plugin writes', t => {
  const { home, paths } = fixture(t);
  const root = path.dirname(paths.opencodePlugins);
  fs.mkdirSync(root);
  const file = path.join(root, 'opencode.json');
  for (const raw of ['{broken', '[]', '{"plugin":{}}', '{"plugins":[4]}', '{"mcp":[]}', '{"mcp":{"servers":[]}}', '{"mcp":{"cross-agent-teams":false}}', '{"mcp":{"servers":{"cross-agent-teams":null}}}']) {
    fs.writeFileSync(file, raw);
    const before = snapshot(home);
    assert.throws(() => installOpencode(paths), /Cannot update config/);
    assert.deepEqual(snapshot(home), before);
  }
  fs.writeFileSync(file, '{}');
  fs.writeFileSync(path.join(root, 'opencode.jsonc'), '{invalid');
  const before = snapshot(home);
  assert.throws(() => ensurePluginConfig('opencode', root, true), /Cannot update config/);
  assert.deepEqual(snapshot(home), before);
  fs.unlinkSync(path.join(root, 'opencode.jsonc'));
  fs.mkdirSync(path.dirname(paths.mimocodePlugins));
  fs.writeFileSync(path.join(path.dirname(paths.mimocodePlugins), 'mimocode.json'), '{invalid');
  const bothBefore = snapshot(home);
  assert.throws(() => installHarnesses(paths), /Cannot update config/);
  assert.deepEqual(snapshot(home), bothBefore);
});

test('JSONC rewrite has a private exact raw backup and preserves unrelated harness config', t => {
  const { home } = fixture(t);
  const file = path.join(home, 'opencode.jsonc');
  const raw = '// Keep this comment\r\n{ "theme": "custom,}", "plugin": ["other",], "mcp": { "other": { "url": "http://other" } }, }\r\n';
  fs.writeFileSync(file, raw);
  ensurePluginConfig('opencode', home, true);
  const [backup] = backups(file);
  assert.equal(fs.readFileSync(path.join(home, backup), 'utf8'), raw);
  const config = readConfigJson(file);
  assert.equal(config.theme, 'custom,}');
  assert.deepEqual(config.plugin, ['other']);
  assert.deepEqual(config.mcp.other, { url: 'http://other' });
  const before = snapshot(home);
  ensurePluginConfig('opencode', home, true);
  assert.deepEqual(snapshot(home), before);
});

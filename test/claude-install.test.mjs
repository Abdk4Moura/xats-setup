import test from 'node:test';
import assert from 'node:assert/strict';
import { ensurePluginDir } from '../lib/claude.mjs';

const MOD = 'C:\\Users\\me\\.xats\\claude-mod';

test('adds the mod directory to an empty CLAUDE_CODE_PLUGIN_DIRS', () => {
  const settings = {};
  assert.equal(ensurePluginDir(settings, MOD, ';'), 'added');
  assert.equal(settings.env.CLAUDE_CODE_PLUGIN_DIRS, MOD);
});

test('joins with the Windows separator without eating other plugin dirs', () => {
  const settings = { env: { CLAUDE_CODE_PLUGIN_DIRS: 'C:\\other\\plugin' } };
  assert.equal(ensurePluginDir(settings, MOD, ';'), 'added');
  assert.equal(settings.env.CLAUDE_CODE_PLUGIN_DIRS, `C:\\other\\plugin;${MOD}`);
});

test('joins with the POSIX separator on unix', () => {
  const settings = { env: { CLAUDE_CODE_PLUGIN_DIRS: '/opt/other' } };
  assert.equal(ensurePluginDir(settings, '/home/me/.xats/claude-mod', ':'), 'added');
  assert.equal(settings.env.CLAUDE_CODE_PLUGIN_DIRS, '/opt/other:/home/me/.xats/claude-mod');
});

test('is idempotent so re-installs do not duplicate the entry', () => {
  const settings = { env: { CLAUDE_CODE_PLUGIN_DIRS: MOD } };
  assert.equal(ensurePluginDir(settings, MOD, ';'), 'present');
  assert.equal(settings.env.CLAUDE_CODE_PLUGIN_DIRS, MOD);
});

test('tolerates an empty or padded value', () => {
  const settings = { env: { CLAUDE_CODE_PLUGIN_DIRS: '  ;;  ' } };
  assert.equal(ensurePluginDir(settings, MOD, ';'), 'added');
  assert.equal(settings.env.CLAUDE_CODE_PLUGIN_DIRS, MOD);
});

test('MCP entries follow the discovered port, not the 9100 default', async (t) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { installClaude } = await import('../lib/claude.mjs');

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xats-claude-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.xats'), { recursive: true });

  const paths = {
    home,
    xatsRoot: path.join(home, '.xats'),
    claudeDir: path.join(home, '.claude'),
    claudeSettings: path.join(home, '.claude', 'settings.json'),
    claudeJson: path.join(home, '.claude.json'),
  };

  // A box whose daemon is not on the default port (like dgmfa on 9102).
  installClaude(paths, { baseUrl: 'http://127.0.0.1:9102' });

  const claudeJson = JSON.parse(fs.readFileSync(paths.claudeJson, 'utf8'));
  assert.equal(claudeJson.mcpServers['cross-agent-teams'].url, 'http://127.0.0.1:9102/mcp');
});

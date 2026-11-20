#!/usr/bin/env node
// Exercise the shipped npm bin, not an import of the source installer. No
// daemon, service, model call, credentials, or peer listener is started.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'xats-packed-smoke-'));
const home = path.join(scratch, 'home');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const components = 'claude,codex,pi,omp,opencode,mimocode,agy,bridge';
function execute(command, args, env = process.env, label = args[0]) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    // npm.cmd requires cmd.exe. Quote every argument, including the tarball
    // path, because Windows runner temp directories can contain spaces.
    const windows = process.platform === 'win32';
    if (windows) assert.ok(args.every(arg => !/["\r\n%]/.test(arg)), 'unsafe cmd.exe argument');
    const child = spawn(command, windows ? args.map(arg => `"${arg}"`) : args, { cwd: repo, env, shell: windows, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let stdout = '', pendingOut = '', pendingErr = '';
    const progress = line => console.log(`[packed-smoke] ${label} +${((Date.now() - started) / 1000).toFixed(2)}s ${line.trim()}`);
    child.stdout.on('data', b => {
      output += b; stdout += b; pendingOut += b;
      const lines = pendingOut.split('\n'); pendingOut = lines.pop();
      for (const line of lines) if (/^(==>|\s+xats-setup v)/.test(line)) progress(line);
    });
    child.stderr.on('data', b => {
      output += b; pendingErr += b;
      const lines = pendingErr.split('\n'); pendingErr = lines.pop();
      for (const line of lines) if (/^npm (http|timing (command:exec|reify|idealTree|npm)\b)/.test(line)) progress(line);
    });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`command timed out: ${command}`)); }, 180000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => {
      clearTimeout(timer);
      console.log(`[packed-smoke] ${label}: ${((Date.now() - started) / 1000).toFixed(2)}s (exit ${code})`);
      code === 0 ? resolve(stdout) : reject(new Error(`${command} exited ${code}\n${output.slice(-5000)}`));
    });
  });
}
function seed(relative, text) {
  const file = path.join(home, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function json(relative) { return JSON.parse(fs.readFileSync(path.join(home, relative), 'utf8')); }
function snapshot(dir, prefix = '') {
  const files = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(files, snapshot(full, relative));
    else if (entry.isFile()) files[relative] = { bytes: fs.readFileSync(full).toString('base64'), mode: fs.statSync(full).mode & 0o777 };
    else files[relative] = { link: fs.readlinkSync(full) };
  }
  return files;
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

try {
  const npmCache = (await execute(npm, ['config', 'get', 'cache'])).trim();
  const packed = JSON.parse(await execute(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch]));
  assert.equal(packed.length, 1);
  const tarball = path.join(scratch, packed[0].filename);
  const required = ['install.mjs', 'lib/agy.mjs', 'assets/agy/plugin.json', 'assets/claude/mod/hooks/register.js', 'daemon/dist/cli.js'];
  for (const name of required) assert.ok(packed[0].files.some(file => file.path === name), `npm package missing ${name}`);
  assert.ok(!packed[0].files.some(file => /(?:^|\/)node_modules\//.test(file.path)), 'npm package must not ship developer dependencies');

  const daemonPort = await freePort();
  seed('.claude/settings.json', JSON.stringify({ env: { CUSTOM_SENTINEL: 'keep' }, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo user-hook' }] }] } }));
  seed('.claude.json', JSON.stringify({ customSentinel: 'keep', mcpServers: { unrelated: { command: 'user-server' }, 'cross-agent-teams': { type: 'http', url: 'http://127.0.0.1:1/mcp', headers: { 'X-Custom': 'keep' } } } }));
  seed('.codex/hooks.json', JSON.stringify({ customSentinel: 'keep', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo codex-user-hook' }] }] } }));
  seed('.codex/config.toml', `# user comment\nmodel = "user-model"\n\n[mcp_servers.cross-agent-teams]\nurl = "http://127.0.0.1:${daemonPort}/mcp"\nhttp_headers = { "X-Custom" = "keep" }\n`);
  seed('.config/opencode/opencode.jsonc', '// user comment\n{"customSentinel":"keep","plugins":["user-plugin"]}\n');
  seed('.config/mimocode/mimocode.json', JSON.stringify({ customSentinel: 'keep', plugin: ['user-plugin'] }));
  seed('.pi/agent/extensions/user-extension.ts', '// user-owned extension\n');
  seed('.omp/agent/extensions/user-extension.ts', '// user-owned extension\n');
  seed('.xats/bridge/peers.json', '{"peers":[{"name":"user-peer","bridge_host":"example.invalid","bridge_port":9101}]}\n');
  seed('.xats/peer/identity.json', 'user-owned-peer-identity\n');
  seed('.xats/peer/tls-identity.json', 'user-owned-tls-identity\n');
  seed('.cross-agent-teams-mcp/data.db', 'user-owned-mailbox-sentinel\n');
  seed('.xats/xats-bind-hook.mjs', '// obsolete hook remains during dry-run\n');
  seed('.xats/port', `${daemonPort}\n`);
  const originals = snapshot(home);
  const untouched = ['.codex/config.toml', '.pi/agent/extensions/user-extension.ts', '.omp/agent/extensions/user-extension.ts', '.xats/bridge/peers.json', '.xats/peer/identity.json', '.xats/peer/tls-identity.json', '.cross-agent-teams-mcp/data.db', '.xats/port'];
  // Do not pass real host config overrides, provider tokens, or npm credentials
  // into the executable under test. Keep only executable/OS plumbing.
  const plumbing = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  const env = { ...plumbing, NODE_OPTIONS: '--max-old-space-size=256', HOME: home, USERPROFILE: home, CROSS_AGENT_TEAMS_MCP_HOME: path.join(home, '.cross-agent-teams-mcp'), XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'), XDG_STATE_HOME: path.join(home, '.local/state'), XDG_CACHE_HOME: path.join(home, '.cache'), npm_config_cache: npmCache, npm_config_loglevel: 'http', npm_config_timing: 'true', npm_config_userconfig: path.join(home, '.npmrc'), npm_config_globalconfig: path.join(home, 'global.npmrc'), CI: '1', XATS_OPENCODE_V2: '1' };
  delete env.XATS_BASE;
  delete env.XATS_BASE_URL;
  delete env.XATS_PORT;
  delete env.XATS_LABEL;
  const args = ['exec', '--yes', '--prefer-offline', `--package=${tarball}`, '--', 'xats-setup', `--only=${components}`, '--yes', '--no-ephemeral', '--label', 'packed-smoke'];

  await execute(npm, [...args, '--dry-run'], env, 'initial dry-run');
  assert.deepEqual(snapshot(home), originals, 'dry-run must not change preconfigured home, including file modes');
  await execute(npm, args, env, 'first install');
  for (const name of ['.pi/agent/extensions/xats.ts', '.omp/agent/extensions/xats.ts', '.config/opencode/plugins/xats-register.ts', '.gemini/config/plugins/xats/plugin.json', '.gemini/config/plugins/xats/skills/xats/SKILL.md']) assert.ok(fs.existsSync(path.join(home, name)), `installed bin missing ${name}`);
  assert.equal(json('.claude/settings.json').env.CUSTOM_SENTINEL, 'keep');
  assert.ok(json('.claude/settings.json').hooks.SessionStart.some(group => group.hooks.some(hook => hook.command === 'echo user-hook')));
  assert.equal(json('.claude.json').customSentinel, 'keep');
  assert.equal(json('.claude.json').mcpServers.unrelated.command, 'user-server');
  assert.equal(json('.claude.json').mcpServers['cross-agent-teams'].headers['X-Custom'], 'keep');
  assert.equal(json('.codex/hooks.json').customSentinel, 'keep');
  const openCode = json('.config/opencode/opencode.jsonc');
  assert.equal(openCode.customSentinel, 'keep');
  assert.ok(openCode.plugins.includes('user-plugin'));
  assert.ok(openCode.plugins.includes('./plugins/xats-register.ts'), 'forced v2 must actually install into the native plugins key');
  assert.match(fs.readFileSync(path.join(home, '.config/opencode/plugins/xats-register.ts'), 'utf8'), /@opencode\/plugin/, 'forced v2 must copy the native adapter, not the legacy API');
  assert.ok(json('.config/mimocode/mimocode.json').plugin.includes('user-plugin'));
  assert.equal(json('.gemini/config/plugins/xats/mcp_config.json').mcpServers.bus.env.XATS_PORT, fs.readFileSync(path.join(home, '.xats/port'), 'utf8').trim());
  const first = snapshot(home);
  for (const name of untouched) assert.deepEqual(first[path.normalize(name)], originals[path.normalize(name)], `installation altered ${name}`);
  const commentBackup = fs.readdirSync(path.join(home, '.config/opencode')).filter(name => name.startsWith('opencode.jsonc.') && name !== 'opencode.jsonc');
  assert.ok(commentBackup.some(name => fs.readFileSync(path.join(home, '.config/opencode', name), 'utf8').includes('// user comment')), 'original JSONC comments must have a recoverable backup');

  await execute(npm, args, env, 'repeat install');
  const second = snapshot(home);
  // The install manifest intentionally records each completed run's timestamp.
  delete first[path.normalize('.xats/manifest.json')];
  delete second[path.normalize('.xats/manifest.json')];
  assert.deepEqual(second, first, 'identical rerun must preserve contents and avoid accumulating backups');
  const beforeDry = snapshot(home);
  await execute(npm, [...args, '--dry-run'], env, 'upgrade dry-run');
  assert.deepEqual(snapshot(home), beforeDry, 'upgrade dry-run changed existing files');
  console.log(`Packed npm-bin install, rerun, dry-run, and preservation passed (${process.platform}/${process.arch}).`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

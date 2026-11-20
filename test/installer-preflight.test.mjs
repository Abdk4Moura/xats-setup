import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DAEMON_PKG, SERVICE_NAME } from '../lib/constants.mjs';
import { which } from '../lib/platform.mjs';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const built = fs.existsSync(path.join(repo, 'daemon/dist/cli.js'));
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function snapshot(root, prefix = '') {
  const files = {};
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const name = path.join(prefix, entry.name), full = path.join(root, entry.name);
    if (entry.isDirectory()) Object.assign(files, snapshot(full, name));
    else files[name] = { data: fs.readFileSync(full).toString('base64'), mode: fs.statSync(full).mode & 0o777 };
  }
  return files;
}
async function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xats-global-preflight-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const runtime = path.join(home, '.xats/daemon/node_modules', DAEMON_PKG);
  fs.mkdirSync(path.join(runtime, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(runtime, 'package.json'), '{"name":"existing-runtime"}\n');
  fs.writeFileSync(path.join(runtime, 'dist/cli.js'), '// existing daemon must not change\n');
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'daemon/package.json'), 'utf8'));
  fs.writeFileSync(path.join(home, '.xats/daemon/package.json'), JSON.stringify({ name: 'xats-daemon-host', private: true, dependencies: pkg.dependencies ?? {} }, null, 2) + '\n');
  fs.writeFileSync(path.join(home, '.xats/port'), `${await freePort()}\n`);
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude/settings.json'), '{}\n');
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), CROSS_AGENT_TEAMS_MCP_HOME: path.join(home, '.cross-agent-teams-mcp'), CI: '1', npm_config_offline: 'true', npm_config_ignore_scripts: 'true', npm_config_cache: path.join(home, '.npm-cache') };
  const run = (args, fakeUser = false) => spawnSync(process.execPath, fakeUser
    ? ['--input-type=module', '-e', `process.getuid=()=>1000; process.argv=[process.execPath,${JSON.stringify(path.join(repo, 'install.mjs'))},...${JSON.stringify(args)}]; await import(${JSON.stringify(new URL('../install.mjs', import.meta.url).href)});`]
    : [path.join(repo, 'install.mjs'), ...args], { cwd: repo, timeout: 25000, encoding: 'utf8', env });
  return { home, run };
}

test('invalid selected host config aborts before daemon files or saved port change', { skip: !built, timeout: 30000 }, async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.home, '.claude/settings.json'), '{malformed private user settings');
  const before = snapshot(f.home);
  const result = f.run(['--only=daemon,claude', '--yes', '--no-ephemeral']);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /invalid JSON/);
  assert.deepEqual(snapshot(f.home), before, 'validate every selected config before any installation mutation');
});

for (const [component, relative] of [['agy', '.gemini/config/plugins/xats/mcp_config.json'], ['mimocode', '.config/mimocode/mimocode.json']]) {
  test(`invalid last-selected ${component} config prevents all earlier component writes`, { skip: !built, timeout: 30000 }, async t => {
    const f = await fixture(t);
    const file = path.join(f.home, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{invalid selected config');
    const before = snapshot(f.home);
    const result = f.run([`--only=daemon,claude,${component}`, '--yes', '--no-ephemeral']);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /invalid JSON|Cannot update config/);
    assert.deepEqual(snapshot(f.home), before);
  });
}

test('custom supervisor rejection happens before daemon or earlier agent files change', { skip: !built || process.platform !== 'linux' || !which('systemctl'), timeout: 30000 }, async t => {
  const f = await fixture(t);
  const units = path.join(f.home, '.config/systemd/user');
  fs.mkdirSync(units, { recursive: true });
  fs.writeFileSync(path.join(units, `${SERVICE_NAME}.service`), '[Service]\nEnvironment=CUSTOM=keep\nExecStart=/custom/supervisor\n');
  const before = snapshot(f.home);
  const result = f.run(['--only=daemon,service,claude', '--yes', '--no-ephemeral'], true);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /definition differs|preserved/i);
  assert.deepEqual(snapshot(f.home), before, 'custom supervisor must fail during the read-only phase');
});

test('ordinary rerun refuses a tracked downgrade without changing installation files', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.home, '.xats/manifest.json'), '{"version":"99.0.0","components":["agy"]}\n');
  const before = snapshot(f.home);
  const result = f.run(['--only=agy', '--yes', '--no-ephemeral']);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /--allow-downgrade/);
  assert.deepEqual(snapshot(f.home), before);
});

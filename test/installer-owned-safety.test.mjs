import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { once } from 'node:events';

const root = path.resolve(import.meta.dirname, '..');
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xats-owned-safety-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  const calls = path.join(home, 'calls');
  const put = (name, data, mode = 0o640) => {
    const file = path.join(home, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data, { mode });
    return file;
  };
  for (const name of ['codex', 'systemctl', 'npm', 'launchctl', 'schtasks', 'netsh']) {
    const script = process.platform === 'win32' ? `${name}.mjs` : name;
    put(`bin/${script}`, `#!${process.execPath}\nimport fs from 'node:fs';\nfs.appendFileSync(process.env.CALLS, JSON.stringify(process.argv.slice(1))+'\\n');\nif (process.argv.includes('list')) console.log(process.env.MCP_LIST || '[]');\nif (process.argv.includes('add')) {\n const f=process.env.HOME+'/.codex/config.toml';\n const backups=fs.readdirSync(process.env.HOME+'/.codex').filter(n=>n.includes('config.toml.xats-backup-'));\n if (fs.existsSync(f) && !backups.length) process.exit(99);\n fs.writeFileSync(f, 'native-changed');\n if(process.env.FAIL_ADD) { fs.chmodSync(f,0o600); process.exit(2); }\n}\n`, 0o755);
    if (process.platform === 'win32') put(`bin/${name}.cmd`, `@"${process.execPath}" "%~dp0${script}" %*\r\n`, 0o755);
  }
  function run(code, env = {}) {
    return spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      cwd: root, encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), CROSS_AGENT_TEAMS_MCP_HOME: path.join(home, '.state'), PATH: bin, CALLS: calls, ...env },
    });
  }
  return { home, bin, calls, put, run };
}
const setup = `import fs from 'node:fs'; import {paths} from './lib/platform.mjs'; import {setDry} from './lib/log.mjs'; const p=paths();`;
function snapshot(dir) {
  const result = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name), s = fs.lstatSync(file);
    result[name] = { mode: s.mode, ino: s.ino, data: s.isDirectory() ? snapshot(file) : fs.readFileSync(file).toString('base64') };
  }
  return result;
}

test('dry install and reset preserve contents, modes, identities and run no commands', t => {
  const f = fixture(t);
  f.put('.codex/config.toml', '# private settings\nmodel="custom"\n');
  f.put('.codex/hooks.json', '{"custom":true,"hooks":{"SessionStart":[{"hooks":[{"command":"other"}]}]}}');
  f.put('.xats/peer/identity.json', '{"private":"retained"}');
  fs.chmodSync(path.join(f.home, '.xats/peer'), 0o755);
  f.put('.xats/peer/peer.mjs', 'process.exit(88)');
  f.put('.xats/peer/service.json', '{"version":1,"kind":"systemd-user"}');
  f.put('.config/systemd/user/xats-peer.service', 'custom unit');
  f.put('.claude/settings.json', '{"hooks":{"SessionStart":[{"hooks":[{"command":"xats-hook start"}]}],"SessionEnd":[{"hooks":[{"command":"xats-hook end"}]}]}}');
  const before = snapshot(f.home);
  const r = f.run(`${setup} setDry(true); const {installCodex}=await import('./lib/codex.mjs'); const {installPeer}=await import('./lib/peer.mjs'); const {reset}=await import('./lib/reset.mjs'); installCodex(p); installPeer(p); reset(p,new Set(['codex','claude','peer','service']));`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(snapshot(f.home), before);
  assert.equal(fs.existsSync(f.calls), false);
});

test('wrong URL cannot match unrelated server and existing MCP is never removed', t => {
  const f = fixture(t);
  const file = f.put('.codex/config.toml', '# auth and options\n');
  const before = snapshot(path.dirname(file));
  const r = f.run(`${setup} const {installCodex}=await import('./lib/codex.mjs'); installCodex(p);`, {
    MCP_LIST: JSON.stringify([{ name: 'cross-agent-teams', transport: { url: 'http://old/mcp' } }, { name: 'unrelated', transport: { url: 'http://127.0.0.1:9100/mcp' } }]),
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /manual-update-required/);
  assert.deepEqual(snapshot(path.dirname(file)), before);
  assert.doesNotMatch(fs.readFileSync(f.calls, 'utf8'), /"add"|"remove"/);
  assert.equal(fs.existsSync(path.join(f.home, '.xats')), false);
});

test('fresh native add backs up raw config first and failed add restores bytes and mode', t => {
  const f = fixture(t);
  const raw = '# preserve comments\nmodel="custom"\n';
  const file = f.put('.codex/config.toml', raw);
  const beforeMode = fs.statSync(file).mode & 0o777;
  const r = f.run(`${setup} const {installCodex}=await import('./lib/codex.mjs'); installCodex(p);`, { FAIL_ADD: '1' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /previous config restored/);
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
  assert.equal(fs.statSync(file).mode & 0o777, beforeMode);
  const backups = fs.readdirSync(path.dirname(file)).filter(n => n.includes('.xats-backup-'));
  assert.ok(backups.some(n => fs.readFileSync(path.join(path.dirname(file), n), 'utf8') === raw));
  if (process.platform !== 'win32') for (const name of backups) assert.equal(fs.statSync(path.join(path.dirname(file), name)).mode & 0o777, 0o600);
});

test('strict reads prevent earlier install/reset mutations', t => {
  const f = fixture(t);
  f.put('.codex/hooks.json', '{invalid');
  let before = snapshot(f.home);
  let r = f.run(`${setup} const {installCodex}=await import('./lib/codex.mjs'); installCodex(p);`);
  assert.notEqual(r.status, 0);
  assert.deepEqual(snapshot(f.home), before);
  f.put('.claude/settings.json', '{}');
  f.put('.claude.json', '{broken');
  before = snapshot(f.home);
  r = f.run(`${setup} const {reset}=await import('./lib/reset.mjs'); reset(p,new Set(['claude','peer','service']));`);
  assert.notEqual(r.status, 0);
  assert.deepEqual(snapshot(f.home), before);
});

test('reset never signals an unrelated process referenced by a stale PID file', { timeout: 20000 }, async t => {
  const f = fixture(t);
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  await once(child, 'spawn');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
  });
  f.put('.state/daemon.pid', JSON.stringify({ pid: child.pid, port: 12345 }));
  // A fake user scope and recording supervisor prevent touching /etc or a real
  // service; only the deliberately unrelated child is used as PID evidence.
  const r = f.run(`process.getuid=()=>1000; const {paths}=await import('./lib/platform.mjs'); const {reset}=await import('./lib/reset.mjs'); reset(paths(),new Set(['service']));`);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotThrow(() => process.kill(child.pid, 0));
  assert.match(r.stdout, /Unverified daemon PID was not signalled/);
});

test('invalid Claude hook structure stops reset before peer removal', t => {
  const f = fixture(t);
  f.put('.claude/settings.json', '{"hooks":{"SessionStart":"not-an-array"}}');
  f.put('.xats/peer/identity.json', '{"private":"must remain"}');
  const before = snapshot(f.home);
  const r = f.run(`${setup} const {reset}=await import('./lib/reset.mjs'); reset(p,new Set(['claude','peer']));`);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /invalid hook groups structure/);
  assert.deepEqual(snapshot(f.home), before);
});

test('Claude reset removes both owned hooks, backs up raw JSON and preserves unrelated keys', t => {
  const f = fixture(t);
  const raw = JSON.stringify({ custom: 7, hooks: {
    SessionStart: [{ hooks: [{ command: 'xats-hook start' }, { command: 'other start' }] }],
    SessionEnd: [{ hooks: [{ command: 'xats-hook end' }, { command: 'other end' }] }],
  } });
  const file = f.put('.claude/settings.json', raw);
  const mcp = f.put('.claude.json', '{"mcpServers":{"custom":{"url":"https://custom"}}}');
  const r = f.run(`${setup} const {reset}=await import('./lib/reset.mjs'); reset(p,new Set(['claude']));`);
  assert.equal(r.status, 0, r.stderr);
  const result = JSON.parse(fs.readFileSync(file));
  assert.equal(result.custom, 7);
  assert.deepEqual(result.hooks.SessionStart[0].hooks, [{ command: 'other start' }]);
  assert.deepEqual(result.hooks.SessionEnd[0].hooks, [{ command: 'other end' }]);
  assert.equal(fs.readFileSync(mcp, 'utf8'), '{"mcpServers":{"custom":{"url":"https://custom"}}}');
  const backup = fs.readdirSync(path.dirname(file)).find(n => n.includes('.xats-backup-'));
  assert.equal(fs.readFileSync(path.join(path.dirname(file), backup), 'utf8'), raw);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { pickPort, ownedDaemon, portFile, writePort, readPort, paths as getPaths } from '../lib/platform.mjs';
import { ensureDaemon, preserveDefinition } from '../lib/service.mjs';
import { installDaemon, daemonLayout } from '../lib/daemon.mjs';
import { nativeProcessProof } from '../lib/process-proof.mjs';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function files(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xats-port-safety-'));
  const paths = { home, xatsRoot: path.join(home, '.xats'), daemonState: path.join(home, '.state') };
  fs.mkdirSync(paths.xatsRoot); fs.mkdirSync(paths.daemonState);
  const { entry } = daemonLayout(paths);
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(entry), '../package.json'), '{"type":"module"}');
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return { paths, entry };
}
async function listener(t) {
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return server.address().port;
}
const processSource = `import http from 'node:http'; import fs from 'node:fs';
const arg=k=>process.argv[process.argv.indexOf(k)+1];
const server=http.createServer((q,r)=>{r.setHeader('content-type','application/json');r.end('{"ok":true}');});
server.listen(Number(arg('--port')),'127.0.0.1',()=>{fs.writeFileSync(arg('--pid-file'),JSON.stringify({pid:process.pid,port:server.address().port}));console.log('ready');});
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
`;
async function ownProcess(t) {
  const f = files(t);
  fs.writeFileSync(f.entry, processSource);
  const child = spawn(process.execPath, [f.entry, 'daemon', '--port', '0', '--db', path.join(f.paths.daemonState, 'data.db'), '--pid-file', path.join(f.paths.daemonState, 'daemon.pid')], { env: { ...process.env, HOME: f.paths.home, USERPROFILE: f.paths.home }, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = ''; child.stderr.on('data', b => { errors += b; });
  await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error(errors || 'fixture exited'); })]);
  const info = JSON.parse(fs.readFileSync(path.join(f.paths.daemonState, 'daemon.pid'), 'utf8'));
  writePort(f.paths, info.port);
  t.after(async () => {
    const latest = ownedDaemon(f.paths, info.port, f.entry);
    if (latest) { try { process.kill(latest.pid, 'SIGTERM'); } catch {} }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(); await once(child, 'exit');
    }
  });
  return { ...f, child, port: info.port };
}

test('configured daemon state home is retained rather than redirected to a new mailbox', t => {
  const f = files(t);
  const old = process.env.CROSS_AGENT_TEAMS_MCP_HOME;
  t.after(() => { if (old === undefined) delete process.env.CROSS_AGENT_TEAMS_MCP_HOME; else process.env.CROSS_AGENT_TEAMS_MCP_HOME = old; });
  process.env.CROSS_AGENT_TEAMS_MCP_HOME = f.paths.daemonState;
  assert.equal(getPaths().daemonState, f.paths.daemonState);
});

test('explicit null remains the historical default for readPort callers', t => {
  const f = files(t);
  assert.equal(readPort(f.paths, null), 9100);
});

test('fresh setup skips an unrelated occupied candidate instead of treating it as a saved port', async t => {
  const f = files(t);
  const busy = await listener(t);
  assert.equal(await pickPort(f.paths, [busy, 0]), 0);
  assert.equal(fs.existsSync(portFile(f.paths)), false);
});

test('saved unhealthy or unverified port is never silently moved, even for ok:true', async t => {
  const f = files(t);
  const port = await listener(t);
  writePort(f.paths, port);
  const before = fs.readFileSync(portFile(f.paths));
  await assert.rejects(pickPort(f.paths, [port, 0]), /unverified|unhealthy|occupied/i);
  assert.deepEqual(fs.readFileSync(portFile(f.paths)), before);
});

test('malformed saved port fails closed and leaves the file unchanged', async t => {
  const f = files(t);
  fs.writeFileSync(portFile(f.paths), 'invalid saved port\n');
  await assert.rejects(pickPort(f.paths, [0]), /invalid|saved port/i);
  assert.equal(fs.readFileSync(portFile(f.paths), 'utf8'), 'invalid saved port\n');
});

test('native process/socket ownership keeps a healthy nondefault port and unchanged daemon PID', { timeout: 60000 }, async t => {
  const f = await ownProcess(t);
  const own = ownedDaemon(f.paths, f.port);
  if (!own && process.platform === 'win32') {
    // Fixture-only diagnostics: never print real user-process command lines.
    try { t.diagnostic(JSON.stringify({ fixtureNativeProof: nativeProcessProof(f.child.pid, f.port) })); }
    catch (error) { t.diagnostic(JSON.stringify({ probeError: error.code || error.name, signal: error.signal, status: error.status })); }
  }
  assert.equal(own?.pid, f.child.pid, 'native OS probe must establish the actual child identity');
  assert.equal(await pickPort(f.paths, [0]), f.port);
  const same = await ensureDaemon(f.paths, f.entry, f.port, false);
  assert.equal(same.pid, f.child.pid, 'unchanged rerun must not bounce the daemon');
});

test('a stale PID for a different process cannot authorize port reuse', async t => {
  const f = files(t);
  const port = await listener(t);
  writePort(f.paths, port);
  fs.writeFileSync(path.join(f.paths.daemonState, 'daemon.pid'), JSON.stringify({ pid: process.pid, port }));
  assert.equal(ownedDaemon(f.paths, port), null);
  await assert.rejects(pickPort(f.paths, [0]), /unverified|unhealthy|occupied/i);
});

test('custom service definitions are preserved; known legacy replacement is backed up once', t => {
  const f = files(t);
  const file = path.join(f.paths.home, 'service');
  fs.writeFileSync(file, 'custom environment and startup');
  assert.throws(() => preserveDefinition(file, 'new', 'legacy'), /preserved/i);
  assert.equal(fs.readFileSync(file, 'utf8'), 'custom environment and startup');
  fs.writeFileSync(file, 'legacy');
  assert.equal(preserveDefinition(file, 'new', 'legacy'), true);
  const backups = fs.readdirSync(f.paths.home).filter(n => n.startsWith('service.backup-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(f.paths.home, backups[0]), 'utf8'), 'legacy');
  assert.equal(preserveDefinition(file, 'new', 'legacy'), false);
  assert.equal(fs.readdirSync(f.paths.home).filter(n => n.startsWith('service.backup-')).length, 1);
});

test('daemon updated flag reports changed code once without reinstalling identical dependencies', { skip: !fs.existsSync(path.join(repo, 'daemon/dist/cli.js')) }, t => {
  const f = files(t);
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'daemon/package.json'), 'utf8'));
  const prefix = path.join(f.paths.xatsRoot, 'daemon');
  fs.writeFileSync(path.join(prefix, 'package.json'), JSON.stringify({ name: 'xats-daemon-host', private: true, dependencies: pkg.dependencies ?? {} }, null, 2) + '\n');
  fs.writeFileSync(f.entry, '// outdated managed build\n');
  const npmRunner = () => { throw new Error('Unexpected dependency install in an offline unit test'); };
  const first = installDaemon(f.paths, { npmRunner });
  assert.equal(first.updated, true);
  assert.equal(first.existed, true);
  assert.equal(installDaemon(f.paths, { npmRunner }).updated, false);
});

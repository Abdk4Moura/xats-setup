#!/usr/bin/env node
// Native schema and mod-kit tests only: no login, prompt, plugin installation,
// service, or live agent messaging. Tools never inherit the user's credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pins = JSON.parse(fs.readFileSync(path.join(repo, 'scripts/ci-host-versions.json'), 'utf8'));
assert.equal(process.platform, 'linux', 'Native contract provisioning currently supports Linux x64 only');
assert.equal(process.arch, 'x64');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'xats-host-contracts-'));
const tools = path.resolve(process.env.XATS_CI_HOST_TOOLS || path.join(scratch, 'tools'));
const home = path.join(scratch, 'home');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(tools, { recursive: true });
// Deliberate allowlist, not a copy of process.env. In particular, no API keys,
// account tokens, NODE_OPTIONS, host-specific config paths, or npm credentials.
const env = {
  PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
  HOME: home, USERPROFILE: home,
  XDG_CONFIG_HOME: path.join(home, '.config'),
  XDG_DATA_HOME: path.join(home, '.local/share'),
  XDG_STATE_HOME: path.join(home, '.local/state'),
  XDG_CACHE_HOME: path.join(home, '.cache'),
  TMPDIR: scratch, CI: '1', NO_COLOR: '1',
  DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  npm_config_userconfig: path.join(home, '.npmrc'),
  npm_config_globalconfig: path.join(home, 'global.npmrc'),
  npm_config_cache: path.join(scratch, 'npm-cache'),
};
function run(command, args) {
  const result = spawnSync(command, args, { cwd: repo, env, encoding: 'utf8', timeout: 240000, maxBuffer: 16 * 1024 * 1024 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(' ')} exited ${result.status}`);
  return result.stdout;
}
function assertVersion(binary, version) {
  const actual = run(binary, ['--version']).trim();
  assert.match(actual, new RegExp(`(?:^|\\s)${version.replaceAll('.', '\\.')}($|\\s)`), `Expected pinned version ${version}, got ${actual}`);
}
try {
  const prefix = path.join(tools, `claude-${pins.claude.version}`);
  const claude = path.join(prefix, 'node_modules/.bin/claude');
  const ready = path.join(prefix, '.xats-native-ready');
  if (!fs.existsSync(claude) || !fs.existsSync(ready)) {
    run('npm', ['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', `${pins.claude.npmPackage}@${pins.claude.version}`]);
    // The pinned wrapper needs its documented postinstall to replace the CLI
    // stub with the native optional dependency. Run only that known script.
    run(process.execPath, [path.join(prefix, 'node_modules/@anthropic-ai/claude-code/install.cjs')]);
  }
  assertVersion(claude, pins.claude.version);
  fs.writeFileSync(ready, `${pins.claude.version}\n`);

  const archive = path.join(tools, `agy-${pins.agy.version}.tar.gz`);
  if (!fs.existsSync(archive)) {
    const response = await fetch(pins.agy.linuxX64Url);
    assert.ok(response.ok, `Antigravity download failed: ${response.status}`);
    const temporary = `${archive}.partial`;
    fs.writeFileSync(temporary, Buffer.from(await response.arrayBuffer()));
    fs.renameSync(temporary, archive);
  }
  const digest = createHash('sha512').update(fs.readFileSync(archive)).digest('hex');
  assert.equal(digest, pins.agy.sha512, 'Antigravity SHA512 mismatch');
  // The official archive calls the executable antigravity, not agy. Extract
  // exactly that entry into a fresh directory, never the rest of an archive.
  const extracted = path.join(scratch, 'agy');
  fs.mkdirSync(extracted);
  assert.equal(run('tar', ['-tzf', archive]).trim(), 'antigravity', 'Unexpected official archive layout');
  run('tar', ['-xzf', archive, '-C', extracted, '--no-same-owner', 'antigravity']);
  const agy = path.join(extracted, 'agy');
  fs.renameSync(path.join(extracted, 'antigravity'), agy);
  assert.ok(fs.lstatSync(agy).isFile(), 'Antigravity entry must be a regular file');
  fs.chmodSync(agy, 0o755);
  assertVersion(agy, pins.agy.version);

  run(claude, ['plugin', 'validate', '--strict', '--json', path.join(repo, 'assets/claude/mod')]);
  run(claude, ['plugin', 'test', path.join(repo, 'assets/claude/mod')]);
  run(agy, ['plugin', 'validate', '--strict', '--json', path.join(repo, 'assets/agy')]);
  console.log('Pinned native host contracts passed. This does not test live agent messaging.');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

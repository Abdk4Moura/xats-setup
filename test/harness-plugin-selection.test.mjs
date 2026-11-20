import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensurePluginConfig, isOpenCodeV2Version, installOpencode } from '../lib/harness.mjs';

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

test('forced v2 actually installs the native adapter and config key without a host binary', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xats-forced-v2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  // Guard against a regression accidentally invoking npm for the legacy path.
  fs.mkdirSync(path.join(root, 'node_modules/@opencode-ai/plugin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'opencode.json'), '{"plugins":["user-plugin"]}');
  const before = process.env.XATS_OPENCODE_V2;
  t.after(() => { if (before === undefined) delete process.env.XATS_OPENCODE_V2; else process.env.XATS_OPENCODE_V2 = before; });
  process.env.XATS_OPENCODE_V2 = '1';
  installOpencode({ opencodePlugins: path.join(root, 'plugins') });
  assert.match(fs.readFileSync(path.join(root, 'plugins/xats-register.ts'), 'utf8'), /@opencode\/plugin/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'opencode.json'), 'utf8')).plugins, ['user-plugin', './plugins/xats-register.ts']);
});

// Reported by a user: `ssh host 'npx xats-setup'` runs in a non-login shell whose
// PATH lacks ~/.opencode/bin, so `which opencode` failed and a v2 host silently
// got the legacy v1 adapter. Detection must look at the usual install dirs, and
// must say so out loud when it still cannot tell.
// Windows resolves opencode.cmd/.exe, POSIX resolves the plain name, so the
// fixture must provide whichever this platform would actually find.
function fakeOpencode(root, versionLine) {
  const bin = path.join(root, '.opencode', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  if (process.platform === 'win32') {
    const exe = path.join(bin, 'opencode.cmd');
    fs.writeFileSync(exe, `@echo off\r\necho ${versionLine}\r\n`);
    return exe;
  }
  const exe = path.join(bin, 'opencode');
  fs.writeFileSync(exe, `#!/bin/sh\necho "${versionLine}"\n`);
  fs.chmodSync(exe, 0o755);
  return exe;
}

test('detects OpenCode v2 when PATH cannot see the binary', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xats-opencode-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fakeOpencode(home, 'opencode v2.3.0');

  const { resolveOpenCodeVersion } = await import('../lib/harness.mjs');
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  const savedPath = process.env.PATH;
  const savedForce = process.env.XATS_OPENCODE_V2;
  t.after(() => {
    process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedProfile;
    process.env.PATH = savedPath;
    if (savedForce === undefined) delete process.env.XATS_OPENCODE_V2;
    else process.env.XATS_OPENCODE_V2 = savedForce;
  });

  process.env.HOME = home;
  // os.homedir() on Windows reads USERPROFILE and ignores HOME.
  process.env.USERPROFILE = home;
  process.env.PATH = '/nonexistent-bin';
  delete process.env.XATS_OPENCODE_V2;

  const result = resolveOpenCodeVersion();
  assert.equal(result.source, 'probe');
  assert.match(result.version, /2\.3\.0/);
});

test('XATS_OPENCODE_V2 settles detection without a probe', async (t) => {
  const { resolveOpenCodeVersion } = await import('../lib/harness.mjs');
  const savedForce = process.env.XATS_OPENCODE_V2;
  const savedPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = savedPath;
    if (savedForce === undefined) delete process.env.XATS_OPENCODE_V2;
    else process.env.XATS_OPENCODE_V2 = savedForce;
  });

  process.env.PATH = '/nonexistent-bin';
  process.env.XATS_OPENCODE_V2 = '1';
  assert.equal(resolveOpenCodeVersion().source, 'forced');
  assert.equal(resolveOpenCodeVersion().version, '2');

  process.env.XATS_OPENCODE_V2 = '0';
  assert.equal(resolveOpenCodeVersion().version, '1');
});

test('reports unset instead of pretending v1 when nothing is found', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xats-opencode-empty-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const { resolveOpenCodeVersion } = await import('../lib/harness.mjs');
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, F: process.env.XATS_OPENCODE_V2 };
  t.after(() => {
    process.env.HOME = saved.HOME;
    process.env.PATH = saved.PATH;
    if (saved.F === undefined) delete process.env.XATS_OPENCODE_V2;
    else process.env.XATS_OPENCODE_V2 = saved.F;
  });
  process.env.HOME = home;
  process.env.PATH = '/nonexistent-bin';
  delete process.env.XATS_OPENCODE_V2;
  assert.equal(resolveOpenCodeVersion().source, 'unset');
});

test('opencode lookup directories follow the home env, on every platform', async () => {
  const { opencodeDirCandidates } = await import('../lib/harness.mjs');
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  try {
    process.env.HOME = '/fake/home';
    process.env.USERPROFILE = '/fake/profile';
    const dirs = opencodeDirCandidates();
    const expected = process.platform === 'win32'
      ? path.join('/fake/profile', '.opencode', 'bin')
      : path.join('/fake/home', '.opencode', 'bin');
    assert.ok(dirs.includes(expected), `expected ${expected} in ${JSON.stringify(dirs)}`);
  } finally {
    if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
    if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = saved.USERPROFILE;
  }
});

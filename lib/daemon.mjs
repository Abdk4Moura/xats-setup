// daemon.mjs — install the xats daemon into a local prefix (no sudo, any OS),
// then overlay the patched OS-agnostic cli.js so the box is identical to do-vm.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { log, isDry, ensureDir, writeConfigFile } from './log.mjs';
import { npmBin, runNpm, IS_WIN } from './platform.mjs';
import { DAEMON_PKG, DAEMON_PIN } from './constants.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(__dir, '..', 'assets', 'daemon');

export function daemonLayout(paths) {
  const prefix = path.join(paths.xatsRoot, 'daemon');
  const pkgDir = path.join(prefix, 'node_modules', DAEMON_PKG);
  return {
    prefix,
    pkgDir,
    entry: path.join(pkgDir, 'dist', 'cli.js'),
    channelEntry: path.join(pkgDir, 'dist', 'channel-cli.js'),
  };
}

// Detect whether a native compile (rather than a prebuild) blew up, so we can
// hand the user the exact per-OS fix instead of a wall of gyp output.
function compilerHint(stderr) {
  const s = stderr.toLowerCase();
  if (!/gyp|node-gyp|prebuild|msbuild|visual studio|cc1|compile/.test(s)) return null;
  if (IS_WIN) return 'better-sqlite3 needs to compile: install "Visual Studio Build Tools" (C++ workload) + Python 3, or use a Node LTS (20/22) that has a prebuilt binary.';
  if (process.platform === 'darwin') return 'better-sqlite3 needs to compile: run `xcode-select --install` (Xcode Command Line Tools), or use a Node LTS with a prebuilt binary.';
  return 'better-sqlite3 needs to compile: install build tools (`apt install build-essential python3` or equivalent), or use a Node LTS with a prebuilt binary.';
}

// Read-only plan used by the installer before any port/runtime mutation.
export function preflightDaemon(paths, { force = false, betterSqlitePin = null } = {}) {
  const lay = daemonLayout(paths);
  const vendored = path.join(__dir, '..', 'daemon', 'dist', 'cli.js');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dir, '..', 'daemon', 'package.json'), 'utf8'));
  const manifest = JSON.stringify({ name: 'xats-daemon-host', private: true,
    dependencies: { ...(pkg.dependencies ?? {}), ...(betterSqlitePin ? { 'better-sqlite3': betterSqlitePin } : {}) } }, null, 2) + '\n';
  const existed = fs.existsSync(lay.entry);
  if (!fs.existsSync(vendored) && !isDry()) throw new Error('daemon build missing');
  const manifestFile = path.join(lay.prefix, 'package.json');
  const updated = force || fs.existsSync(path.join(lay.prefix, '.runtime-install-pending')) ||
    !fs.existsSync(manifestFile) || fs.readFileSync(manifestFile, 'utf8') !== manifest ||
    !fs.existsSync(path.join(lay.pkgDir, 'package.json')) || !existed ||
    (fs.existsSync(vendored) && !fs.readFileSync(lay.entry).equals(fs.readFileSync(vendored)));
  return { ...lay, existed, updated: Boolean(updated) };
}

export function installDaemon(paths, { force = false, betterSqlitePin = null, npmRunner = runNpm } = {}) {
  preflightDaemon(paths, { force, betterSqlitePin });
  log.step('Daemon: install base package + overlay patched build');
  const lay = daemonLayout(paths);
  // npm can prune our manually placed package as extraneous.
  const existed = fs.existsSync(lay.entry);
  const previousCli = existed ? fs.readFileSync(lay.entry) : null;
  const npm = npmBin();
  if (!npm) { log.err('npm not found on PATH — install Node.js (>=20) first'); throw new Error('npm missing'); }

  ensureDir(lay.prefix);
  // The daemon is our source: `daemon/` in this repo, built to daemon/dist by
  // `npm run build:daemon`. We install its runtime dependencies into the prefix
  // and place our own build in node_modules — no stock package, no patched
  // bundle overlay, so the running code is the code in this repo.
  const vendoredDist = path.join(__dir, '..', 'daemon', 'dist', 'cli.js');
  const daemonPkg = JSON.parse(fs.readFileSync(path.join(__dir, '..', 'daemon', 'package.json'), 'utf8'));
  if (!fs.existsSync(vendoredDist) && !isDry()) {
    log.err('daemon/dist/cli.js is missing — run `npm run build:daemon` (CI does this before publishing)');
    throw new Error('daemon build missing');
  }
  const manifest = path.join(lay.prefix, 'package.json');
  const manifestContent = JSON.stringify({
    name: 'xats-daemon-host',
    private: true,
    dependencies: { ...(daemonPkg.dependencies ?? {}), ...(betterSqlitePin ? { 'better-sqlite3': betterSqlitePin } : {}) },
  }, null, 2) + '\n';
  const pending = path.join(lay.prefix, '.runtime-install-pending');
  const depsChanged = fs.existsSync(pending) || !fs.existsSync(manifest) || fs.readFileSync(manifest, 'utf8') !== manifestContent;
  const previousManifest = fs.existsSync(manifest) ? fs.readFileSync(manifest) : null;
  if (!isDry() && depsChanged) fs.writeFileSync(manifest, manifestContent);

  const installed = fs.existsSync(path.join(lay.pkgDir, 'package.json'));
  if (installed && !force && !depsChanged) {
    log.info(`daemon present at ${lay.pkgDir} (use --force to reinstall)`);
  } else if (isDry()) {
    log.dry(`npm i --prefix ${lay.prefix} (daemon runtime deps) and copy daemon/dist/cli.js`);
  } else {
    log.info(`installing daemon runtime dependencies into ${lay.prefix} (native prebuilds for this OS)…`);
    fs.writeFileSync(pending, 'Dependency install requires successful completion.\n');
    const r = npmRunner(['install', '--prefix', lay.prefix, '--no-audit', '--no-fund'],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    if (!r.ok) {
      // A desired manifest is not a successful dependency-install fingerprint.
      if (previousManifest === null) fs.rmSync(manifest, { force: true });
      else fs.writeFileSync(manifest, previousManifest);
      if (previousCli !== null && !fs.existsSync(lay.entry)) {
        fs.mkdirSync(path.dirname(lay.entry), { recursive: true });
        fs.writeFileSync(lay.entry, previousCli);
      }
      const hint = compilerHint(r.stderr || '');
      log.err(`npm install failed (exit ${r.code})`);
      if (hint) log.warn(hint);
      else if (r.stderr) log.info(r.stderr.split('\n').slice(-4).join('\n'));
      throw new Error('daemon base install failed');
    }
    fs.rmSync(pending, { force: true });
    log.ok('base package installed with native prebuilds');
  }

  // The ABI-safe better-sqlite3 pin is part of the desired manifest above,
  // so unchanged reruns neither reinstall it nor spuriously report updates.

  // Place our own build. There is no stock package to overlay and no backup to
  // keep: `lay.entry` is a file we produced from `daemon/src`.
  const distDir = path.join(lay.pkgDir, 'dist');
  const pkgDirOwn = lay.pkgDir;
  if (!isDry()) {
    ensureDir(distDir);
    fs.writeFileSync(path.join(pkgDirOwn, 'package.json'), JSON.stringify(daemonPkg, null, 2) + '\n');
  }
  // Restore pruned bytes first so writeConfigFile can preserve custom edits.
  if (!isDry() && previousCli !== null && !fs.existsSync(lay.entry)) fs.writeFileSync(lay.entry, previousCli);
  const cliChanged = writeConfigFile(lay.entry, fs.readFileSync(vendoredDist));
  // The legacy channel proxy is retired: Claude Code delivery is the xats mod,
  // and the daemon we own has no channel entry point.
  return { ...lay, existed, updated: cliChanged || depsChanged || force };
}

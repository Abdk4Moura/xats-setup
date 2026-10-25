// daemon.mjs — install the xats daemon into a local prefix (no sudo, any OS),
// then overlay the patched OS-agnostic cli.js so the box is identical to do-vm.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { log, isDry, ensureDir, copyFile } from './log.mjs';
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

export function installDaemon(paths, { force = false, betterSqlitePin = null } = {}) {
  log.step('Daemon: install base package + overlay patched build');
  const lay = daemonLayout(paths);
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
  if (!isDry()) {
    fs.writeFileSync(manifest, JSON.stringify({
      name: 'xats-daemon-host',
      private: true,
      dependencies: daemonPkg.dependencies ?? {},
    }, null, 2) + '\n');
  }

  const installed = fs.existsSync(path.join(lay.pkgDir, 'package.json'));
  if (installed && !force) {
    log.info(`daemon present at ${lay.pkgDir} (use --force to reinstall)`);
  } else if (isDry()) {
    log.dry(`npm i --prefix ${lay.prefix} (daemon runtime deps) and copy daemon/dist/cli.js`);
  } else {
    log.info(`installing daemon runtime dependencies into ${lay.prefix} (native prebuilds for this OS)…`);
    const r = runNpm(['install', '--prefix', lay.prefix, '--no-audit', '--no-fund'],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    if (!r.ok) {
      const hint = compilerHint(r.stderr || '');
      log.err(`npm install failed (exit ${r.code})`);
      if (hint) log.warn(hint);
      else if (r.stderr) log.info(r.stderr.split('\n').slice(-4).join('\n'));
      throw new Error('daemon base install failed');
    }
    log.ok('base package installed with native prebuilds');
  }

  // ABI-safe better-sqlite3 pin (Node 20/23 lack a prebuild in the 12.x float).
  if (betterSqlitePin && !isDry()) {
    log.info(`pinning better-sqlite3@${betterSqlitePin} for this Node's ABI…`);
    const r = runNpm(['install', '--prefix', lay.prefix, '--no-audit', '--no-fund', `better-sqlite3@${betterSqlitePin}`],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    if (!r.ok) {
      const hint = compilerHint(r.stderr || '');
      log.err('better-sqlite3 pin failed');
      if (hint) log.warn(hint);
      throw new Error('better-sqlite3 pin failed');
    }
    log.ok(`better-sqlite3@${betterSqlitePin} installed (prebuilt)`);
  } else if (betterSqlitePin) {
    log.dry(`npm i --prefix ${lay.prefix} better-sqlite3@${betterSqlitePin}`);
  }

  // Place our own build. There is no stock package to overlay and no backup to
  // keep: `lay.entry` is a file we produced from `daemon/src`.
  const distDir = path.join(lay.pkgDir, 'dist');
  const pkgDirOwn = lay.pkgDir;
  if (!isDry()) {
    ensureDir(distDir);
    fs.writeFileSync(path.join(pkgDirOwn, 'package.json'), JSON.stringify(daemonPkg, null, 2) + '\n');
  }
  const cliChanged = copyFile(vendoredDist, lay.entry);
  // The legacy channel proxy is retired: Claude Code delivery is the xats mod,
  // and the daemon we own has no channel entry point.
  const chChanged = false;

  return lay;
}

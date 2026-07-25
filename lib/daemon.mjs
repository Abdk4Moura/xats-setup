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
  // Minimal manifest so `npm i --prefix` stays quiet and self-contained.
  const manifest = path.join(lay.prefix, 'package.json');
  if (!fs.existsSync(manifest) && !isDry()) {
    fs.writeFileSync(manifest, JSON.stringify({ name: 'xats-daemon-host', private: true }, null, 2) + '\n');
  }

  const installed = fs.existsSync(path.join(lay.pkgDir, 'package.json'));
  if (installed && !force) {
    log.info(`base package present at ${lay.pkgDir} (use --force to reinstall)`);
  } else if (isDry()) {
    log.dry(`npm i --prefix ${lay.prefix} ${DAEMON_PKG}@${DAEMON_PIN}`);
  } else {
    log.info(`installing ${DAEMON_PKG}@${DAEMON_PIN} into ${lay.prefix} (native prebuilds for this OS)…`);
    const r = runNpm(['install', '--prefix', lay.prefix, '--no-audit', '--no-fund', `${DAEMON_PKG}@${DAEMON_PIN}`],
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

  // Overlay the patched, OS-agnostic build (backup the stock cli once).
  const distDir = path.join(lay.pkgDir, 'dist');
  if (!isDry()) ensureDir(distDir);
  const bak = path.join(distDir, 'cli.js.prepatch-bak');
  if (fs.existsSync(lay.entry) && !fs.existsSync(bak) && !isDry()) {
    fs.copyFileSync(lay.entry, bak);
    log.info('backed up stock cli.js -> cli.js.prepatch-bak');
  }
  const cliChanged = copyFile(path.join(ASSETS, 'cli.js'), lay.entry);
  const srcChannel = path.join(ASSETS, 'channel-cli.js');
  let chChanged = false;
  if (fs.existsSync(srcChannel)) chChanged = copyFile(srcChannel, lay.channelEntry);
  lay.updated = cliChanged || chChanged; // build actually changed on disk

  log.ok(`daemon entry: ${lay.entry}`);
  return lay;
}

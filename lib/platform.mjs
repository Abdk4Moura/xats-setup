// platform.mjs — OS detection + cross-platform paths and helpers.
// The whole installer routes every OS-specific decision through this module.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import net from 'node:net';

export const PLATFORM = process.platform; // 'win32' | 'darwin' | 'linux'
export const IS_WIN = PLATFORM === 'win32';
export const IS_MAC = PLATFORM === 'darwin';
export const IS_LINUX = PLATFORM === 'linux';
export const HOME = os.homedir();
export const TMP = os.tmpdir();
export const IS_ROOT = !IS_WIN && typeof process.getuid === 'function' && process.getuid() === 0;

export function hostname() {
  return os.hostname().split('.')[0];
}

// Resolve an executable across platforms (adds .cmd/.exe probing on Windows).
export function which(cmd) {
  const exts = IS_WIN ? ['.cmd', '.exe', '.bat', ''] : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        return full;
      } catch { /* keep looking */ }
    }
  }
  return null;
}

export function has(cmd) {
  return which(cmd) !== null;
}

// npm is `npm.cmd` on Windows. Return an invocable path or null.
export function npmBin() {
  return which('npm');
}

export function nodeBin() {
  return process.execPath; // always the running node — most reliable
}

// `npm root -g` — where global packages land on this box/OS.
export function npmGlobalRoot() {
  const npm = npmBin();
  if (!npm) return null;
  try {
    const out = execFileSync(npm, ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim();
  } catch {
    return null;
  }
}

// Run a command, capturing result without throwing. Returns {ok, code, stdout, stderr}.
export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return {
    ok: r.status === 0,
    code: r.status,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
    error: r.error,
  };
}

// Locate npm's JS entrypoint next to the running node, so we can run npm as
// `node npm-cli.js …` instead of spawning the npm.cmd/npm shim. On Windows,
// Node (post CVE-2024-27980) refuses to spawnSync a .cmd/.bat without
// shell:true; going through npm-cli.js avoids that AND guarantees npm runs
// under the SAME node (correct native ABI for better-sqlite3).
export function npmCliJs() {
  const dir = path.dirname(nodeBin());
  const cands = [
    path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),            // Windows / portable zip
    path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), // POSIX prefix layout
  ];
  for (const c of cands) { try { fs.accessSync(c); return c; } catch { /* next */ } }
  return null;
}

// Preferred way to run npm. Uses npm-cli.js under the current node when found;
// falls back to the npm shim (with shell:true on Windows for .cmd).
export function runNpm(args, opts = {}) {
  const cli = npmCliJs();
  if (cli) return run(nodeBin(), [cli, ...args], opts);
  const npm = npmBin();
  if (!npm) return { ok: false, code: null, stdout: '', stderr: 'npm not found', error: new Error('npm not found') };
  return run(npm, args, { ...opts, shell: IS_WIN });
}

// Standard config locations we touch, resolved per-OS.
export function paths() {
  // opencode/mimocode use ~/.config/<name> on EVERY OS (incl. Windows — they
  // follow XDG-style ~/.config, NOT %APPDATA%). Verified on Windows: the config
  // lives at %USERPROFILE%\.config\opencode.
  const cfg = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');
  return {
    home: HOME,
    tmp: TMP,
    // xats install root (owns the daemon overlay, bridge, hook, plugin sources)
    xatsRoot: path.join(HOME, '.xats'),
    // Claude Code
    claudeDir: path.join(HOME, '.claude'),
    claudeSettings: path.join(HOME, '.claude', 'settings.json'),
    claudeJson: path.join(HOME, '.claude.json'),
    claudeHooksDir: path.join(HOME, '.claude', 'hooks'),
    // opencode / mimocode
    opencodePlugins: path.join(cfg, 'opencode', 'plugins'),
    mimocodePlugins: path.join(cfg, 'mimocode', 'plugins'),
    opencodeSkills: path.join(cfg, 'opencode', 'skills'),
    // Pi (global extensions and skills)
    piDir: path.join(HOME, '.pi', 'agent'),
    piExtensions: path.join(HOME, '.pi', 'agent', 'extensions'),
    piSkills: path.join(HOME, '.pi', 'agent', 'skills'),
    // daemon state (matches the daemon's own default: ~/.cross-agent-teams-mcp)
    daemonState: path.join(HOME, '.cross-agent-teams-mcp'),
  };
}

export function summary() {
  return {
    platform: PLATFORM,
    arch: process.arch,
    node: process.version,
    host: hostname(),
    root: IS_ROOT,
    home: HOME,
  };
}

// WSL duality: Windows host and WSL distro are separate buses (separate ~/.xats).
// Detect wsl.exe and probe whether the distro has opencode/daemon/filament.
export function wslInfo() {
  if (!IS_WIN) return null;
  const wsl = which('wsl.exe') || which('wsl');
  if (!wsl) return null;
  const info = { wsl, hasWSL: true, opencode: false, daemon: false, filament: false, pi: false };
  // single batched probe — one WSL spawn instead of 5
  const script = [
    'echo "opencode:$(test -d ~/.config/opencode && echo found || echo missing)"',
    'echo "daemon:$(test -f ~/.xats/daemon/node_modules/cross-agent-teams-mcp/dist/cli.js && echo found || echo missing)"',
    'echo "filament:$(command -v filament >/dev/null 2>&1 && echo found || echo missing)"',
    'echo "pi:$(test -d ~/.pi/agent && echo found || echo missing)"',
    'echo "hostname:$(hostname 2>/dev/null | tr -d "\\n" | cut -d. -f1)"',
  ].join('; ');
  try {
    const r = run(wsl, ['-e', 'sh', '-lc', script], { timeout: 4000 });
    for (const line of r.stdout.split('\n')) {
      const [k, v] = line.trim().split(':');
      if (!k || v === undefined) continue;
      if (k === 'hostname' && v) info.hostname = v.trim();
      else if (k in info) info[k] = v.trim() === 'found';
    }
  } catch { /* probe failed — return defaults */ }
  return info;
}

export function labelFile(paths) {
  return path.join(paths.xatsRoot, 'label');
}

export function readLabelFile(paths) {
  try { return fs.readFileSync(labelFile(paths), 'utf8').trim() || null; } catch { return null; }
}

export function writeLabelFile(paths, label) {
  try {
    fs.mkdirSync(paths.xatsRoot, { recursive: true });
    fs.writeFileSync(labelFile(paths), String(label).trim() + '\n');
    return true;
  } catch { return false; }
}

export function portFile(paths) {
  return path.join(paths.xatsRoot, 'port');
}
export function readPort(paths, fallback) {
  try {
    const v = parseInt(fs.readFileSync(portFile(paths), 'utf8').trim(), 10);
    if (Number.isInteger(v) && v > 0 && v < 65535) return v;
  } catch { /* no file */ }
  return fallback ?? 9100;
}
export function writePort(paths, port) {
  try {
    fs.mkdirSync(paths.xatsRoot, { recursive: true });
    fs.writeFileSync(portFile(paths), String(port) + '\n');
    return true;
  } catch { return false; }
}
export function isPortFree(port, host = '127.0.0.1') {
  return new Promise((res) => {
    const s = net.createServer();
    s.once('error', () => res(false));
    s.once('listening', () => s.close(() => res(true)));
    s.listen(port, host);
  });
}
export async function pickPort(paths, candidates = [9100, 9101, 9102, 9103, 9104]) {
  const persisted = readPort(paths, null);
  if (persisted && (await isPortFree(persisted))) return persisted;
  for (const p of candidates) {
    if (await isPortFree(p)) return p;
  }
  return candidates[0];
}

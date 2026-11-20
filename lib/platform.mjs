// platform.mjs — OS detection + cross-platform paths and helpers.
// The whole installer routes every OS-specific decision through this module.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import net from 'node:net';
import { nativeProcessProof, sameFile } from './process-proof.mjs';
import { DAEMON_PKG } from './constants.mjs';

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
    // Google Antigravity CLI, App, and IDE global plugin directory
    agyPlugin: path.join(HOME, '.gemini', 'config', 'plugins', 'xats'),
    // Pi (global extensions and skills)
    piDir: path.join(HOME, '.pi', 'agent'),
    piExtensions: path.join(HOME, '.pi', 'agent', 'extensions'),
    piSkills: path.join(HOME, '.pi', 'agent', 'skills'),
    // OMP (fork of Pi, config at ~/.omp/agent — same layout as Pi)
    ompDir: path.join(HOME, '.omp', 'agent'),
    ompExtensions: path.join(HOME, '.omp', 'agent', 'extensions'),
    ompSkills: path.join(HOME, '.omp', 'agent', 'skills'),
    // daemon state (matches the daemon's own default: ~/.cross-agent-teams-mcp)
    daemonState: process.env.CROSS_AGENT_TEAMS_MCP_HOME
      ? path.resolve(process.env.CROSS_AGENT_TEAMS_MCP_HOME)
      : path.join(HOME, '.cross-agent-teams-mcp'),
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
// One snapshot per setup process, including an unavailable/timed-out probe.
// Repeating the same optional WSL startup probe for each component is expensive.
let wslProbeCache = null;
export function wslInfo({ platform = PLATFORM, find = which, probe = run } = {}) {
  if (platform !== 'win32') return null;
  const wsl = find('wsl.exe') || find('wsl');
  if (!wsl) return null;
  if (wslProbeCache?.binary === wsl && wslProbeCache.probe === probe) return { ...wslProbeCache.info };
  const info = { wsl, hasWSL: true, opencode: false, daemon: false, filament: false, pi: false, omp: false };
  // single batched probe — one WSL spawn instead of 5
  const script = [
    'echo "opencode:$(test -d ~/.config/opencode && echo found || echo missing)"',
    'echo "daemon:$(test -f ~/.xats/daemon/node_modules/cross-agent-teams-mcp/dist/cli.js && echo found || echo missing)"',
    'echo "filament:$(command -v filament >/dev/null 2>&1 && echo found || echo missing)"',
    'echo "pi:$(test -d ~/.pi/agent && echo found || echo missing)"',
    'echo "omp:$(command -v omp >/dev/null 2>&1 && echo found || test -f ~/.omp/agent/config.yml && echo found || echo missing)"',
    'echo "hostname:$(hostname 2>/dev/null | tr -d "\\n" | cut -d. -f1)"',
  ].join('; ');
  try {
    const r = probe(wsl, ['-e', 'sh', '-lc', script], { timeout: 4000 });
    for (const line of r.stdout.split('\n')) {
      const [k, v] = line.trim().split(':');
      if (!k || v === undefined) continue;
      if (k === 'hostname' && v) info.hostname = v.trim();
      else if (k in info) info[k] = v.trim() === 'found';
    }
  } catch { /* probe failed; retain safe defaults for this invocation */ }
  wslProbeCache = { binary: wsl, probe, info };
  return { ...info };
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
  return fallback == null ? 9100 : fallback;
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
// A pid file and a generic {ok:true} response are not proof of ownership.
// Bind ownership to process argv, local DB identity and its listening socket.
// Native macOS/Windows probes require explicit scope args, since other process
// environments cannot be read reliably. Ambiguous legacy scopes fail closed.
export function ownedDaemon(paths, port, entry = path.join(paths.xatsRoot, 'daemon', 'node_modules', DAEMON_PKG, 'dist', 'cli.js')) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(paths.daemonState, 'daemon.pid'), 'utf8'));
    if (!Number.isInteger(info.pid) || info.pid <= 1 || info.port !== port) return null;
    const proc = `/proc/${info.pid}`;
    const native = IS_LINUX ? null : nativeProcessProof(info.pid, port);
    if (!IS_LINUX && !native) return null;
    const argv = IS_LINUX ? fs.readFileSync(`${proc}/cmdline`, 'utf8').split('\0').filter(Boolean) : native.argv;
    if (!sameFile(argv[0], nodeBin()) || !sameFile(argv[1], entry) || argv[2] !== 'daemon') return null;
    const env = IS_LINUX ? Object.fromEntries(fs.readFileSync(`${proc}/environ`, 'utf8').split('\0').filter(Boolean).map((s) => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)]; })) : (native.env || {});
    if (!IS_LINUX && !env.HOME && !env.CROSS_AGENT_TEAMS_MCP_HOME && (!argv.includes('--db') || !argv.includes('--pid-file'))) return null;
    const arg = (key, fallback) => argv.includes(key) ? argv[argv.indexOf(key) + 1] : fallback;
    // systemd system services commonly omit HOME. Only infer the real account
    // home after checking the target UID, never from installer HOME overrides.
    if (IS_LINUX && !env.HOME && !env.CROSS_AGENT_TEAMS_MCP_HOME) {
      const uid = fs.readFileSync(`${proc}/status`, 'utf8').match(/^Uid:\s+(\d+)/m)?.[1];
      if (uid !== undefined && Number(uid) === process.getuid()) env.HOME = os.userInfo().homedir;
    }
    // Match the daemon's nullish semantics: an explicitly empty state home is
    // not permission to infer a different absolute default database scope.
    const state = env.CROSS_AGENT_TEAMS_MCP_HOME ?? path.join(env.HOME || '', '.cross-agent-teams-mcp');
    const db = arg('--db', path.join(state, 'data.db'));
    const pidFile = arg('--pid-file', path.join(state, 'daemon.pid'));
    if (!path.isAbsolute(db) || !path.isAbsolute(pidFile)) return null;
    if (path.resolve(db) !== path.resolve(paths.daemonState, 'data.db') || path.resolve(pidFile) !== path.resolve(paths.daemonState, 'daemon.pid')) return null;
    if (native) return { pid: info.pid, port, entry };
    const sockets = new Set(fs.readdirSync(`${proc}/fd`).flatMap((fd) => {
      try { const m = fs.readlinkSync(`${proc}/fd/${fd}`).match(/^socket:\[(\d+)\]$/); return m ? [m[1]] : []; } catch { return []; }
    }));
    const tcp = fs.readFileSync(`${proc}/net/tcp`, 'utf8') + '\n' + fs.readFileSync(`${proc}/net/tcp6`, 'utf8');
    const bound = tcp.split('\n').some((line) => {
      const cols = line.trim().split(/\s+/);
      return cols[3] === '0A' && parseInt(cols[1]?.split(':')[1], 16) === port && sockets.has(cols[9]);
    });
    return bound ? { pid: info.pid, port, entry } : null;
  } catch { return null; }
}

export async function pickPort(paths, candidates = [9100, 9101, 9102, 9103, 9104]) {
  let persisted = null;
  try {
    const raw = fs.readFileSync(portFile(paths), 'utf8').trim();
    if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 65534) throw new Error('Invalid saved port');
    persisted = Number(raw);
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Invalid or unreadable saved port: ${portFile(paths)}. Repair it before rerunning setup; it was not changed.`);
  }
  const reusable = async (port) => {
    if (!ownedDaemon(paths, port)) return false;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
      return r.ok && (await r.json()).ok === true && !!ownedDaemon(paths, port);
    } catch { return false; }
  };
  if (persisted) {
    if (await isPortFree(persisted) || await reusable(persisted)) return persisted;
    throw new Error(`Saved xats port :${persisted} is occupied by an unverified or unhealthy process. Stop it or repair the daemon service before rerunning setup; ${portFile(paths)} was not changed.`);
  }
  // A pre-port-file install may already own a candidate port.
  for (const p of candidates) if (await reusable(p)) return p;
  for (const p of candidates) if (await isPortFree(p)) return p;
  throw new Error('No free xats daemon port. Stop the conflicting listener and rerun setup.');
}

// harness.mjs — wire opencode / mimocode onto the bus.
// Copies (not symlinks — Windows-safe) the appropriate plugin adapter into
// each harness plugin dir and installs the xats skill. OpenCode v2 gets its
// native Promise-API adapter; Mimocode and OpenCode v1 keep the legacy adapter.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { log, isDry, copyFile, ensureDir, writeConfigJson, configError, isConfigObject, copyConfigTree } from './log.mjs';
import { npmBin, runNpm, run, which, IS_WIN } from './platform.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(__dir, '..', 'assets');
const PLUGIN_FILES = ['xats-register.ts'];
const OWNED_PLUGIN_ENTRIES = ['./plugins/xats-register.ts', './plugins/notify-unified.ts'];
const PLUGIN_DEP = '@opencode-ai/plugin@^1.17.18';

export function isOpenCodeV2Version(version) {
  return /(?:^|\s)v?2\.\d+(?:\.|\s|$)/.test(String(version ?? ''));
}

function detectOpenCodeV2() {
  const result = resolveOpenCodeVersion();
  if (result.source === 'forced') return result.version === '2';
  if (result.source === 'unset') {
    log.warn('opencode: could not determine the installed version, so the legacy adapter is being installed.');
    log.info('  If opencode 2.x is installed, run this with your normal login PATH, or set XATS_OPENCODE_V2=1.');
    return false;
  }
  if (result.error) {
    log.warn(`opencode at ${result.executable} did not report a version; installing the legacy adapter.`);
    log.info('  Set XATS_OPENCODE_V2=1 to force the v2 adapter.');
    return false;
  }
  return isOpenCodeV2Version(result.version);
}

// Where an opencode install commonly lives. A bare non-login shell, which is what
// `ssh host 'npx xats-setup'` gives you, often has a PATH without ~/.opencode/bin,
// so PATH alone silently downgrades a v2 host to the legacy adapter.
export function opencodeDirCandidates() {
  // Honour an explicit env override before os.homedir(). On Windows os.homedir()
  // reads USERPROFILE and ignores HOME, which is exactly how a test that fakes a
  // home directory ends up looking in the real one.
  const home = process.platform === 'win32'
    ? (process.env.USERPROFILE || process.env.HOME || os.homedir())
    : (process.env.HOME || os.homedir())
  const dirs = [
    path.join(home, '.opencode', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.bun', 'bin'),
    '/usr/local/bin',
    '/usr/bin',
  ];
  if (process.platform === 'darwin') dirs.push('/opt/homebrew/bin');
  return dirs;
}

function opencodeExecutable() {
  const fromPath = which('opencode');
  if (fromPath) return fromPath;
  const names = IS_WIN ? ['opencode.cmd', 'opencode.exe', 'opencode.bat'] : ['opencode'];
  for (const dir of opencodeDirCandidates()) {
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        return full;
      } catch { /* keep looking */ }
    }
  }
  return null;
}

// Resolves to one of: forced, unset, error, or a version string.
// XATS_OPENCODE_V2 wins, so a user can settle the question without a probe.
export function resolveOpenCodeVersion() {
  const forced = String(process.env.XATS_OPENCODE_V2 ?? '').trim().toLowerCase();
  if (forced === '1' || forced === 'true' || forced === 'yes') return { source: 'forced', version: '2' };
  if (forced === '0' || forced === 'false' || forced === 'no') return { source: 'forced', version: '1' };

  const executable = opencodeExecutable();
  if (!executable) return { source: 'unset' };
  // On Windows `which` resolves opencode to opencode.cmd, and Node refuses to
  // spawn a .cmd without a shell (CVE-2024-27980). Without this the probe always
  // fails, the installer silently picks the legacy adapter, and the TUI plugin is
  // never copied — the failure looks like "no badge" much later.
  const result = run(executable, ['--version'], { timeout: 5000, shell: IS_WIN });
  const version = String(result.stdout || result.stderr || '').trim();
  if (!result.ok || !version) return { source: 'error', executable };
  return { source: 'probe', executable, version };
}

function resolvable(dep, fromDir) {
  try { fs.accessSync(path.join(fromDir, 'node_modules', dep.split('@').slice(0, -1).join('@') || dep)); return true; }
  catch { return false; }
}

function wireOne(name, cfgRoot) {
  if (!fs.existsSync(cfgRoot)) { log.info(`${name} not installed (${cfgRoot}) — skipping`); return null; }
  // Validate all existing config variants before any plugin or dependency writes.
  readHarnessConfigs(name, cfgRoot);
  const pluginsDir = path.join(cfgRoot, 'plugins');
  ensureDir(pluginsDir);
  const useV2Plugin = name === 'opencode' && detectOpenCodeV2();
  for (const f of PLUGIN_FILES) {
    const source = f === 'xats-register.ts' && useV2Plugin ? 'xats-register-v2.ts' : f;
    copyFile(path.join(ASSETS, 'plugins', source), path.join(pluginsDir, f));
  }

  // OpenCode v2 also gets the TUI plugin: footer badge + /xats panel. It is a
  // package directory (exports ./tui) rather than a single file, and it is
  // independent of the server adapter so a TUI error cannot stop delivery.
  if (useV2Plugin) {
    const tuiSrc = path.join(ASSETS, 'plugins', 'xats-tui');
    const tuiDest = path.join(pluginsDir, 'xats-tui');
    if (isDry()) log.dry(`copy ${tuiSrc} -> ${tuiDest}`);
    else {
      copyConfigTree(tuiSrc, tuiDest);
      log.ok('opencode: xats TUI plugin (badge + /xats panel)');
    }
  }

  // V2 provides @opencode/plugin and its Promise API at runtime. The legacy
  // @opencode-ai/plugin dependency is installed only for V1/Mimocode adapters.
  const depBase = '@opencode-ai/plugin';
  if (!useV2Plugin && !resolvable(depBase, cfgRoot) && !isDry()) {
    if (npmBin()) {
      log.info(`installing ${PLUGIN_DEP} into ${cfgRoot}…`);
      const r = runNpm(['install', '--prefix', cfgRoot, '--no-audit', '--no-fund', PLUGIN_DEP],
        { stdio: ['ignore', 'ignore', 'pipe'] });
      if (r.ok) log.ok('plugin dep installed'); else log.warn('could not install plugin dep (opencode may provide it at runtime)');
    }
  }

  // Reference the xats plugin from the matching V1 or V2 config array. JSONC
  // is supported, though comments are dropped when the installer must rewrite it.
  ensurePluginConfig(name, cfgRoot, useV2Plugin);

  // xats skill
  const skillDir = path.join(cfgRoot, 'skills', 'xats');
  copyFile(path.join(ASSETS, 'skills', 'xats', 'SKILL.md'), path.join(skillDir, 'SKILL.md'));

  log.ok(`${name}: plugins + skill wired at ${pluginsDir}`);
  return { name, pluginsDir };
}

export function stripJsonc(text) {
  let out = '';
  let inStr = false, strCh = '', esc = false, inLine = false, inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inLine) { if (c === '\n') { inLine = false; out += c; } continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++; } continue; }
    if (inStr) { out += c; if (esc) esc = false; else if (c === '\\') esc = true; else if (c === strCh) inStr = false; continue; }
    if (c === '"' || c === "'") { inStr = true; strCh = c; out += c; continue; }
    if (c === '/' && n === '/') { inLine = true; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; out += ' '; i++; continue; }
    out += c;
  }
  if (inBlock || inStr) throw new Error('Unterminated JSONC comment or string');
  // Strip trailing commas only outside strings.
  let cleaned = '', quoted = false, escaped = false;
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if (!quoted && ch === ',' && /^\s*[}\]]/.test(out.slice(i + 1))) continue;
    cleaned += ch;
    if (escaped) escaped = false;
    else if (quoted && ch === '\\') escaped = true;
    else if (ch === '"') quoted = !quoted;
  }
  return cleaned;
}

export function preflightHarnessConfig(name, cfgRoot) {
  return readHarnessConfigs(name, cfgRoot);
}

function readHarnessConfigs(name, cfgRoot) {
  const configs = [];
  for (const base of [`${name}.json`, `${name}.jsonc`]) {
    const file = path.join(cfgRoot, base);
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      throw configError(file, `cannot read file (${error.code || 'I/O error'})`);
    }
    let obj;
    try { obj = JSON.parse(stripJsonc(raw)); }
    catch { throw configError(file, 'invalid JSON or JSONC'); }
    const check = (ok, section) => { if (!ok) throw configError(file, `invalid ${section} structure`); };
    check(isConfigObject(obj), 'root object');
    for (const key of ['plugin', 'plugins']) {
      if (key in obj) check(Array.isArray(obj[key]) && obj[key].every((v) => typeof v === 'string'), key);
    }
    if ('mcp' in obj) {
      check(isConfigObject(obj.mcp), 'mcp');
      if ('cross-agent-teams' in obj.mcp) check(isConfigObject(obj.mcp['cross-agent-teams']), 'mcp.cross-agent-teams');
      if ('servers' in obj.mcp) {
        check(isConfigObject(obj.mcp.servers), 'mcp.servers');
        if ('cross-agent-teams' in obj.mcp.servers) check(isConfigObject(obj.mcp.servers['cross-agent-teams']), 'mcp.servers.cross-agent-teams');
      }
    }
    configs.push({ cfgFile: file, base, obj });
  }
  return configs;
}
export function ensurePluginConfig(name, cfgRoot, useV2Plugin = false) {
  const wanted = PLUGIN_FILES.map((f) => `./plugins/${f}`);
  const configKey = useV2Plugin ? 'plugins' : 'plugin';
  const otherKey = useV2Plugin ? 'plugin' : 'plugins';
  for (const { cfgFile, base, obj } of readHarnessConfigs(name, cfgRoot)) {
    const cur = Array.isArray(obj[configKey]) ? obj[configKey] : [];
    const cleanedCurrent = cur.filter((entry) => !OWNED_PLUGIN_ENTRIES.includes(entry) || wanted.includes(entry));
    const missing = wanted.filter((w) => !cleanedCurrent.includes(w));
    const other = Array.isArray(obj[otherKey]) ? obj[otherKey] : [];
    const cleanedOther = other.filter((entry) => !OWNED_PLUGIN_ENTRIES.includes(entry));
    const moved = cleanedOther.length !== other.length;
    const removedObsolete = cleanedCurrent.length !== cur.length;
    if (!missing.length && !moved && !removedObsolete) { log.info(`${base}: xats plugin entry already present`); return; }
    obj[configKey] = [...cleanedCurrent, ...missing];
    if (moved) {
      if (cleanedOther.length) obj[otherKey] = cleanedOther;
      else delete obj[otherKey];
    }
    if (obj.mcp && obj.mcp['cross-agent-teams']) obj.mcp['cross-agent-teams'].enabled = false; // V1 MCP config
    if (obj.mcp?.servers?.['cross-agent-teams']) obj.mcp.servers['cross-agent-teams'].disabled = true; // V2 MCP config
    writeConfigJson(cfgFile, obj);
    log.ok(`${base}: added ${missing.length} xats plugin entr${missing.length === 1 ? 'y' : 'ies'}${moved ? ` and moved entries to ${configKey}` : ''}${removedObsolete ? ' and removed obsolete notify-unified entry' : ''}`);
    return;
  }
  log.info(`${name}: no config file yet — plugins will load once ${name}.json lists ./plugins/*.ts`);
}

export function installOpencode(paths) {
  log.step('opencode: plugins + skill');
  const cfgDir = (p) => path.dirname(p);
  const r = wireOne('opencode', cfgDir(paths.opencodePlugins));
  if (!r) log.info('opencode not installed — skipping (safe to re-run later)');
  return r;
}

export function installMimocode(paths) {
  log.step('mimocode: plugins + skill');
  const cfgDir = (p) => path.dirname(p);
  const r = wireOne('mimocode', cfgDir(paths.mimocodePlugins));
  if (!r) log.info('mimocode not installed — skipping (safe to re-run later)');
  return r;
}

export function installHarnesses(paths) {
  // Back-compat alias: harness = opencode + mimocode (pi moved to its own component).
  log.warn('harness is deprecated — use --only=opencode,mimocode,pi (and claude separately)');
  const cfgDir = (p) => path.dirname(p);
  readHarnessConfigs('opencode', cfgDir(paths.opencodePlugins));
  readHarnessConfigs('mimocode', cfgDir(paths.mimocodePlugins));
  const results = [
    wireOne('opencode', cfgDir(paths.opencodePlugins)),
    wireOne('mimocode', cfgDir(paths.mimocodePlugins)),
  ].filter(Boolean);

  if (results.length) {
    log.info('config note: ensure each harness loads the plugin dir. For configs that list');
    log.info('plugins explicitly (e.g. mimocode.json "plugin": [...]), add:');
    log.info('  "./plugins/xats-register.ts"');
    }
  return results;
}

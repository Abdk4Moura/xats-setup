// harness.mjs — wire opencode / mimocode onto the bus.
// Copies (not symlinks — Windows-safe) the appropriate plugin adapter into
// each harness plugin dir and installs the xats skill. OpenCode v2 gets its
// native Promise-API adapter; Mimocode and OpenCode v1 keep the legacy adapter.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { log, isDry, copyFile, ensureDir } from './log.mjs';
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
  const executable = which('opencode');
  if (!executable) return false;
  // On Windows `which` resolves opencode to opencode.cmd, and Node refuses to
  // spawn a .cmd without a shell (CVE-2024-27980). Without this the probe always
  // fails, the installer silently picks the legacy adapter, and the TUI plugin is
  // never copied — the failure looks like "no badge" much later.
  const result = run(executable, ['--version'], { timeout: 5000, shell: IS_WIN });
  if (!result.ok) return false;
  return isOpenCodeV2Version(result.stdout || result.stderr);
}

function resolvable(dep, fromDir) {
  try { fs.accessSync(path.join(fromDir, 'node_modules', dep.split('@').slice(0, -1).join('@') || dep)); return true; }
  catch { return false; }
}

function wireOne(name, cfgRoot) {
  if (!fs.existsSync(cfgRoot)) { log.info(`${name} not installed (${cfgRoot}) — skipping`); return null; }
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
      fs.rmSync(tuiDest, { recursive: true, force: true });
      fs.cpSync(tuiSrc, tuiDest, { recursive: true });
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
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    out += c;
  }
  // strip trailing commas before } or ]
  return out.replace(/,\s*([\]}])/g, '$1');
}
export function ensurePluginConfig(name, cfgRoot, useV2Plugin = false) {
  const wanted = PLUGIN_FILES.map((f) => `./plugins/${f}`);
  const configKey = useV2Plugin ? 'plugins' : 'plugin';
  const otherKey = useV2Plugin ? 'plugin' : 'plugins';
  for (const base of [`${name}.json`, `${name}.jsonc`]) {
    const cfgFile = path.join(cfgRoot, base);
    if (!fs.existsSync(cfgFile)) continue;
    let raw, obj, stripped = false;
    try { raw = fs.readFileSync(cfgFile, 'utf8'); obj = JSON.parse(raw); }
    catch {
      try { raw = fs.readFileSync(cfgFile, 'utf8'); obj = JSON.parse(stripJsonc(raw)); stripped = true; }
      catch { log.warn(`${base} has comments/!JSON — not auto-editing; add ${wanted.join(', ')} to "plugin"`); return; }
    }
    if (stripped) log.warn(`${base} had comments — rewriting as plain JSON to add plugins (comments will be dropped; back up if needed)`);
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
    if (!isDry()) fs.writeFileSync(cfgFile, JSON.stringify(obj, null, 2) + '\n');
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

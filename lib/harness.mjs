// harness.mjs — wire opencode / mimocode onto the bus.
// Copies (not symlinks — Windows-safe) the shared plugins into each harness
// plugin dir, best-effort ensures the @opencode-ai/plugin dep resolves, and
// installs the xats skill. Config edits are NOT auto-applied (to avoid
// clobbering user jsonc); precise guidance is printed instead.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { log, isDry, copyFile, ensureDir } from './log.mjs';
import { npmBin, runNpm, IS_WIN } from './platform.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(__dir, '..', 'assets');
const PLUGIN_FILES = ['xats-register.ts', 'notify-unified.ts'];
const PLUGIN_DEP = '@opencode-ai/plugin@^1.17.18';

function resolvable(dep, fromDir) {
  try { fs.accessSync(path.join(fromDir, 'node_modules', dep.split('@').slice(0, -1).join('@') || dep)); return true; }
  catch { return false; }
}

function wireOne(name, cfgRoot) {
  if (!fs.existsSync(cfgRoot)) { log.info(`${name} not installed (${cfgRoot}) — skipping`); return null; }
  const pluginsDir = path.join(cfgRoot, 'plugins');
  ensureDir(pluginsDir);
  for (const f of PLUGIN_FILES) copyFile(path.join(ASSETS, 'plugins', f), path.join(pluginsDir, f));

  // best-effort: make @opencode-ai/plugin importable from the plugins dir
  const depBase = '@opencode-ai/plugin';
  if (!resolvable(depBase, cfgRoot) && !isDry()) {
    if (npmBin()) {
      log.info(`installing ${PLUGIN_DEP} into ${cfgRoot}…`);
      const r = runNpm(['install', '--prefix', cfgRoot, '--no-audit', '--no-fund', PLUGIN_DEP],
        { stdio: ['ignore', 'ignore', 'pipe'] });
      if (r.ok) log.ok('plugin dep installed'); else log.warn('could not install plugin dep (opencode may provide it at runtime)');
    }
  }

  // Reference the plugins from the config's "plugin" array so the harness loads
  // them. Best-effort + SAFE: only rewrite when the config parses as strict JSON
  // (no comments) — otherwise we could clobber a hand-tuned jsonc, so we just
  // print the note instead.
  ensurePluginConfig(name, cfgRoot);

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
function ensurePluginConfig(name, cfgRoot) {
  const wanted = PLUGIN_FILES.map((f) => `./plugins/${f}`);
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
    const cur = Array.isArray(obj.plugin) ? obj.plugin : [];
    const missing = wanted.filter((w) => !cur.includes(w));
    if (!missing.length) { log.info(`${base}: plugin entries already present`); return; }
    obj.plugin = [...cur, ...missing];
    if (obj.mcp && obj.mcp['cross-agent-teams']) obj.mcp['cross-agent-teams'].enabled = false; // the plugin owns xats
    if (!isDry()) fs.writeFileSync(cfgFile, JSON.stringify(obj, null, 2) + '\n');
    log.ok(`${base}: added ${missing.length} plugin entr${missing.length === 1 ? 'y' : 'ies'}`);
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
    log.info('  "./plugins/notify-unified.ts", "./plugins/xats-register.ts"');
    }
  return results;
}

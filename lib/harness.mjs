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

function ensurePluginConfig(name, cfgRoot) {
  const wanted = PLUGIN_FILES.map((f) => `./plugins/${f}`);
  for (const base of [`${name}.json`, `${name}.jsonc`]) {
    const cfgFile = path.join(cfgRoot, base);
    if (!fs.existsSync(cfgFile)) continue;
    let raw, obj;
    try { raw = fs.readFileSync(cfgFile, 'utf8'); obj = JSON.parse(raw); }
    catch { log.warn(`${base} has comments/!JSON — not auto-editing; add ${wanted.join(', ')} to "plugin" and disable any cross-agent-teams MCP entry`); return; }
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

export function installHarnesses(paths) {
  log.step('opencode / mimocode: plugins + skill');
  const cfgDir = (p) => path.dirname(p); // .../opencode/plugins -> .../opencode
  const results = [
    wireOne('opencode', cfgDir(paths.opencodePlugins)),
    wireOne('mimocode', cfgDir(paths.mimocodePlugins)),
  ].filter(Boolean);

  // Claude also reads a skills dir — drop the xats skill there too.
  if (fs.existsSync(paths.claudeDir)) {
    copyFile(path.join(ASSETS, 'skills', 'xats', 'SKILL.md'),
      path.join(paths.claudeDir, 'skills', 'xats', 'SKILL.md'));
  }

  if (results.length) {
    log.info('config note: ensure each harness loads the plugin dir. For configs that list');
    log.info('plugins explicitly (e.g. mimocode.json "plugin": [...]), add:');
    log.info('  "./plugins/notify-unified.ts", "./plugins/xats-register.ts"');
    log.info('and set any "cross-agent-teams" MCP entry "enabled": false (the plugin owns xats).');
  }
  return results;
}

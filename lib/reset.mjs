// reset.mjs — remove only the files and config entries owned by xats-setup.
import fs from 'node:fs';
import path from 'node:path';
import { log, isDry, readJson, readConfigJson, writeConfigJson, configError, isConfigObject } from './log.mjs';
import { IS_WIN, IS_MAC, IS_LINUX, IS_ROOT, HOME, which, run, nodeBin, ownedDaemon } from './platform.mjs';
import { disablePeerService, isPeerServiceEnabled } from './peer-service.mjs';
import { resetCodex, readCodexHooks } from './codex.mjs';
import { preflightClaudeConfig } from './claude.mjs';
import { daemonLayout } from './daemon.mjs';
import { SERVICE_NAME } from './constants.mjs';
import { portFile } from './platform.mjs';
import { stripJsonc } from './harness.mjs';

function remove(file) {
  if (!fs.existsSync(file)) return;
  if (isDry()) return log.dry(`remove ${file}`);
  fs.rmSync(file, { recursive: true, force: true });
  log.ok(`removed ${file}`);
}

function removeHook(settings, event) {
  const groups = settings.hooks?.[event];
  if (!Array.isArray(groups)) return false;
  let changed = false;
  settings.hooks[event] = groups.map((group) => {
    const hooks = (group.hooks || []).filter((hook) => {
      const owned = typeof hook.command === 'string' && hook.command.includes('xats-hook');
      changed ||= owned;
      return !owned;
    });
    return { ...group, hooks };
  }).filter((group) => group.hooks.length);
  if (!settings.hooks[event].length) delete settings.hooks[event];
  if (!Object.keys(settings.hooks || {}).length) delete settings.hooks;
  return changed;
}

function resetClaude(paths) {
  const settings = readConfigJson(paths.claudeSettings, null);
  if (settings) {
    const startChanged = removeHook(settings, 'SessionStart');
    const endChanged = removeHook(settings, 'SessionEnd');
    const hooksChanged = startChanged || endChanged;
    // Drop the mod's plugin dir, leaving any dirs the user added themselves.
    let envChanged = false;
    const dirs = settings.env?.CLAUDE_CODE_PLUGIN_DIRS;
    if (typeof dirs === 'string') {
      const modDir = path.join(paths.xatsRoot, 'claude-mod');
      const sep = IS_WIN ? ';' : ':';
      const kept = dirs.split(sep).map((s) => s.trim()).filter((s) => s && s !== modDir);
      if (kept.length !== dirs.split(sep).filter((s) => s.trim()).length) {
        envChanged = true;
        if (kept.length > 0) settings.env.CLAUDE_CODE_PLUGIN_DIRS = kept.join(sep);
        else delete settings.env.CLAUDE_CODE_PLUGIN_DIRS;
        if (Object.keys(settings.env).length === 0) delete settings.env;
      }
    }
    if (hooksChanged || envChanged) writeConfigJson(paths.claudeSettings, settings);
  }
  const claude = readConfigJson(paths.claudeJson, null);
  let jsonChanged = false;
  if (claude?.mcpServers?.['cross-agent-teams']?.url === 'http://127.0.0.1:9100/mcp') {
    delete claude.mcpServers['cross-agent-teams'];
    jsonChanged = true;
    log.ok('removed Claude cross-agent-teams MCP entry');
  }
  if (claude?.mcpServers?.['cross-agent-teams-channel']) {
    delete claude.mcpServers['cross-agent-teams-channel'];
    jsonChanged = true;
    log.ok('removed Claude channel proxy MCP entry');
  }
  if (jsonChanged) {
    if (!Object.keys(claude.mcpServers).length) delete claude.mcpServers;
    writeConfigJson(paths.claudeJson, claude);
  }
  remove(path.join(paths.xatsRoot, 'claude-mod'));
  remove(path.join(paths.claudeDir, 'skills', 'xats'));
}

function readHarnessConfig(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw configError(file, `cannot read file (${error.code || 'I/O error'})`);
  }
  let config;
  try { config = JSON.parse(file.endsWith('.jsonc') ? stripJsonc(raw) : raw); }
  catch { throw configError(file, 'invalid JSON/JSONC'); }
  if (!isConfigObject(config)) throw configError(file, 'expected a JSON object');
  return config;
}

function resetHarnessConfig(file) {
  const config = readHarnessConfig(file);
  if (!config) return;
  let changed = false;
  for (const key of ['plugin', 'plugins']) {
    if (!Array.isArray(config[key])) continue;
    const before = config[key].length;
    config[key] = config[key].filter((entry) => entry !== './plugins/xats-register.ts' && entry !== './plugins/notify-unified.ts');
    if (config[key].length === before) continue;
    changed = true;
    if (!config[key].length) delete config[key];
  }
  if (!changed) return;
  if (file.endsWith('.jsonc')) log.warn(`${file} may have comments; raw backup retained before rewriting as JSON`);
  writeConfigJson(file, config);
  log.ok(`removed xats plugin entries from ${file}`);
}

function stopService(paths) {
  const info = readJson(path.join(paths.daemonState, 'daemon.pid'), null);
  const pid = info?.pid;
  if (pid && !isDry()) {
    if (ownedDaemon(paths, info.port, daemonLayout(paths).entry)?.pid === pid) {
      try { process.kill(pid, 'SIGTERM'); log.ok(`stopped daemon pid ${pid}`); } catch { /* already stopped */ }
    } else log.warn('Unverified daemon PID was not signalled; the supervisor controls its own service.');
  }
  if (IS_LINUX && which('systemctl')) {
    if (!isDry()) run(which('systemctl'), IS_ROOT ? ['disable', '--now', SERVICE_NAME] : ['--user', 'disable', '--now', SERVICE_NAME]);
    else log.dry(`systemctl disable --now ${SERVICE_NAME}`);
    remove(IS_ROOT ? `/etc/systemd/system/${SERVICE_NAME}.service` : path.join(HOME, '.config', 'systemd', 'user', `${SERVICE_NAME}.service`));
  } else if (IS_MAC) {
    const plist = path.join(HOME, 'Library', 'LaunchAgents', 'com.xats.daemon.plist');
    if (!isDry()) run(which('launchctl') || 'launchctl', ['unload', plist]);
    remove(plist);
  } else if (IS_WIN) {
    if (!isDry()) run(which('schtasks') || 'schtasks', ['/Delete', '/TN', SERVICE_NAME, '/F']);
    remove(path.join(HOME, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'xats-daemon.vbs'));
  }
}

function resetOpencode(paths) {
  const root = path.dirname(paths.opencodePlugins);
  resetHarnessConfig(path.join(root, 'opencode.json'));
  resetHarnessConfig(path.join(root, 'opencode.jsonc'));
  remove(path.join(root, 'plugins', 'xats-register.ts'));
  remove(path.join(root, 'plugins', 'notify-unified.ts'));
  remove(path.join(root, 'plugins', 'xats-tui'));
  remove(path.join(root, 'skills', 'xats'));
}
function resetMimocode(paths) {
  const root = path.dirname(paths.mimocodePlugins);
  resetHarnessConfig(path.join(root, 'mimocode.json'));
  resetHarnessConfig(path.join(root, 'mimocode.jsonc'));
  remove(path.join(root, 'plugins', 'xats-register.ts'));
  remove(path.join(root, 'plugins', 'notify-unified.ts'));
  remove(path.join(root, 'skills', 'xats'));
}
function resetPi(paths) {
  remove(path.join(paths.piExtensions, 'xats.ts'));
  remove(path.join(paths.piSkills, 'xats'));
  if (IS_WIN) {
    const wslBin = which('wsl.exe') || which('wsl');
    if (wslBin) {
      if (isDry()) log.dry('wsl -- rm -rf ~/.pi/agent/extensions/xats.ts');
      else {
        run(wslBin, ['-e','sh','-lc', 'rm -rf ~/.pi/agent/extensions/xats.ts ~/.pi/agent/skills/xats 2>/dev/null; echo done'], { timeout: 3000 });
        log.ok('cleared WSL pi extension');
      }
    }
  }
  // label persisted for Pi's stable name (shared with omp)
  remove(path.join(paths.xatsRoot, 'label'));
  if (IS_WIN) {
    if (isDry()) log.dry('reg delete HKCU\\Environment /V XATS_LABEL /F + setx XATS_LABEL ""');
    else {
      run('reg', ['delete', 'HKCU\\Environment', '/V', 'XATS_LABEL', '/F']);
      const setx = which('setx') || which('setx.exe') || 'setx';
      run(setx, ['XATS_LABEL', '']);
      log.ok('cleared XATS_LABEL from user environment (new shells)');
    }
  }
}
function resetAgy(paths) {
  remove(paths.agyPlugin);
}
function resetOmp(paths) {
  remove(path.join(paths.ompExtensions, 'xats.ts'));
  remove(path.join(paths.ompSkills, 'xats'));
  if (IS_WIN) {
    const wslBin = which('wsl.exe') || which('wsl');
    if (wslBin) {
      if (isDry()) log.dry('wsl -- rm -rf ~/.omp/agent/extensions/xats.ts');
      else {
        run(wslBin, ['-e','sh','-lc', 'rm -rf ~/.omp/agent/extensions/xats.ts ~/.omp/agent/skills/xats 2>/dev/null; echo done'], { timeout: 3000 });
        log.ok('cleared WSL omp extension');
      }
    }
  }
}

export function reset(paths, components) {
  const sel = components instanceof Set ? components : null;
  const want = (k) => !sel || sel.has(k);
  // harness alias on reset means opencode+mimocode+pi (back-compat, not omp)
  const wantHarness = sel ? sel.has('harness') : false;
  const wantOpencode = want('opencode') || wantHarness;
  const wantMimocode = want('mimocode') || wantHarness;
  const wantPi = want('pi') || wantHarness;
  // Preflight all selected user configs before stopping services or deleting files.
  if (want('claude')) preflightClaudeConfig(paths);
  if (want('codex')) readCodexHooks(paths);
  for (const [enabled, plugins, name] of [[wantOpencode, paths.opencodePlugins, 'opencode'], [wantMimocode, paths.mimocodePlugins, 'mimocode']]) {
    if (!enabled) continue;
    for (const ext of ['json', 'jsonc']) readHarnessConfig(path.join(path.dirname(plugins), `${name}.${ext}`));
  }
  log.step('Reset: remove xats-setup changes' + (sel ? ` (${[...sel].join(',')})` : ''));
  if (want('peer')) {
    const peerEntry = path.join(paths.xatsRoot, 'peer', 'peer.mjs');
    const managed = isPeerServiceEnabled(paths);
    const serviceRemoved = disablePeerService(paths, { force: true });
    if (!managed && !serviceRemoved && fs.existsSync(peerEntry) && !isDry()) run(nodeBin(), [peerEntry, 'stop'], { timeout: 5000 });
    if (fs.existsSync(peerEntry)) {
      if (!isDry()) {
        const cleaned = run(nodeBin(), [peerEntry, 'clean-shadows'], { timeout: 15_000 });
        if (!cleaned.ok) log.warn(`could not remove peer shadow agents from the local bus: ${cleaned.stderr || cleaned.stdout || cleaned.code}`);
      } else log.dry('remove peer shadow agents from the local bus');
    }
    remove(path.join(paths.xatsRoot, 'peer'));
  }
  if (want('daemon') || want('service')) stopService(paths);
  if (want('claude')) resetClaude(paths);
  if (want('codex')) { const { hookDest, skillsDir } = resetCodex(paths); remove(hookDest); remove(skillsDir); }
  if (wantOpencode) resetOpencode(paths);
  if (wantMimocode) resetMimocode(paths);
  if (wantPi) resetPi(paths);
  if (want('omp')) resetOmp(paths);
  if (want('agy')) resetAgy(paths);
  // per-component daemon/bridge cleanup (full wipe handled below)
  if (sel && want('daemon')) { remove(path.join(paths.xatsRoot, 'daemon')); remove(portFile(paths)); }
  if (sel && want('bridge')) remove(path.join(paths.xatsRoot, 'bridge'));
  // full wipe or daemon+service+bridge: remove entire xatsRoot (includes label/port)
  if (!sel) remove(paths.xatsRoot);
  log.ok('xats-setup reset complete');
}

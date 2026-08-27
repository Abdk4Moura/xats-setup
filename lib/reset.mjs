// reset.mjs — remove only the files and config entries owned by xats-setup.
import fs from 'node:fs';
import path from 'node:path';
import { log, isDry, readJson, writeJson } from './log.mjs';
import { IS_WIN, IS_MAC, IS_LINUX, IS_ROOT, HOME, which, run } from './platform.mjs';
import { SERVICE_NAME } from './constants.mjs';
import { portFile } from './platform.mjs';

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
  const settings = readJson(paths.claudeSettings, null);
  if (settings && (removeHook(settings, 'SessionStart') || removeHook(settings, 'SessionEnd'))) writeJson(paths.claudeSettings, settings);
  const claude = readJson(paths.claudeJson, null);
  if (claude?.mcpServers?.['cross-agent-teams']?.url === 'http://127.0.0.1:9100/mcp') {
    delete claude.mcpServers['cross-agent-teams'];
    if (!Object.keys(claude.mcpServers).length) delete claude.mcpServers;
    writeJson(paths.claudeJson, claude);
    log.ok('removed Claude cross-agent-teams MCP entry');
  }
  remove(path.join(paths.claudeDir, 'skills', 'xats'));
}

function resetHarnessConfig(file) {
  const config = readJson(file, null);
  if (!config || !Array.isArray(config.plugin)) return;
  const before = config.plugin.length;
  config.plugin = config.plugin.filter((entry) => entry !== './plugins/xats-register.ts' && entry !== './plugins/notify-unified.ts');
  if (config.plugin.length === before) return;
  if (!config.plugin.length) delete config.plugin;
  writeJson(file, config);
  log.ok(`removed xats plugin entries from ${file}`);
}

function stopService(paths) {
  const pid = readJson(path.join(paths.daemonState, 'daemon.pid'), null)?.pid;
  if (pid && !isDry()) { try { process.kill(pid, 'SIGTERM'); log.ok(`stopped daemon pid ${pid}`); } catch {} }
  if (IS_LINUX && which('systemctl')) {
    run(which('systemctl'), IS_ROOT ? ['disable', '--now', SERVICE_NAME] : ['--user', 'disable', '--now', SERVICE_NAME]);
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
  log.step('Reset: remove xats-setup changes' + (sel ? ` (${[...sel].join(',')})` : ''));
  if (want('daemon') || want('service')) stopService(paths);
  if (want('claude')) resetClaude(paths);
  if (wantOpencode) resetOpencode(paths);
  if (wantMimocode) resetMimocode(paths);
  if (wantPi) resetPi(paths);
  if (want('omp')) resetOmp(paths);
  // per-component daemon/bridge cleanup (full wipe handled below)
  if (sel && want('daemon')) { remove(path.join(paths.xatsRoot, 'daemon')); remove(portFile(paths)); }
  if (sel && want('bridge')) remove(path.join(paths.xatsRoot, 'bridge'));
  // full wipe or daemon+service+bridge: remove entire xatsRoot (includes label/port)
  if (!sel) remove(paths.xatsRoot);
  log.ok('xats-setup reset complete');
}

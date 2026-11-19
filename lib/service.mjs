// Register the daemon without restarting unchanged installations or replacing
// customized supervisor definitions. All process termination requires identity.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { log, isDry, writeFile, writeConfigFile } from './log.mjs';
import { IS_WIN, IS_MAC, IS_LINUX, IS_ROOT, HOME, nodeBin, which, run, paths as getPaths, ownedDaemon, isPortFree } from './platform.mjs';
import { PORT as DEFAULT_PORT, SERVICE_NAME } from './constants.mjs';

function effectivePort(port) {
  return Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT;
}
function linuxFile() {
  return IS_ROOT ? `/etc/systemd/system/${SERVICE_NAME}.service` : path.join(HOME, '.config', 'systemd', 'user', `${SERVICE_NAME}.service`);
}
function macFile() { return path.join(HOME, 'Library', 'LaunchAgents', 'com.xats.daemon.plist'); }
function systemctl(args) { return run(which('systemctl'), IS_ROOT ? args : ['--user', ...args]); }
function checked(result, action) {
  if (!result.ok) throw new Error(`${action} failed: ${result.stderr || result.error?.message || result.code}. Check your daemon service and rerun setup.`);
}
export function preserveDefinition(file, content, legacy = null) {
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== content) {
    const old = fs.readFileSync(file, 'utf8');
    if (old !== legacy) throw new Error(`Existing daemon service definition differs: ${file}. Setup preserved it (including custom environment). Back it up and reconcile or remove it explicitly before rerunning setup.`);
    if (!isDry()) fs.writeFileSync(`${file}.backup-${Date.now()}`, old, { mode: 0o600, flag: 'wx' });
  }
  return writeFile(file, content);
}
function linuxUnit(entry, port, paths = null) {
  // Keep the original generated format so unchanged legacy units are retained.
  return ['[Unit]', 'Description=cross-agent-teams (xats) daemon \u2014 local cross-agent bus on :' + port,
    'After=network.target', '', '[Service]', `ExecStart=${nodeBin()} ${entry} daemon --port ${port}${paths ? ' ' + scopeArgs(paths).map((s) => '"' + s.replace(/[%"\\]/g, (c) => c === '%' ? '%%' : '\\' + c) + '"').join(' ') : ''}`,
    'Restart=always', 'RestartSec=3', '', '[Install]', `WantedBy=${IS_ROOT ? 'multi-user.target' : 'default.target'}`, ''].join('\n');
}
function macPlist(entry, port, paths = null) {
  const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.xats.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodeBin())}</string>
    <string>${xml(entry)}</string>
    <string>daemon</string>
    <string>--port</string>
    <string>${port}</string>${paths ? '\n' + scopeArgs(paths).map((s) => `    <string>${xml(s)}</string>`).join('\n') : ''}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
`;
}
async function stopOwned(paths, entry, port) {
  const own = ownedDaemon(paths, port, entry);
  if (!own) throw new Error('Cannot verify daemon process identity. Stop the existing daemon with its supervisor before rerunning setup.');
  // Recheck immediately before signalling, never trust a stale pid file alone.
  if (ownedDaemon(paths, port, entry)?.pid !== own.pid) throw new Error('Daemon identity changed; refusing to signal it.');
  process.kill(own.pid, 'SIGTERM');
  for (let i = 0; i < 100; i++) {
    let alive = true;
    try { process.kill(own.pid, 0); } catch { alive = false; }
    if (!alive && await isPortFree(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Daemon did not stop. No replacement was launched; check the supervisor.');
}
export async function waitForDaemon(paths, entry, port, previousPid = null) {
  for (let i = 0; i < 100; i++) {
    const own = ownedDaemon(paths, port, entry);
    if (own && own.pid !== previousPid) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
        if (r.ok && (await r.json()).ok === true && ownedDaemon(paths, port, entry)?.pid === own.pid) return own;
      } catch { /* wait for readiness */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Daemon failed verified startup on :${port}. Check service logs and daemon.pid.`);
}
function scopeArgs(paths) {
  return ['--db', path.join(paths.daemonState, 'data.db'), '--pid-file', path.join(paths.daemonState, 'daemon.pid')];
}
function requireOwner(paths, entry, port) {
  const own = ownedDaemon(paths, port, entry);
  if (!own) throw new Error(`Cannot prove ownership of daemon on :${port}. Inspect its PID, command line, socket and database scope. Native probes may require lsof or PowerShell permissions; legacy services need explicit --db and --pid-file arguments.`);
  return own;
}
export async function ensureDaemon(paths, entry, port, updated = false) {
  validateNativePaths(paths, entry);
  if (isDry()) { log.dry(`ensure daemon running on :${port}${updated ? ' with updated build' : ''}`); return; }
  const own = ownedDaemon(paths, port, entry);
  if (own && !updated) return waitForDaemon(paths, entry, port);
  if (own) await stopOwned(paths, entry, port);
  if (!await isPortFree(port)) throw new Error(`Port :${port} is occupied; refusing to launch another daemon.`);
  // The daemon itself refuses a live pid file. Report this rather than silently
  // launching a process that will immediately exit, or killing a recycled PID.
  try {
    const info = JSON.parse(fs.readFileSync(path.join(paths.daemonState, 'daemon.pid'), 'utf8'));
    if (Number.isInteger(info.pid) && info.pid > 0) {
      let alive = false;
      try { process.kill(info.pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
      if (alive) throw new Error('Live unverified daemon.pid. Inspect the process and repair the pid file before rerunning setup.');
    }
  } catch (e) { if (e.message.startsWith('Live unverified')) throw e; }
  const child = spawn(nodeBin(), [entry, 'daemon', '--port', String(port), ...scopeArgs(paths)], { detached: true, stdio: 'ignore', windowsHide: true });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  return waitForDaemon(paths, entry, port, own?.pid);
}

function validateDefinition(file, desired, legacy) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  if (text !== desired && text !== legacy) throw new Error(`Existing daemon service definition differs: ${file}. Setup preserved it (including custom environment). Reconcile it manually before rerunning setup.`);
}
const xmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const xmlDecode = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
function windowsArgs(entry, port, paths = null) {
  return `"${entry}" daemon --port ${port}${paths ? ' ' + scopeArgs(paths).map((s) => '"' + s + '"').join(' ') : ''}`;
}
function vbsFile() { return path.join(HOME, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'xats-daemon.vbs'); }
function vbsContent(entry, port, paths = null) {
  const cmd = `"${nodeBin()}" ${windowsArgs(entry, port, paths)}`.replace(/"/g, '""');
  return `Set s = CreateObject("WScript.Shell")\r\ns.Run "${cmd}", 0, False\r\n`;
}
function validateNativePaths(paths, entry) {
  // ps command output on macOS does not quote argv boundaries. Reject paths
  // it cannot prove before writing a service or launching any process.
  if (IS_MAC && [nodeBin(), entry, paths.daemonState].some((s) => /[\s"'\\]/.test(s))) throw new Error('macOS daemon paths contain ambiguous whitespace or quoting. Use paths without spaces or quotes before retrying setup.');
  if (IS_LINUX && [nodeBin(), entry].some((s) => /[\s%"'\\]/.test(s))) throw new Error('systemd daemon executable paths contain unsupported quoting. Use paths without spaces or quotes before retrying setup.');
}
// Read-only validation. register=false checks only existing supervisors for a
// daemon-only upgrade. No files, signals, or supervisor state are modified.
// Returns { kind, task? }; task is the verified Windows XML migration plan.
export async function preflightService(lay, { paths = getPaths(), port = DEFAULT_PORT, register = true, updated = lay.updated ?? false } = {}) {
  port = effectivePort(port);
  validateNativePaths(paths, lay.entry);
  let kind = 'detached'; let task = null;
  if (IS_LINUX && which('systemctl')) {
    if (register || fs.existsSync(linuxFile())) {
      kind = IS_ROOT ? 'systemd-system' : 'systemd-user';
      validateDefinition(linuxFile(), linuxUnit(lay.entry, port, paths), linuxUnit(lay.entry, port));
    }
  } else if (IS_MAC && (register || fs.existsSync(macFile()))) {
    kind = 'launchd';
    validateDefinition(macFile(), macPlist(lay.entry, port, paths), macPlist(lay.entry, port));
  } else if (IS_WIN) {
    validateDefinition(vbsFile(), vbsContent(lay.entry, port, paths), vbsContent(lay.entry, port));
    kind = 'schtasks';
    if (!isDry()) {
      const result = run(which('schtasks') || 'schtasks', ['/Query', '/TN', SERVICE_NAME, '/XML']);
      if (result.ok) {
        const xml = result.stdout;
        const actions = xml.match(/<Actions(?:\s[^>]*)?>[\s\S]*?<\/Actions>/g);
        const action = actions?.length === 1 ? actions[0] : '';
        const commands = [...action.matchAll(/<Command>([\s\S]*?)<\/Command>/g)];
        const args = [...action.matchAll(/<Arguments>([\s\S]*?)<\/Arguments>/g)];
        const exe = commands.length === 1 ? xmlDecode(commands[0][1]) : '';
        const argv = args.length === 1 ? xmlDecode(args[0][1]) : '';
        const legacy = argv === windowsArgs(lay.entry, port);
        if (exe.toLowerCase() !== nodeBin().toLowerCase() || (!legacy && argv !== windowsArgs(lay.entry, port, paths)) || /<WorkingDirectory>|<ComHandler>|<SendEmail>|<ShowMessage>/i.test(action)) throw new Error(`Scheduled Task ${SERVICE_NAME} has an unverified/custom action. It was preserved; reconcile it manually with explicit --db and --pid-file scope.`);
        task = { xml, legacy };
      } else if (!/cannot find|not exist|not found|0x80070002/i.test(result.stderr + result.stdout)) {
        throw new Error('Cannot inspect existing Scheduled Task safely. Check permissions and retry; no service changes were made.');
      }
    }
  }
  if (!isDry() && !await isPortFree(port)) requireOwner(paths, lay.entry, port);
  return { kind, task, updated };
}

export async function installService(lay, opts = {}) {
  const port = effectivePort(opts.port);
  const paths = opts.paths || getPaths();
  const updated = opts.updated ?? lay.updated ?? false;
  await preflightService(lay, { paths, port, updated });
  log.step('Service: register daemon to run at login/boot');
  if (!isDry() && !await isPortFree(port)) requireOwner(paths, lay.entry, port);
  if (IS_LINUX && which('systemctl')) {
    const changed = preserveDefinition(linuxFile(), linuxUnit(lay.entry, port, paths), linuxUnit(lay.entry, port));
    if (!isDry()) {
      const active = systemctl(['is-active', '--quiet', SERVICE_NAME]).ok;
      const previous = ownedDaemon(paths, port, lay.entry);
      // Do not start a supervisor on top of an already detached daemon.
      if (!active && ownedDaemon(paths, port, lay.entry)) await stopOwned(paths, lay.entry, port);
      if (changed) checked(systemctl(['daemon-reload']), 'systemd daemon-reload');
      checked(systemctl(['enable', SERVICE_NAME]), 'systemd enable');
      if (!IS_ROOT && which('loginctl')) run(which('loginctl'), ['enable-linger', os.userInfo().username]);
      if (!active || changed || updated) checked(systemctl([active ? 'restart' : 'start', SERVICE_NAME]), 'systemd start/restart');
      await waitForDaemon(paths, lay.entry, port, active && (changed || updated) ? previous?.pid : null);
    }
    return { kind: IS_ROOT ? 'systemd-system' : 'systemd-user', updated: changed || updated };
  }
  if (IS_MAC) {
    const file = macFile();
    const changed = preserveDefinition(file, macPlist(lay.entry, port, paths), macPlist(lay.entry, port));
    if (!isDry()) {
      const ctl = which('launchctl') || 'launchctl';
      const loaded = run(ctl, ['list', 'com.xats.daemon']).ok;
      const previous = ownedDaemon(paths, port, lay.entry);
      if (!loaded && ownedDaemon(paths, port, lay.entry)) await stopOwned(paths, lay.entry, port);
      if (loaded && (changed || updated)) checked(run(ctl, ['unload', file]), 'launchd unload');
      if (!loaded || changed || updated) checked(run(ctl, ['load', '-w', file]), 'launchd load');
      await waitForDaemon(paths, lay.entry, port, loaded && (changed || updated) ? previous?.pid : null);
    }
    return { kind: 'launchd', plist: file };
  }
  if (IS_WIN) {
    const plan = await preflightService(lay, { paths, port, updated });
    let kind = 'schtasks';
    if (!isDry()) {
      const ctl = which('schtasks') || 'schtasks';
      if (plan.task?.legacy) {
        // Preserve the complete original XML and all non-action task settings.
        const backup = path.join(paths.xatsRoot, `daemon-task.backup-${Date.now()}.xml`);
        writeConfigFile(backup, plan.task.xml);
        const xml = plan.task.xml.replace(/<Arguments>[\s\S]*?<\/Arguments>/, `<Arguments>${xmlEscape(windowsArgs(lay.entry, port, paths))}</Arguments>`);
        const temp = path.join(paths.xatsRoot, `daemon-task-${process.pid}.xml`);
        try {
          fs.writeFileSync(temp, xml, { mode: 0o600 });
          checked(run(ctl, ['/Create', '/TN', SERVICE_NAME, '/XML', temp, '/F']), 'Scheduled Task migration');
        } finally { fs.rmSync(temp, { force: true }); }
      } else if (!plan.task) {
        const r = run(ctl, ['/Create', '/SC', 'ONLOGON', '/TN', SERVICE_NAME, '/TR', `"${nodeBin()}" ${windowsArgs(lay.entry, port, paths)}`, '/RL', 'LIMITED']);
        if (!r.ok) {
          preserveDefinition(vbsFile(), vbsContent(lay.entry, port, paths), vbsContent(lay.entry, port));
          kind = 'startup-vbs';
        }
      }
      if (kind === 'schtasks' && fs.existsSync(vbsFile())) {
        // Preflight proved this exact launcher is ours. Keep a recoverable copy.
        writeConfigFile(path.join(paths.xatsRoot, `daemon-startup.backup-${Date.now()}.vbs`), fs.readFileSync(vbsFile()));
        fs.unlinkSync(vbsFile());
      }
    }
    await ensureDaemon(paths, lay.entry, port, updated);
    return { kind };
  }
  await ensureDaemon(paths, lay.entry, port, updated);
  return { kind: 'detached' };
}

// Daemon-only upgrades may use an existing supervisor, but never create one.
export async function restartDaemon(paths, entry, port = DEFAULT_PORT) {
  port = effectivePort(port);
  const plan = await preflightService({ entry }, { paths, port, register: false, updated: true });
  if (IS_WIN && plan.task) return installService({ entry, updated: true }, { paths, port, updated: true });
  if (isDry()) { log.dry('restart daemon (build changed)'); return; }
  if (IS_LINUX && which('systemctl') && fs.existsSync(linuxFile())) {
    const changed = preserveDefinition(linuxFile(), linuxUnit(entry, port, paths), linuxUnit(entry, port));
    const previous = ownedDaemon(paths, port, entry);
    const active = systemctl(['is-active', '--quiet', SERVICE_NAME]).ok;
    if (active && !previous && !await isPortFree(port)) requireOwner(paths, entry, port);
    if (!active && previous) await stopOwned(paths, entry, port);
    if (changed) checked(systemctl(['daemon-reload']), 'systemd daemon-reload');
    checked(systemctl([active ? 'restart' : 'start', SERVICE_NAME]), 'systemd start/restart');
    return waitForDaemon(paths, entry, port, previous?.pid);
  }
  if (IS_MAC && fs.existsSync(macFile())) {
    preserveDefinition(macFile(), macPlist(entry, port, paths), macPlist(entry, port));
    const ctl = which('launchctl') || 'launchctl';
    const previous = ownedDaemon(paths, port, entry);
    if (run(ctl, ['list', 'com.xats.daemon']).ok) checked(run(ctl, ['unload', macFile()]), 'launchd unload');
    checked(run(ctl, ['load', '-w', macFile()]), 'launchd load');
    return waitForDaemon(paths, entry, port, previous?.pid);
  }
  await ensureDaemon(paths, entry, port, true);
}

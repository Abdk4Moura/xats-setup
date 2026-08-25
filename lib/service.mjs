// service.mjs — register the daemon to run at login/boot, per-OS.
//   Linux : systemd (system unit if root, else --user + linger)
//   macOS : launchd LaunchAgent (RunAtLoad + KeepAlive)
//   Windows: Scheduled Task (ONLOGON) + start-now
// Always also starts the daemon immediately so setup doesn't require a re-login.
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { log, isDry, writeFile, ensureDir, readJson } from './log.mjs';
import { IS_WIN, IS_MAC, IS_LINUX, IS_ROOT, HOME, nodeBin, which, run } from './platform.mjs';
import { PORT as DEFAULT_PORT, SERVICE_NAME, BASE_URL as DEFAULT_BASE } from './constants.mjs';

function effectivePort(explicit) {
  return Number.isInteger(explicit) && explicit > 0 ? explicit : DEFAULT_PORT;
}
function baseFor(port) {
  return `http://127.0.0.1:${port}`;
}

function startNow(entry, port = DEFAULT_PORT) {
  const p = effectivePort(port);
  if (isDry()) return log.dry(`start daemon now: node ${entry} daemon --port ${p}`);
  try {
    const child = spawn(nodeBin(), [entry, 'daemon', '--port', String(p)],
      { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    log.ok(`daemon started (detached) on :${p}`);
  } catch (e) {
    log.warn(`could not start daemon now: ${e.message}`);
  }
}

// ---------- Linux / systemd ----------
function installLinux(entry, port = DEFAULT_PORT) {
  const systemctl = which('systemctl');
  const unit = [
    '[Unit]',
    'Description=cross-agent-teams (xats) daemon — local cross-agent bus on :' + effectivePort(port),
    'After=network.target',
    '',
    '[Service]',
    `ExecStart=${nodeBin()} ${entry} daemon --port ${effectivePort(port)}`,
    'Restart=always',
    'RestartSec=3',
    '',
    `[Install]`,
    `WantedBy=${IS_ROOT ? 'multi-user.target' : 'default.target'}`,
    '',
  ].join('\n');

  if (!systemctl) {
    log.warn('systemctl not found (non-systemd host/container) — using detached start only');
    startNow(entry, port);
    return { kind: 'detached', note: 'no systemd; add your own supervisor for boot-start' };
  }

  if (IS_ROOT) {
    writeFile(`/etc/systemd/system/${SERVICE_NAME}.service`, unit);
    if (!isDry()) {
      run(systemctl, ['daemon-reload']);
      run(systemctl, ['enable', '--now', SERVICE_NAME]);
    }
    log.ok(`systemd system service '${SERVICE_NAME}' enabled`);
    return { kind: 'systemd-system' };
  }
  const userDir = path.join(HOME, '.config', 'systemd', 'user');
  ensureDir(userDir);
  writeFile(path.join(userDir, `${SERVICE_NAME}.service`), unit);
  if (!isDry()) {
    run(systemctl, ['--user', 'daemon-reload']);
    run(systemctl, ['--user', 'enable', '--now', SERVICE_NAME]);
    const loginctl = which('loginctl');
    if (loginctl) run(loginctl, ['enable-linger', process.env.USER || '']); // survive logout/boot
  }
  log.ok(`systemd --user service '${SERVICE_NAME}' enabled (+linger)`);
  return { kind: 'systemd-user' };
}

// ---------- macOS / launchd ----------
function installMac(entry, port = DEFAULT_PORT) {
  const label = 'com.xats.daemon';
  const plistPath = path.join(HOME, 'Library', 'LaunchAgents', `${label}.plist`);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin()}</string>
    <string>${entry}</string>
    <string>daemon</string>
    <string>--port</string>
    <string>${effectivePort(port)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
`;
  writeFile(plistPath, plist);
  if (!isDry()) {
    const launchctl = which('launchctl') || 'launchctl';
    run(launchctl, ['unload', plistPath]); // ignore failure if not loaded
    run(launchctl, ['load', '-w', plistPath]);
  }
  log.ok(`launchd LaunchAgent '${label}' loaded`);
  return { kind: 'launchd', plist: plistPath };
}

// ---------- Windows ----------
// Non-admin autostart. Prefer a Scheduled Task (ONLOGON); if task creation is
// denied (locked-down box / no admin), fall back to a hidden Startup-folder VBS
// launcher — per-user, needs no elevation, runs windowless at logon.
function startupVbs(entry, port = DEFAULT_PORT) {
  const startupDir = path.join(HOME, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const cmd = `"${nodeBin()}" "${entry}" daemon --port ${effectivePort(port)}`;
  const vbsCmd = cmd.replace(/"/g, '""'); // VBS escapes a quote by doubling it
  const vbs = `Set s = CreateObject("WScript.Shell")\r\ns.Run "${vbsCmd}", 0, False\r\n`;
  const dest = path.join(startupDir, 'xats-daemon.vbs');
  writeFile(dest, vbs);
  return dest;
}

function installWindows(entry, port = DEFAULT_PORT) {
  const p = effectivePort(port);
  const tr = `\"${nodeBin()}\" \"${entry}\" daemon --port ${p}`;
  if (isDry()) {
    log.dry(`schtasks /Create /SC ONLOGON /TN ${SERVICE_NAME} /TR ${tr} /F /RL LIMITED`);
    log.dry(`or, if denied: Startup-folder VBS launcher (non-admin, hidden)`);
    log.dry(`start daemon now on :${p}`);
    return { kind: 'schtasks-dry' };
  }
  let kind;
  const schtasks = which('schtasks') || 'schtasks';
  const r = run(schtasks, ['/Create', '/SC', 'ONLOGON', '/TN', SERVICE_NAME, '/TR', tr, '/F', '/RL', 'LIMITED']);
  if (r.ok) { log.ok(`Scheduled Task '${SERVICE_NAME}' registered (runs at logon)`); kind = 'schtasks'; }
  else {
    log.warn(`schtasks denied (${(r.stderr || r.code || '').toString().split('\n')[0]}) — using Startup-folder launcher`);
    try { const p2 = startupVbs(entry, p); log.ok(`Startup launcher installed (hidden at logon): ${p2}`); kind = 'startup-vbs'; }
    catch (e) { log.warn(`Startup launcher failed: ${e.message} — daemon runs this session only`); kind = 'none'; }
  }
  startNow(entry, p); // don't wait for next logon
  log.info('note: crash-restart is best-effort on Windows; autostart relaunches at each logon');
  // Windows Firewall: try to add an allow rule for this port (needs admin, else falls back to prompt)
  const ruleName = `xats-daemon-${p}`;
  const netsh = which('netsh') || which('netsh.exe') || 'netsh';
  if (isDry()) log.dry(`netsh advfirewall firewall add rule name=${ruleName} dir=in action=allow protocol=TCP localport=${p}`);
  else {
    const check = run(netsh, ['advfirewall','firewall','show','rule',`name=${ruleName}`]);
    if (!check.ok || !check.stdout.includes(ruleName)) {
      const add = run(netsh, ['advfirewall','firewall','add','rule',`name=${ruleName}`, 'dir=in', 'action=allow', 'protocol=TCP', `localport=${p}`]);
      if (add.ok) log.ok(`Windows Firewall rule added for :${p} (${ruleName})`);
      else log.warn(`could not add firewall rule (first bind will prompt): ${add.stderr || add.code}`);
    } else log.info(`Firewall rule ${ruleName} already present`);
  }
  return { kind };
}

// Restart a running daemon so an updated build takes effect. Used only on
// upgrade when the overlaid cli.js actually changed.
export function restartDaemon(paths, entry, port = DEFAULT_PORT) {
  log.step('Daemon: restart to apply updated build');
  if (isDry()) { log.dry('restart daemon (build changed)'); return; }
  if (IS_LINUX && which('systemctl')) {
    const sc = which('systemctl');
    const args = IS_ROOT ? ['restart', SERVICE_NAME] : ['--user', 'restart', SERVICE_NAME];
    const r = run(sc, args);
    if (r.ok) { log.ok('daemon restarted (systemd)'); return; }
  }
  if (IS_MAC && which('launchctl')) {
    const plist = path.join(HOME, 'Library', 'LaunchAgents', 'com.xats.daemon.plist');
    run(which('launchctl'), ['unload', plist]);
    run(which('launchctl'), ['load', '-w', plist]);
    log.ok('daemon restarted (launchd)');
    return;
  }
  // Generic (Windows / non-systemd): stop the recorded pid, then start fresh.
  const info = readJson(path.join(paths.daemonState, 'daemon.pid'), null);
  if (info && info.pid) {
    try { process.kill(info.pid, 'SIGTERM'); log.info(`stopped old daemon pid ${info.pid}`); } catch { /* already gone */ }
  }
  startNow(entry, port);
}

export function installService(lay, opts = {}) {
  const port = effectivePort(opts.port);
  log.step('Service: register daemon to run at login/boot');
  let res;
  if (IS_LINUX) res = installLinux(lay.entry, port);
  else if (IS_MAC) res = installMac(lay.entry, port);
  else if (IS_WIN) res = installWindows(lay.entry, port);
  else { log.warn(`unknown platform ${process.platform}; detached start only`); startNow(lay.entry, port); res = { kind: 'detached' }; }
  log.info(`health check after start: curl ${baseFor(port)}/health`);
  return res;
}

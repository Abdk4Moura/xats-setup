// peer-service.mjs — explicit opt-in user service lifecycle for the network peer listener.
import fs from 'node:fs';
import path from 'node:path';
import { log, isDry, ensureDir } from './log.mjs';
import { HOME, IS_WIN, IS_MAC, IS_LINUX, nodeBin, which, run } from './platform.mjs';

export const PEER_SERVICE_NAME = 'xats-peer';
const MAC_LABEL = 'com.xats.peer';
const FIREWALL_RULE = 'xats-peer-stage1';

function peerEntry(paths) { return path.join(paths.xatsRoot, 'peer', 'peer.mjs'); }
function markerPath(paths) { return path.join(paths.xatsRoot, 'peer', 'service.json'); }
function linuxUnitPath() { return path.join(HOME, '.config', 'systemd', 'user', `${PEER_SERVICE_NAME}.service`); }
function macPlistPath() { return path.join(HOME, 'Library', 'LaunchAgents', `${MAC_LABEL}.plist`); }
export function renderPeerWindowsTaskCommand(entry, node = nodeBin()) { return `"${node}" "${entry}" run`; }

function systemdArg(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
}
function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

export function renderPeerSystemdUnit(entry, node = nodeBin()) {
  return [
    '[Unit]',
    'Description=xats secure peer network service (Stage 1)',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${systemdArg(node)} ${systemdArg(entry)} run`,
    'Restart=on-failure',
    'RestartSec=3',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

export function renderPeerLaunchAgent(entry, node = nodeBin()) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(MAC_LABEL)}</string>
  <key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(entry)}</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
</dict></plist>
`;
}

function saveMarker(paths, kind) {
  if (isDry()) return;
  fs.mkdirSync(path.dirname(markerPath(paths)), { recursive: true, mode: 0o700 });
  const temp = `${markerPath(paths)}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ version: 1, kind, platform: process.platform, enabledAt: Date.now() }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, markerPath(paths));
  try { fs.chmodSync(markerPath(paths), 0o600); } catch { /* best effort */ }
}

function managerRun(command, args, action) {
  if (isDry()) {
    log.dry(`${command} ${args.join(' ')}`);
    return { ok: true, code: 0, stdout: '', stderr: '' };
  }
  const result = run(command, args, { timeout: 15_000 });
  if (!result.ok) log.warn(`peer service ${action} failed: ${result.stderr || result.stdout || result.code}`);
  return result;
}

function enabledMarker(paths) {
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath(paths), 'utf8'));
    return marker?.version === 1 ? marker : null;
  } catch { return null; }
}

function windowsTaskExists() {
  const schtasks = which('schtasks') || which('schtasks.exe') || 'schtasks';
  return run(schtasks, ['/Query', '/TN', PEER_SERVICE_NAME], { timeout: 5000 }).ok;
}

function windowsFirewall(add, paths) {
  const netsh = which('netsh') || which('netsh.exe');
  if (!netsh) return;
  let localPort = '9110-9120';
  if (add) {
    try {
      const saved = Number(fs.readFileSync(path.join(paths.xatsRoot, 'peer', 'peer-port'), 'utf8').trim());
      if (Number.isInteger(saved) && saved > 0 && saved <= 65535) localPort = String(saved);
    } catch { /* first launch uses the default range */ }
  }
  const args = add
    ? ['advfirewall', 'firewall', 'add', 'rule', `name=${FIREWALL_RULE}`, 'dir=in', 'action=allow', 'protocol=TCP', `localport=${localPort}`, 'profile=any']
    : ['advfirewall', 'firewall', 'delete', 'rule', `name=${FIREWALL_RULE}`];
  const result = managerRun(netsh, args, add ? 'firewall rule installation' : 'firewall rule removal');
  if (!result.ok && add) log.warn(`could not add the Windows Firewall rule for xats peer; allow TCP ${localPort} if inbound connections are blocked`);
  else if (!result.ok) log.warn('could not remove the Windows Firewall rule for xats peer; remove xats-peer-stage1 manually if needed');
}

export function isPeerServiceEnabled(paths) {
  return Boolean(enabledMarker(paths));
}

export function enablePeerService(paths) {
  const entry = peerEntry(paths);
  if (!fs.existsSync(entry)) throw new Error('peer runtime not installed; run `xats-setup --only=peer` first');
  log.step('Peer service: enable network listener at login (explicit opt-in)');
  let kind;
  if (IS_LINUX) {
    const systemctl = which('systemctl');
    if (!systemctl) throw new Error('systemctl unavailable; use `xats-setup peer run` in a managed session');
    const wasManaged = Boolean(enabledMarker(paths));
    const unitPath = linuxUnitPath();
    ensureDir(path.dirname(unitPath));
    if (!isDry()) fs.writeFileSync(unitPath, renderPeerSystemdUnit(entry), 'utf8');
    if (!isDry()) {
      const reload = managerRun(systemctl, ['--user', 'daemon-reload'], 'reload');
      const enabled = reload.ok && managerRun(systemctl, ['--user', 'enable', '--now', `${PEER_SERVICE_NAME}.service`], 'enable/start');
      if (!enabled?.ok) throw new Error('could_not_enable_peer_systemd_service');
      if (wasManaged) {
        const restarted = managerRun(systemctl, ['--user', 'restart', `${PEER_SERVICE_NAME}.service`], 'restart');
        if (!restarted.ok) throw new Error('could_not_restart_peer_systemd_service');
      }
    } else log.dry(`would write ${unitPath}`);
    kind = 'systemd-user';
  } else if (IS_MAC) {
    const plist = macPlistPath();
    ensureDir(path.dirname(plist));
    if (!isDry()) fs.writeFileSync(plist, renderPeerLaunchAgent(entry), 'utf8');
    if (!isDry()) {
      const launchctl = which('launchctl') || 'launchctl';
      managerRun(launchctl, ['unload', plist], 'unload');
      const load = managerRun(launchctl, ['load', '-w', plist], 'load/start');
      if (!load.ok) throw new Error('could_not_enable_peer_launch_agent');
    } else log.dry(`would write ${plist}`);
    kind = 'launchd';
  } else if (IS_WIN) {
    const schtasks = which('schtasks') || which('schtasks.exe') || 'schtasks';
    const result = managerRun(schtasks, ['/Create', '/SC', 'ONLOGON', '/TN', PEER_SERVICE_NAME, '/TR', renderPeerWindowsTaskCommand(entry), '/F', '/RL', 'LIMITED'], 'scheduled task creation');
    if (!result.ok) throw new Error('could_not_create_peer_scheduled_task');
    managerRun(schtasks, ['/End', '/TN', PEER_SERVICE_NAME], 'stop prior task instance');
    const start = managerRun(schtasks, ['/Run', '/TN', PEER_SERVICE_NAME], 'scheduled task start');
    if (!start.ok) throw new Error('could_not_start_peer_scheduled_task');
    windowsFirewall(true, paths);
    kind = 'schtasks';
  } else {
    throw new Error(`unsupported platform for peer service: ${process.platform}`);
  }
  saveMarker(paths, kind);
  log.ok(`xats peer service enabled (${kind}); no daemon API was exposed`);
  return { kind, entry };
}

export function startPeerService(paths) {
  if (!enabledMarker(paths)) throw new Error('peer autostart is not enabled; use `xats-setup peer enable`');
  if (IS_LINUX) return managerRun(which('systemctl') || 'systemctl', ['--user', 'start', `${PEER_SERVICE_NAME}.service`], 'start');
  if (IS_MAC) {
    const launchctl = which('launchctl') || 'launchctl';
    managerRun(launchctl, ['unload', macPlistPath()], 'unload');
    return managerRun(launchctl, ['load', '-w', macPlistPath()], 'start');
  }
  if (IS_WIN) {
    const schtasks = which('schtasks') || 'schtasks';
    managerRun(schtasks, ['/End', '/TN', PEER_SERVICE_NAME], 'stop prior task instance');
    return managerRun(schtasks, ['/Run', '/TN', PEER_SERVICE_NAME], 'start');
  }
  return { ok: false, code: 1 };
}

export function stopPeerService(paths) {
  if (!enabledMarker(paths)) return { ok: true, unmanaged: true };
  if (IS_LINUX) return managerRun(which('systemctl') || 'systemctl', ['--user', 'stop', `${PEER_SERVICE_NAME}.service`], 'stop');
  if (IS_MAC) return managerRun(which('launchctl') || 'launchctl', ['unload', macPlistPath()], 'stop');
  if (IS_WIN) return managerRun(which('schtasks') || 'schtasks', ['/End', '/TN', PEER_SERVICE_NAME], 'stop');
  return { ok: false, code: 1 };
}

export function restartPeerService(paths) {
  if (!enabledMarker(paths)) return false;
  if (isDry()) { log.dry('restart explicitly enabled xats peer service after update'); return true; }
  if (IS_LINUX) return managerRun(which('systemctl') || 'systemctl', ['--user', 'restart', `${PEER_SERVICE_NAME}.service`], 'restart').ok;
  if (IS_MAC) {
    const launchctl = which('launchctl') || 'launchctl';
    managerRun(launchctl, ['unload', macPlistPath()], 'unload');
    return managerRun(launchctl, ['load', '-w', macPlistPath()], 'restart').ok;
  }
  if (IS_WIN) {
    const schtasks = which('schtasks') || 'schtasks';
    managerRun(schtasks, ['/End', '/TN', PEER_SERVICE_NAME], 'stop');
    return managerRun(schtasks, ['/Run', '/TN', PEER_SERVICE_NAME], 'restart').ok;
  }
  return false;
}

export function disablePeerService(paths, { force = false } = {}) {
  const marker = enabledMarker(paths);
  const hasLinuxUnit = IS_LINUX && fs.existsSync(linuxUnitPath());
  const hasMacPlist = IS_MAC && fs.existsSync(macPlistPath());
  const hasWindowsTask = IS_WIN && (Boolean(marker) || (force && !isDry() && windowsTaskExists()));
  const servicePresent = Boolean(marker || hasLinuxUnit || hasMacPlist || hasWindowsTask);
  if (!servicePresent && !force) return false;
  log.step('Peer service: stop and disable network listener');
  if (IS_LINUX && (marker || hasLinuxUnit)) {
    const systemctl = which('systemctl') || 'systemctl';
    managerRun(systemctl, ['--user', 'disable', '--now', `${PEER_SERVICE_NAME}.service`], 'disable/stop');
    const unit = linuxUnitPath();
    if (!isDry()) fs.rmSync(unit, { force: true });
    else log.dry(`remove ${unit}`);
    managerRun(systemctl, ['--user', 'daemon-reload'], 'reload');
  } else if (IS_MAC && (marker || hasMacPlist)) {
    const launchctl = which('launchctl') || 'launchctl';
    managerRun(launchctl, ['unload', macPlistPath()], 'unload');
    if (!isDry()) fs.rmSync(macPlistPath(), { force: true });
    else log.dry(`remove ${macPlistPath()}`);
  } else if (IS_WIN && (marker || force)) {
    const schtasks = which('schtasks') || 'schtasks';
    managerRun(schtasks, ['/End', '/TN', PEER_SERVICE_NAME], 'stop');
    managerRun(schtasks, ['/Delete', '/TN', PEER_SERVICE_NAME, '/F'], 'delete');
    windowsFirewall(false, paths);
  }
  if (!isDry()) fs.rmSync(markerPath(paths), { force: true });
  else log.dry(`remove ${markerPath(paths)}`);
  return servicePresent;
}

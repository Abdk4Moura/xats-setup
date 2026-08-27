// pi.mjs — wire Pi onto the bus (extension + skill).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import fs from 'node:fs';
import { log, copyFile, isDry, writeFile } from './log.mjs';
import { which, run, writeLabelFile, readLabelFile, IS_WIN, wslInfo } from './platform.mjs';
import * as readline from 'node:readline';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(__dir, '..', 'assets');

function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.env.CI);
}
async function promptLabel(defaultLabel) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = await new Promise((res) => rl.question(`  Pi label [${defaultLabel}]: `, res));
    return ans.trim() || defaultLabel;
  } finally { rl.close(); }
}

export async function ensurePiLabel(paths, explicitLabel) {
  let label = explicitLabel?.trim() || process.env.XATS_LABEL?.trim() || readLabelFile(paths);
  if (!label && isInteractive()) {
    const def = os.userInfo().username || os.hostname().split('.')[0] || 'pi';
    const safe = def.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 24) || 'pi';
    log.info(`no XATS_LABEL — prompting for a stable Pi label (used as pi-<host>-<label>).`);
    label = await promptLabel(safe);
  }
  if (!label) label = os.userInfo().username?.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 24) || os.hostname().split('.')[0].toLowerCase().slice(0, 24) || 'pi';
  // Persist for extension fallback (~/.xats/label) and for future shells.
  if (!isDry()) writeLabelFile(paths, label);
  const persisted = !explicitLabel && !process.env.XATS_LABEL;
  if (persisted) {
    process.env.XATS_LABEL = label;
    if (which('setx') || which('setx.exe')) {
      if (isDry()) log.dry(`setx XATS_LABEL "${label}"`);
      else {
        const r = run(which('setx') || which('setx.exe') || 'setx', ['XATS_LABEL', label]);
        if (r.ok) log.ok(`persisted XATS_LABEL=${label} (setx, new shells)`);
        else log.warn(`could not setx XATS_LABEL: ${r.stderr || r.code}`);
        // Broadcast WM_SETTINGCHANGE so new env is visible without logoff (setx alone may not broadcast to all)
        const ps = which('powershell.exe') || which('powershell');
        if (ps) {
          const esc = label.replace(/'/g, "''");
          run(ps, ['-NoProfile','-Command', `[Environment]::SetEnvironmentVariable('XATS_LABEL','${esc}','User')`], { timeout: 3000 });
        }
      }
    }
    log.info(`Pi will be pi-${os.hostname().split('.')[0]}-${label} (also saved to ~/.xats/label)`);
  } else {
    log.info(`Pi label: ${label} (from ${explicitLabel ? '--label' : process.env.XATS_LABEL ? 'env' : '~/.xats/label'})`);
  }
  return label;
}

export function installPi(paths) {
  log.step('Pi: extension + skill');
  const changed = copyFile(path.join(ASSETS, 'pi', 'xats.ts'), path.join(paths.piExtensions, 'xats.ts'));
  copyFile(path.join(ASSETS, 'skills', 'xats', 'SKILL.md'), path.join(paths.piSkills, 'xats', 'SKILL.md'));
  log.ok(`pi: extension + skill wired at ${paths.piExtensions}`);
  if (changed) log.info('Pi: restart Pi or run /reload in an open Pi session to load the updated extension.');
  // WSL's pi when running on Windows
  if (IS_WIN) {
    try {
      const w = wslInfo();
      const wslBin = which('wsl.exe') || which('wsl');
      if (wslBin && w?.pi) {
        if (isDry()) log.dry('wsl -- cp pi xats.ts/.md to ~/.pi/agent');
        else run(wslBin, ['-e','sh','-lc', 'mkdir -p ~/.pi/agent/extensions ~/.pi/agent/skills && cp /mnt/c/Users/agboola/.pi/agent/extensions/xats.ts ~/.pi/agent/extensions/xats.ts 2>/dev/null; cp /mnt/c/Users/agboola/.pi/agent/skills/xats/SKILL.md ~/.pi/agent/skills/xats/SKILL.md 2>/dev/null; echo pi-wsl-done'], { timeout: 4000 });
      }
    } catch {}
  }
}

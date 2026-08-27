// omp.mjs — wire OMP (fork of Pi, config at ~/.omp/agent) onto the bus.
// Reuses the same xats.ts (import type is erased, runtime is pi object) but is an independent agent.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { log, copyFile, isDry } from './log.mjs';
import { which, run, IS_WIN, wslInfo } from './platform.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(__dir, '..', 'assets');

export function installOmp(paths) {
  log.step('OMP: extension + skill');
  // local omp (Linux/macOS or Windows if ~/.omp exists)
  const localExists = fs.existsSync(paths.ompDir) || fs.existsSync(paths.ompExtensions) || !!which('omp') || !!which('omp.exe');
  let did = false;
  if (localExists || fs.existsSync(paths.ompDir)) {
    const changed = copyFile(path.join(ASSETS, 'pi', 'xats.ts'), path.join(paths.ompExtensions, 'xats.ts'));
    copyFile(path.join(ASSETS, 'skills', 'xats', 'SKILL.md'), path.join(paths.ompSkills, 'xats', 'SKILL.md'));
    log.ok(`omp: extension + skill wired at ${paths.ompExtensions}`);
    if (changed) log.info('OMP: restart omp or run /reload to load the updated extension.');
    did = true;
  } else {
    log.info('omp not installed locally — skipping (safe to re-run later)');
  }
  // WSL's omp when running on Windows
  if (IS_WIN) {
    try {
      const w = wslInfo();
      const wslBin = which('wsl.exe') || which('wsl');
      if (wslBin && w?.omp) {
        if (isDry()) log.dry('wsl -- cp pi xats.ts/.md to ~/.omp/agent (omp)');
        else {
          run(wslBin, ['-e','sh','-lc', 'mkdir -p ~/.omp/agent/extensions ~/.omp/agent/skills && cp /mnt/c/Users/agboola/.pi/agent/extensions/xats.ts ~/.omp/agent/extensions/xats.ts 2>/dev/null; cp /mnt/c/Users/agboola/.pi/agent/skills/xats/SKILL.md ~/.omp/agent/skills/xats/SKILL.md 2>/dev/null; echo omp-wsl-done'], { timeout: 4000 });
          log.ok('omp (WSL): extension + skill wired via wsl.exe');
          did = true;
        }
      }
    } catch {}
  }
  return did;
}

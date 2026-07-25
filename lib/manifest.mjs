// manifest.mjs — records what xats-setup installed on this box, so a later run
// can detect an older install and update it in place (idempotent + migratable).
import path from 'node:path';
import { readJson, writeJson, log } from './log.mjs';

const file = (paths) => path.join(paths.xatsRoot, 'manifest.json');

export function readManifest(paths) {
  return readJson(file(paths), null);
}

export function writeManifest(paths, data) {
  writeJson(file(paths), data);
}

// Compare dotted numeric versions. -1 if a<b, 0 if equal, 1 if a>b.
export function cmpVersion(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// Report the install/upgrade situation. Returns { prior, mode } where mode is
// 'fresh' | 'reinstall' | 'upgrade' | 'downgrade'.
export function describeRun(paths, version) {
  const prior = readManifest(paths);
  if (!prior) { log.info('fresh install (no prior manifest)'); return { prior: null, mode: 'fresh' }; }
  const c = cmpVersion(prior.version, version);
  const mode = c === 0 ? 'reinstall' : c < 0 ? 'upgrade' : 'downgrade';
  if (mode === 'upgrade') log.info(`upgrading existing install ${prior.version} -> ${version}`);
  else if (mode === 'downgrade') log.warn(`installed ${prior.version} is newer than ${version} (downgrade)`);
  else log.info(`re-running same version ${version} (idempotent refresh)`);
  return { prior, mode };
}

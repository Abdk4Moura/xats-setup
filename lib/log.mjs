// log.mjs — tiny logger + dry-run-aware fs helpers shared by every step.
import fs from 'node:fs';
import path from 'node:path';

let DRY = false;
export function setDry(v) { DRY = !!v; }
export function isDry() { return DRY; }

const c = process.stdout.isTTY
  ? { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', b: '\x1b[34m', d: '\x1b[2m', x: '\x1b[0m' }
  : { g: '', y: '', r: '', b: '', d: '', x: '' };

export const log = {
  step: (m) => console.log(`\n${c.b}==>${c.x} ${m}`),
  ok: (m) => console.log(`  ${c.g}✓${c.x} ${m}`),
  info: (m) => console.log(`  ${c.d}·${c.x} ${m}`),
  warn: (m) => console.log(`  ${c.y}!${c.x} ${m}`),
  err: (m) => console.log(`  ${c.r}✗${c.x} ${m}`),
  dry: (m) => console.log(`  ${c.d}DRY${c.x} ${m}`),
};

// Idempotent, dry-run-aware filesystem ops. All no-op (but log) under --dry-run.
export function ensureDir(dir) {
  if (fs.existsSync(dir)) return;
  if (DRY) return log.dry(`mkdir -p ${dir}`);
  fs.mkdirSync(dir, { recursive: true });
}

export function writeFile(file, content, { mode } = {}) {
  const exists = fs.existsSync(file);
  if (exists && fs.readFileSync(file, 'utf8') === content) {
    log.info(`unchanged ${file}`);
    return false;
  }
  if (DRY) { log.dry(`write ${file} (${content.length}b)`); return true; }
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, content, mode ? { mode } : undefined);
  if (mode && process.platform !== 'win32') fs.chmodSync(file, mode);
  log.ok(`${exists ? 'updated' : 'wrote'} ${file}`);
  return true;
}

export function copyFile(src, dest) {
  if (fs.existsSync(dest) && fs.readFileSync(dest).equals(fs.readFileSync(src))) {
    log.info(`unchanged ${dest}`);
    return false;
  }
  if (DRY) { log.dry(`copy ${src} -> ${dest}`); return true; }
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
  log.ok(`copied -> ${dest}`);
  return true;
}

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

export function writeJson(file, obj) {
  return writeFile(file, JSON.stringify(obj, null, 2) + '\n');
}

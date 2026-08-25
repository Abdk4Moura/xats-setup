// log.mjs — tiny logger + dry-run-aware fs helpers + ephemeral colored status panel + file log.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let DRY = false;
export function setDry(v) { DRY = !!v; }
export function isDry() { return DRY; }

function isTTY() { return Boolean(process.stdout.isTTY && !process.env.CI); }
const c = isTTY()
  ? { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', b: '\x1b[34m', d: '\x1b[2m', x: '\x1b[0m', dim: '\x1b[2m' }
  : { g: '', y: '', r: '', b: '', d: '', x: '', dim: '' };

// --- file log + ephemeral panel ---
let logFile = null;
let logStream = null;
let ephemeral = false;
let spinnerTimer = null;
let spinnerIdx = 0;
const spinnerFrames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
let renderedLines = 0;
let rendered = false;

// panel state
const ALL_ORDER = ['daemon','service','claude','pi','opencode','mimocode','bridge','verify'];
let panelSteps = [...ALL_ORDER];
let panelStatus = new Map(); // name -> pending|running|done|skip|error
let panelDetail = new Map(); // name -> string
let currentPanel = null;

function ts() { return new Date().toISOString(); }

export function initLogFile(customPath) {
  const dir = os.tmpdir();
  const p = customPath || path.join(dir, `xats-setup-${Date.now()}-${process.pid}.log`);
  try {
    logFile = p;
    logStream = fs.createWriteStream(p, { flags: 'a' });
    logStream.write(`# xats-setup log ${ts()}\n`);
  } catch { logFile = null; }
  return logFile;
}
export function getLogFile() { return logFile; }

export function setEphemeralSteps(components) {
  // components is Set of selected components
  const sel = components instanceof Set ? components : new Set(components || []);
  panelSteps = [...ALL_ORDER];
  panelStatus = new Map();
  panelDetail = new Map();
  for (const name of panelSteps) {
    if (name === 'verify') { panelStatus.set(name, 'pending'); continue; }
    if (sel.has(name)) panelStatus.set(name, 'pending');
    else if (['daemon','service','bridge'].includes(name)) panelStatus.set(name, sel.has(name) ? 'pending' : 'skip');
    else panelStatus.set(name, sel.has(name) ? 'pending' : 'skip');
  }
  currentPanel = null;
}

export function setStepStatus(name, status, detail) {
  if (panelStatus.has(name)) {
    panelStatus.set(name, status);
    if (detail) panelDetail.set(name, detail);
    if (status === 'running') currentPanel = name;
  }
  if (ephemeral) renderEphemeral();
}

export function enableEphemeral() {
  if (ephemeral || !isTTY() || DRY) return;
  try { process.stdout.write('\x1b[?25l'); } catch {}
  ephemeral = true;
  rendered = false;
  renderedLines = 1;
  spinnerTimer = setInterval(() => {
    spinnerIdx = (spinnerIdx + 1) % spinnerFrames.length;
    renderEphemeral();
  }, 80);
  renderEphemeral();
}
export function disableEphemeral() {
  if (!ephemeral) return;
  clearInterval(spinnerTimer);
  spinnerTimer = null;
  ephemeral = false;
  try {
    process.stdout.write('\r\x1b[2K');
    process.stdout.write('\x1b[?25h');
  } catch {}
  rendered = false;
  renderedLines = 0;
}
function renderEphemeral() {
  if (!ephemeral) return;
  const frame = spinnerFrames[spinnerIdx];
  const name = currentPanel || 'preparing';
  const st = panelStatus.get(name) || 'running';
  const detail = panelDetail.get(name) || currentPanel ? (panelDetail.get(currentPanel) || 'running…') : 'preparing…';
  let col = c.b;
  if (st === 'running') col = c.y;
  else if (st === 'done') col = c.g;
  else if (st === 'error') col = c.r;
  const icon = st === 'done' ? '✓' : st === 'error' ? '✗' : frame;
  const logHint = logFile ? ` ${c.d}· ${path.basename(logFile)}${c.x}` : '';
  const line = `${col}${icon}${c.x} ${name} ${c.d}— ${detail}${c.x}${logHint}`;
  process.stdout.write('\r\x1b[2K' + line);
  rendered = true;
  renderedLines = 1;
}
function writeFileLog(level, msg) {
  if (logStream) {
    try { logStream.write(`[${ts()}] [${level}] ${msg}\n`); } catch {}
  }
}
function ephemeralLog(level, msg) {
  writeFileLog(level, msg);
  if (ephemeral && currentPanel) {
    // update detail for current panel
    const prev = panelDetail.get(currentPanel) || '';
    // keep last info, truncate
    const short = msg.length > 56 ? msg.slice(0, 53) + '…' : msg;
    if (level === 'ok' || level === 'info' || level === 'warn' || level === 'err') {
      panelDetail.set(currentPanel, short);
      renderEphemeral();
    }
  }
  if (!ephemeral) {
    const map = { ok: `  ${c.g}✓${c.x} `, info: `  ${c.d}·${c.x} `, warn: `  ${c.y}!${c.x} `, err: `  ${c.r}✗${c.x} `, dry: `  ${c.d}DRY${c.x} ` };
    const prefix = map[level] || '';
    console.log(prefix + msg);
  }
}
function ephemeralSetStep(msg) {
  writeFileLog('step', msg);
  // try to map step string to panel name
  const lower = msg.toLowerCase();
  let matched = null;
  for (const name of panelSteps) {
    if (lower.includes(name)) { matched = name; break; }
  }
  if (matched) {
    // previous running -> done
    if (currentPanel && panelStatus.get(currentPanel) === 'running' && currentPanel !== matched) {
      panelStatus.set(currentPanel, 'done');
      if (!panelDetail.get(currentPanel)) panelDetail.set(currentPanel, 'done');
    }
    panelStatus.set(matched, 'running');
    currentPanel = matched;
    panelDetail.set(matched, 'running…');
  }
  if (ephemeral) renderEphemeral();
  else console.log(`\n${c.b}==>${c.x} ${msg}`);
}

export const log = {
  step: (m) => ephemeralSetStep(m),
  ok: (m) => ephemeralLog('ok', m),
  info: (m) => ephemeralLog('info', m),
  warn: (m) => ephemeralLog('warn', m),
  err: (m) => ephemeralLog('err', m),
  dry: (m) => ephemeralLog('dry', m),
};

// ensure cursor restored on exit
process.on('exit', () => { if (ephemeral) try { process.stdout.write('\x1b[?25h'); } catch {} });
process.on('SIGINT', () => { disableEphemeral(); process.exit(1); });

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

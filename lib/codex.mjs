// Codex hook and MCP installation. Existing named MCP entries are never replaced.
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { log, isDry, copyFile, readConfigJson, writeConfigJson, writeConfigFile, ensureDir, configError } from './log.mjs';
import { nodeBin, which, run, IS_WIN } from './platform.mjs';
import { BASE_URL } from './constants.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const HOOK_SRC = path.join(__dir, '..', 'assets', 'codex', 'xats-hook.mjs');
const SKILL_SRC = path.join(__dir, '..', 'assets', 'skills', 'xats', 'SKILL.md');
const MARKER = 'codex-hook.mjs';

export function codexPaths(paths) {
  const dir = path.join(paths.home ?? process.env.HOME ?? '', '.codex');
  return { dir, hooksFile: path.join(dir, 'hooks.json'), configFile: path.join(dir, 'config.toml'),
    skillsDir: path.join(dir, 'skills', 'xats'), hookDest: path.join(paths.xatsRoot, MARKER) };
}

function ensureHook(hooks, event, command, matcher) {
  const groups = (hooks[event] = hooks[event] || []);
  for (const group of groups) {
    for (const handler of group.hooks || []) {
      if (typeof handler?.command === 'string' && handler.command.includes(MARKER)) {
        if (handler.command !== command || handler.commandWindows !== command) {
          handler.command = command;
          handler.commandWindows = command;
          return 'updated';
        }
        return 'present';
      }
    }
  }
  const handler = { type: 'command', command, commandWindows: command, timeout: 10 };
  groups.push(matcher ? { matcher, hooks: [handler] } : { hooks: [handler] });
  return 'added';
}

function runCodex(codex, args, opts = {}) {
  return run(codex, args, { ...opts, shell: IS_WIN || opts.shell === true });
}

function readBytes(file) {
  try { return fs.readFileSync(file); }
  catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw configError(file, `cannot read file (${error.code || 'I/O error'})`);
  }
}

export function readCodexHooks(paths) {
  const { hooksFile } = codexPaths(paths);
  const file = readConfigJson(hooksFile, null);
  if (file?.hooks !== undefined) {
    if (!file.hooks || typeof file.hooks !== 'object' || Array.isArray(file.hooks)) throw configError(hooksFile, 'expected hooks object');
    for (const groups of Object.values(file.hooks)) {
      if (!Array.isArray(groups) || groups.some(g => !g || !Array.isArray(g.hooks))) {
        throw configError(hooksFile, 'expected hook groups with hooks arrays');
      }
    }
  }
  return file;
}

function inspectMcpServer(baseUrl, configFile) {
  if (isDry()) {
    log.dry('inspect Codex MCP entry and add only if missing; do not replace existing entries');
    return { status: 'dry-run' };
  }
  const codex = which('codex');
  const url = `${baseUrl}/mcp`;
  if (!codex) {
    log.warn(`codex not on PATH; add the MCP server later with: codex mcp add cross-agent-teams --url ${url}`);
    return { status: 'skipped' };
  }
  const listed = runCodex(codex, ['mcp', 'list', '--json'], { timeout: 15000 });
  let entries;
  if (listed.ok) {
    try { entries = JSON.parse(listed.stdout); } catch { /* old CLI: use current table */ }
  }
  let existing;
  if (Array.isArray(entries) && entries.every(e => typeof e?.name === 'string')) {
    const entry = entries.find(e => e.name === 'cross-agent-teams');
    if (entry) existing = { url: entry.transport?.url ?? entry.url };
  } else {
    const table = runCodex(codex, ['mcp', 'list'], { timeout: 15000 });
    if (!table.ok) throw new Error('codex: cannot inspect MCP entries; run `codex mcp list` and retry. No MCP entry was changed.');
    const rows = String(table.stdout || '').split('\n').map(line => line.trim().split(/\s+/));
    const row = rows.find(cols => cols[0] === 'cross-agent-teams');
    if (row) existing = { url: row[1] };
  }
  if (existing) {
    if (existing.url === url) {
      log.info('codex: cross-agent-teams MCP already configured');
      return { status: 'present' };
    }
    throw new Error(`codex: manual-update-required: existing cross-agent-teams MCP entry was left untouched. Update only its URL to ${url} in ${configFile}, preserving authentication and other options, then retry. Inspect with: codex mcp get cross-agent-teams --json`);
  }
  return { codex, url };
}

export function preflightCodexConfig(paths, { baseUrl = BASE_URL } = {}) {
  const lay = codexPaths(paths);
  if (!fs.existsSync(lay.dir)) return;
  readCodexHooks(paths);
  readBytes(lay.configFile);
  inspectMcpServer(baseUrl, lay.configFile);
}

function ensureMcpServer(baseUrl, configFile) {
  const { status, codex, url } = inspectMcpServer(baseUrl, configFile);
  if (status) return status;
  const before = readBytes(configFile);
  const mode = before === undefined ? undefined : fs.statSync(configFile).mode & 0o777;
  if (before !== undefined) {
    const backup = `${configFile}.xats-backup-${randomUUID()}`;
    fs.writeFileSync(backup, before, { flag: 'wx', mode: 0o600 });
    log.info(`config backup: ${backup}`);
  }
  const added = runCodex(codex, ['mcp', 'add', 'cross-agent-teams', '--url', url], { timeout: 20000 });
  if (added.ok) {
    log.ok(`codex: MCP -> ${url}`);
    return 'added';
  }
  const after = readBytes(configFile);
  if (before === undefined) {
    if (after !== undefined) fs.rmSync(configFile);
  } else {
    if (!after?.equals(before)) writeConfigFile(configFile, before);
    if ((fs.statSync(configFile).mode & 0o777) !== mode) fs.chmodSync(configFile, mode);
  }
  throw new Error('codex: MCP add failed; previous config restored. Run `codex mcp list` and add cross-agent-teams manually.');
}

export function installCodex(paths, { baseUrl = BASE_URL } = {}) {
  log.step('Codex CLI: hook + hooks.json + MCP entry');
  const lay = codexPaths(paths);
  if (!fs.existsSync(lay.dir)) {
    log.warn('~/.codex not found; skipping (safe to re-run later)');
    return { skipped: true };
  }
  // Strict reads precede every mutation, including the native CLI.
  const file = readCodexHooks(paths) ?? {};
  readBytes(lay.configFile);
  const mcp = ensureMcpServer(baseUrl, lay.configFile);
  ensureDir(paths.xatsRoot);
  copyFile(HOOK_SRC, lay.hookDest);
  const command = mode => `"${nodeBin()}" "${lay.hookDest}" ${mode}`;
  file.hooks = file.hooks || {};
  const started = ensureHook(file.hooks, 'SessionStart', command('start'), 'startup|resume|clear|compact|fork');
  const prompted = ensureHook(file.hooks, 'UserPromptSubmit', command('prompt'));
  const ended = ensureHook(file.hooks, 'SessionEnd', command('end'));
  if ([started, prompted, ended].every(s => s === 'present')) log.info('codex: hooks already wired');
  else writeConfigJson(lay.hooksFile, file);
  copyFile(SKILL_SRC, path.join(lay.skillsDir, 'SKILL.md'));
  log.info('codex: trust the new hooks once in a session with /hooks');
  return { hookDest: lay.hookDest, hooksFile: lay.hooksFile, mcp };
}

export function resetCodex(paths) {
  const lay = codexPaths(paths);
  const file = readCodexHooks(paths);
  if (file?.hooks) {
    let changed = false;
    for (const [event, groups] of Object.entries(file.hooks)) {
      const kept = groups.map(group => ({ ...group, hooks: group.hooks.filter(handler => {
        const owned = [handler?.command, handler?.commandWindows].some(c => typeof c === 'string' && c.includes(MARKER));
        changed ||= owned;
        return !owned;
      }) })).filter(group => group.hooks.length);
      if (kept.length) file.hooks[event] = kept;
      else delete file.hooks[event];
    }
    if (changed) {
      if (!Object.keys(file.hooks).length) delete file.hooks;
      writeConfigJson(lay.hooksFile, file);
    }
  }
  log.info('codex: MCP config retained to preserve authentication/options; remove cross-agent-teams manually if no longer needed');
  return { hookDest: lay.hookDest, skillsDir: lay.skillsDir };
}

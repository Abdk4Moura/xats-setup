// codex.mjs — wire Codex CLI onto the bus, cross-platform.
//
// Codex has hooks, MCP servers, and plugins, but no plugin UI surface and no
// custom status-line item. So this component installs the smallest thing that
// is still honest:
//   1. the Node hook (xats-hook.mjs) at a stable path
//   2. SessionStart/UserPromptSubmit/SessionEnd entries in ~/.codex/hooks.json
//   3. the cross-agent-teams MCP server, so the agent has the xats tools
//   4. the xats skill
//
// Mail reaches the model as developer context on its next turn; nothing is typed
// into the composer and no turn is injected. See assets/codex/xats-hook.mjs.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { log, isDry, copyFile, readJson, writeJson, ensureDir } from './log.mjs';
import { nodeBin, which, run, IS_WIN } from './platform.mjs';
import { BASE_URL } from './constants.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const HOOK_SRC = path.join(__dir, '..', 'assets', 'codex', 'xats-hook.mjs');
const SKILL_SRC = path.join(__dir, '..', 'assets', 'skills', 'xats', 'SKILL.md');
// Must match the file we actually install, or a re-install appends a second
// hook group and reset cannot recognise ours.
const MARKER = 'codex-hook.mjs';

// `paths.home` rather than a module-level HOME keeps this testable: tests pass a
// temporary home instead of touching the real ~/.codex.
export function codexPaths(paths) {
  const dir = path.join(paths.home ?? path.join(process.env.HOME ?? '', ''), '.codex');
  return {
    dir,
    hooksFile: path.join(dir, 'hooks.json'),
    configFile: path.join(dir, 'config.toml'),
    skillsDir: path.join(dir, 'skills', 'xats'),
    hookDest: path.join(paths.xatsRoot, 'codex-hook.mjs'),
  };
}

function sameCommand(handler, command) {
  return handler?.command === command || handler?.commandWindows === command;
}

// Ensure exactly one handler for `event` that invokes our hook with `mode`.
function ensureHook(hooks, event, command, matcher) {
  const groups = (hooks[event] = hooks[event] || []);
  for (const group of groups) {
    for (const handler of group.hooks || []) {
      if (typeof handler?.command === 'string' && handler.command.includes(MARKER)) {
        if (!sameCommand(handler, command)) {
          handler.command = command;
          handler.commandWindows = command;
          return 'updated';
        }
        return 'present';
      }
    }
  }
  const handler = { type: 'command', command, commandWindows: command, timeout: 10 };
  const group = matcher ? { matcher, hooks: [handler] } : { hooks: [handler] };
  groups.push(group);
  return 'added';
}

function runCodex(codex, args, opts = {}) {
  // On Windows `which` resolves codex to codex.cmd, and Node (post
  // CVE-2024-27980) refuses to spawnSync a .cmd/.bat without a shell.
  return run(codex, args, { ...opts, shell: IS_WIN || opts.shell === true });
}

function ensureMcpServer(baseUrl) {
  const codex = which('codex');
  if (!codex) {
    log.warn('codex not on PATH — add the MCP server later with:');
    log.info(`  codex mcp add cross-agent-teams --url ${baseUrl}/mcp`);
    return 'skipped';
  }
  const url = `${baseUrl}/mcp`;
  const listed = runCodex(codex, ['mcp', 'list'], { timeout: 15000 });
  if (listed.ok && String(listed.stdout || '').includes('cross-agent-teams')) {
    // Presence is not enough: an earlier install may have written the default
    // port on a box whose daemon actually runs elsewhere (9102 on dgmfa).
    if (String(listed.stdout || '').includes(url)) {
      log.info('codex: cross-agent-teams MCP already configured');
      return 'present';
    }
    log.warn('codex: cross-agent-teams MCP points at a stale URL — replacing it');
    runCodex(codex, ['mcp', 'remove', 'cross-agent-teams'], { timeout: 15000 });
  }
  const added = runCodex(codex, ['mcp', 'add', 'cross-agent-teams', '--url', url], { timeout: 20000 });
  if (added.ok) {
    log.ok(`codex: MCP -> ${url}`);
    return 'added';
  }
  log.warn(`codex: could not add the MCP server automatically (${(added.stderr || '').trim().split('\n')[0] || 'unknown error'})`);
  log.info(`  add it with: codex mcp add cross-agent-teams --url ${url}`);
  return 'failed';
}

export function installCodex(paths, { baseUrl = BASE_URL } = {}) {
  log.step('Codex CLI: hook + hooks.json + MCP entry');
  const lay = codexPaths(paths);
  if (!fs.existsSync(lay.dir)) {
    log.warn('~/.codex not found — Codex CLI not installed here; skipping (safe to re-run later)');
    return { skipped: true };
  }

  // 1. hook file
  ensureDir(paths.xatsRoot);
  copyFile(HOOK_SRC, lay.hookDest);

  // 2. hooks.json (Codex requires the person to trust new hooks in /hooks once)
  const q = (s) => `"${s}"`;
  const command = (mode) => `${q(nodeBin())} ${q(lay.hookDest)} ${mode}`;
  const file = readJson(lay.hooksFile, {}) || {};
  file.hooks = file.hooks || {};
  const started = ensureHook(file.hooks, 'SessionStart', command('start'), 'startup|resume|clear|compact|fork');
  const prompted = ensureHook(file.hooks, 'UserPromptSubmit', command('prompt'));
  const ended = ensureHook(file.hooks, 'SessionEnd', command('end'));
  if (started === 'present' && prompted === 'present' && ended === 'present') {
    log.info('codex: hooks already wired');
  } else {
    writeJson(lay.hooksFile, file);
  }
  log.ok(`codex hooks: SessionStart=${started}, UserPromptSubmit=${prompted}, SessionEnd=${ended}`);

  // 3. MCP server
  const mcp = ensureMcpServer(baseUrl);

  // 4. skill
  copyFile(SKILL_SRC, path.join(lay.skillsDir, 'SKILL.md'));

  log.info('codex: trust the new hooks once in a session with /hooks');
  return { hookDest: lay.hookDest, hooksFile: lay.hooksFile, mcp };
}

export function resetCodex(paths) {
  const lay = codexPaths(paths);
  const file = readJson(lay.hooksFile, null);
  if (file?.hooks) {
    let changed = false;
    for (const [event, groups] of Object.entries(file.hooks)) {
      const kept = (groups || [])
        .map((group) => ({
          ...group,
          hooks: (group.hooks || []).filter((handler) => {
            const owned = typeof handler?.command === 'string' && handler.command.includes(MARKER);
            changed ||= owned;
            return !owned;
          }),
        }))
        .filter((group) => group.hooks.length);
      if (kept.length > 0) file.hooks[event] = kept;
      else delete file.hooks[event];
    }
    if (changed) {
      if (Object.keys(file.hooks).length === 0) delete file.hooks;
      writeJson(lay.hooksFile, file);
    }
  }
  const codex = which('codex');
  if (codex) {
    const removed = runCodex(codex, ['mcp', 'remove', 'cross-agent-teams'], { timeout: 15000 });
    if (removed.ok) log.ok('codex: removed cross-agent-teams MCP entry');
  }
  return { hookDest: lay.hookDest, skillsDir: lay.skillsDir };
}

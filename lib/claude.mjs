// claude.mjs — wire Claude Code onto the bus, cross-platform.
//   1. install the Node hook (xats-hook.mjs) to a stable path
//   2. add SessionStart/SessionEnd hooks in settings.json (idempotent merge)
//   3. add the cross-agent-teams MCP http entry in ~/.claude.json
//   4. install the xats mod and point CLAUDE_CODE_PLUGIN_DIRS at it
//   5. optionally add the channel proxy stdio entry (legacy wake transport)
//
// The mod owns delivery and drawing: it renders xats mail as native Claude Code
// UI and hands it to Claude as a plugin-attributed prompt. The channel proxy is
// therefore opt-in; with both active a message would wake the session twice.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { log, isDry, copyFile, readJson, writeJson, ensureDir } from './log.mjs';
import { nodeBin, IS_WIN } from './platform.mjs';
import { BASE_URL } from './constants.mjs';
import { daemonLayout } from './daemon.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const HOOK_SRC = path.join(__dir, '..', 'assets', 'claude', 'xats-hook.mjs');
const MOD_SRC = path.join(__dir, '..', 'assets', 'claude', 'mod');
const SKILL_SRC = path.join(__dir, '..', 'assets', 'skills', 'xats', 'SKILL.md');
const MARKER = 'xats-hook';

// Ensure one command-hook entry for `event` invoking our hook with `mode`.
function ensureHook(settings, event, command) {
  settings.hooks = settings.hooks || {};
  const groups = settings.hooks[event] = settings.hooks[event] || [];
  for (const g of groups) {
    for (const h of (g.hooks || [])) {
      if (typeof h.command === 'string' && h.command.includes(MARKER)) {
        if (h.command !== command) { h.command = command; return 'updated'; }
        return 'present';
      }
    }
  }
  groups.push({ matcher: '', hooks: [{ type: 'command', command }] });
  return 'added';
}

// Copy the mod and make Claude Code load it from its plugin directory list.
// CLAUDE_CODE_PLUGIN_DIRS is the supported way to load a plugin directory from
// a location that is not a marketplace install.
function installMod(paths) {
  const dest = path.join(paths.xatsRoot, 'claude-mod');
  if (isDry()) {
    log.dry(`copy xats mod -> ${dest}`);
    return dest;
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(MOD_SRC, dest, { recursive: true });
  log.ok(`mod -> ${dest}`);
  return dest;
}

// Windows joins CLAUDE_CODE_PLUGIN_DIRS with ';', POSIX with ':'. The separator
// is a parameter so both can be tested on one machine.
export function ensurePluginDir(settings, dir, sep = IS_WIN ? ';' : ':') {
  settings.env = settings.env || {};
  const current = typeof settings.env.CLAUDE_CODE_PLUGIN_DIRS === 'string' ? settings.env.CLAUDE_CODE_PLUGIN_DIRS : '';
  const parts = current.split(sep).map((s) => s.trim()).filter(Boolean);
  if (parts.includes(dir)) return 'present';
  parts.push(dir);
  settings.env.CLAUDE_CODE_PLUGIN_DIRS = parts.join(sep);
  return 'added';
}

export function installClaude(paths, { withChannel = false, baseUrl = BASE_URL } = {}) {
  log.step('Claude Code: hook + settings + MCP entry');
  if (!fs.existsSync(paths.claudeDir)) {
    log.warn(`~/.claude not found — Claude Code not installed here; skipping (safe to re-run later)`);
    return { skipped: true };
  }

  // 1. hook file
  const hookDest = path.join(paths.xatsRoot, 'xats-hook.mjs');
  ensureDir(paths.xatsRoot);
  copyFile(HOOK_SRC, hookDest);

  // 2. settings.json hooks (cross-platform command: `node "<path>" <mode>`)
  const q = (s) => `"${s}"`;
  const startCmd = `${q(nodeBin())} ${q(hookDest)} start`;
  const endCmd = `${q(nodeBin())} ${q(hookDest)} end`;
  const settings = readJson(paths.claudeSettings, {}) || {};
  const a = ensureHook(settings, 'SessionStart', startCmd);
  const b = ensureHook(settings, 'SessionEnd', endCmd);
  if (a === 'present' && b === 'present') log.info('SessionStart/SessionEnd hooks already wired');
  log.ok(`hooks: SessionStart=${a}, SessionEnd=${b}`);

  // 3. MCP entries in ~/.claude.json
  const cj = readJson(paths.claudeJson, {}) || {};
  cj.mcpServers = cj.mcpServers || {};

  const httpWant = { type: 'http', url: `${baseUrl}/mcp` };
  const httpCur = cj.mcpServers['cross-agent-teams'];
  const httpChanged = JSON.stringify(httpCur) !== JSON.stringify(httpWant);
  if (httpChanged) cj.mcpServers['cross-agent-teams'] = httpWant;
  if (httpChanged) log.ok('MCP http -> ' + httpWant.url);
  else log.info('MCP http entry already present');

  // 4. The xats mod: native drawing + attributed delivery.
  const modDest = installMod(paths);
  const envState = ensurePluginDir(settings, modDest);
  if (a !== 'present' || b !== 'present' || envState === 'added') writeJson(paths.claudeSettings, settings);
  log.ok(`mod plugin dir: ${envState}`);

  // 5. The legacy channel proxy is retired: the xats mod delivers, and the daemon
  // we own has no channel entry point. Clean up an entry from earlier installs.
  let channelChanged = false;
  if (cj.mcpServers['cross-agent-teams-channel'] !== undefined) {
    delete cj.mcpServers['cross-agent-teams-channel'];
    channelChanged = true;
    log.ok('removed channel proxy MCP entry (retired; the xats mod delivers)');
  }
  if (withChannel) log.warn('--with-channel is retired: Claude delivery is the xats mod');

  if (httpChanged || channelChanged) writeJson(paths.claudeJson, cj);

  // skill (also installed via harness historically — now owned by claude component)
  copyFile(SKILL_SRC, path.join(paths.claudeDir, 'skills', 'xats', 'SKILL.md'));

  return { hookDest, modDest };
}

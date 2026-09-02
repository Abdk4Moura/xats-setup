// claude.mjs — wire Claude Code onto the bus, cross-platform.
//   1. install the Node hook (xats-hook.mjs) to a stable path
//   2. add SessionStart/SessionEnd hooks in settings.json (idempotent merge)
//   3. add the cross-agent-teams MCP http entry in ~/.claude.json
//   4. add the channel proxy stdio entry (receive channel + keepalive)
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { log, isDry, copyFile, readJson, writeJson, ensureDir } from './log.mjs';
import { nodeBin } from './platform.mjs';
import { BASE_URL } from './constants.mjs';
import { daemonLayout } from './daemon.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const HOOK_SRC = path.join(__dir, '..', 'assets', 'claude', 'xats-hook.mjs');
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

export function installClaude(paths) {
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
  else writeJson(paths.claudeSettings, settings);
  log.ok(`hooks: SessionStart=${a}, SessionEnd=${b}`);

  // 3. MCP entries in ~/.claude.json
  const cj = readJson(paths.claudeJson, {}) || {};
  cj.mcpServers = cj.mcpServers || {};

  const httpWant = { type: 'http', url: `${BASE_URL}/mcp` };
  const httpCur = cj.mcpServers['cross-agent-teams'];
  const httpChanged = JSON.stringify(httpCur) !== JSON.stringify(httpWant);
  if (httpChanged) cj.mcpServers['cross-agent-teams'] = httpWant;
  if (httpChanged) log.ok('MCP http -> ' + httpWant.url);
  else log.info('MCP http entry already present');

  // 4. Channel proxy (receive channel + connection-based liveness).
  // Runs cross-agent-teams-channel over stdio, holds a persistent MCP
  // connection, and keeps the agent alive via periodic echo cascading
  // through touchByChannelSession. Dies with Claude (stdio close).
  const lay = daemonLayout(paths);
  const channelEntry = lay.channelEntry;
  const channelWant = {
    type: 'stdio',
    command: nodeBin(),
    args: [channelEntry, '--daemon-url', `${BASE_URL}/mcp`]
  };
  const channelCur = cj.mcpServers['cross-agent-teams-channel'];
  const channelChanged = JSON.stringify(channelCur) !== JSON.stringify(channelWant);
  if (channelChanged) cj.mcpServers['cross-agent-teams-channel'] = channelWant;
  if (channelChanged) log.ok('MCP channel proxy -> ' + channelEntry);
  else log.info('Channel proxy MCP entry already present');

  if (httpChanged || channelChanged) writeJson(paths.claudeJson, cj);

  // skill (also installed via harness historically — now owned by claude component)
  copyFile(SKILL_SRC, path.join(paths.claudeDir, 'skills', 'xats', 'SKILL.md'));

  return { hookDest };
}

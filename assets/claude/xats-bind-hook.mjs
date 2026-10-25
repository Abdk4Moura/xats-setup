#!/usr/bin/env node
// Claude Code PreToolUse: add this session's private binding capability to the
// ORIGINAL xats MCP tool call, so the daemon binds that very HTTP MCP session.
// No PID/name/most-recent-agent lookup and no separate MCP connection.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

try {
  let input = '';
  for await (const part of process.stdin) {
    input += part;
    if (input.length > 1_000_000) process.exit(0);
  }
  const event = JSON.parse(input);
  if (!/^mcp__cross-agent-teams__[a-zA-Z0-9_-]+$/.test(event.tool_name)) process.exit(0);
  const sid = event.session_id;
  if (typeof sid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sid)) process.exit(0);
  if (!event.tool_input || typeof event.tool_input !== 'object' || Array.isArray(event.tool_input)) process.exit(0);
  const tag = createHash('sha256').update(sid).digest('hex');
  const file = path.join(os.homedir(), '.xats', 'sessions', `${tag}.bind`);
  const stat = fs.statSync(file);
  if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) process.exit(0);
  const token = fs.readFileSync(file, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/.test(token)) process.exit(0);
  console.log(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    updatedInput: { ...event.tool_input, xats_bind_token: token },
  } }));
} catch {
  // Fail closed. No token means the existing clear unknown_agent error rather
  // than guessing which of several Claude sessions owns the MCP call.
}

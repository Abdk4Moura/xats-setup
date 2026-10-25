import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const hook = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'claude', 'xats-bind-hook.mjs')

test('Claude hook injects only its own private capability on xats MCP calls', () => {
  const root = path.join(os.homedir(), '.xats', 'test-scratch')
  fs.mkdirSync(root, { recursive: true })
  const home = fs.mkdtempSync(path.join(root, 'bind-hook-'))
  try {
    const sessionDir = path.join(home, '.xats', 'sessions')
    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 })
    const sid = 'claude-test-session'
    const file = path.join(sessionDir, `${createHash('sha256').update(sid).digest('hex')}.bind`)
    const token = 'a'.repeat(64)
    fs.writeFileSync(file, token, { mode: 0o600 })
    const run = (name, sessionId = sid) => spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ session_id: sessionId, tool_name: name, tool_input: { limit: 2 } }),
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home },
    })
    const good = run('mcp__cross-agent-teams__get_inbox')
    assert.equal(good.status, 0)
    assert.deepEqual(JSON.parse(good.stdout).hookSpecificOutput.updatedInput, { limit: 2, xats_bind_token: token })
    assert.equal(run('mcp__other__get_inbox').stdout, '')
    assert.equal(run('mcp__cross-agent-teams__get_inbox', 'different-session').stdout, '')
    if (process.platform !== 'win32') {
      fs.chmodSync(file, 0o644)
      assert.equal(run('mcp__cross-agent-teams__get_inbox').stdout, '')
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

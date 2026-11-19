import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const hook = fileURLToPath(new URL('../assets/claude/xats-hook.mjs', import.meta.url))

test('Claude opt-in hook keeps adapter capability private and removes it on end', { timeout: 15000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xats-local-hook-'))
  const requests = []
  const token = 'a'.repeat(43) // fixture capability, not a real credential
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    requests.push({ url: req.url, body: JSON.parse(raw) })
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(req.url === '/api/register' ? {
      agent_id: 'hook-agent', name: 'hook-agent', team: 'default',
      bind_token: 'b'.repeat(64), bind_code: 'ABCD-EFGH',
      local_delivery: { token, generation: 1, expiresAt: Date.now() + 60000 },
    } : { ok: true }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const run = (mode, optIn, sid = 'owned-session') => new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [hook, mode], {
      env: { ...process.env, HOME: home, USERPROFILE: home,
        XATS_BASE: `http://127.0.0.1:${server.address().port}`, XATS_LOCAL_DELIVERY: optIn ? '1' : '0', CLAUDE_JOB_DIR: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''; let stderr = ''
    proc.stdout.on('data', c => { stdout += c })
    proc.stderr.on('data', c => { stderr += c })
    proc.on('error', reject)
    proc.on('exit', code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`hook exit ${code}: ${stderr}`)))
    proc.stdin.end(JSON.stringify({ session_id: sid }))
  })
  const started = await run('start', true)
  assert.equal(requests[0].body.local_delivery, true)
  const file = path.join(home, '.xats', 'sessions', 'owned-session.delivery.json')
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, token)
  assert.ok(!started.stdout.includes(token))
  assert.ok(!started.stderr.includes(token))
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  await run('end', true)
  assert.equal(fs.existsSync(file), false)
  await run('start', false)
  assert.equal(requests.at(-1).body.local_delivery, undefined)
  assert.equal(fs.existsSync(file), false)
  await run('start', true, '../unsafe')
  assert.equal(requests.at(-1).body.local_delivery, undefined, 'raw session IDs must never create arbitrary paths')
})

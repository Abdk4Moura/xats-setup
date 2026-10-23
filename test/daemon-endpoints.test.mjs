import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Endpoint coverage for the daemon we own (daemon/src, built to daemon/dist).
//
// This exists because the vendored bundle once shipped MORE REST endpoints than
// the source it claimed to come from (8 vs 3), and nothing noticed until a
// feature silently depended on one of the extras (/api/agents/all). A build that
// drops a route must fail here, not in an adapter three layers away.

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI = path.join(root, 'daemon', 'dist', 'cli.js')

function depsAvailable() {
  for (const dir of [process.env.XATS_SETUP_TEST_DEPS, path.join(os.homedir(), '.xats', 'daemon', 'node_modules')].filter(Boolean)) {
    try {
      if (fs.statSync(path.join(dir, 'fastify')).isDirectory()) return dir
    } catch {
      /* next */
    }
  }
  return null
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

async function withDaemon(fn) {
  const deps = depsAvailable()
  if (!deps) return { skipped: 'daemon dependencies not installed (set XATS_SETUP_TEST_DEPS)' }
  if (!fs.existsSync(CLI)) return { skipped: 'daemon/dist/cli.js missing — run `npm run build:daemon`' }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xats-endpoints-'))
  fs.symlinkSync(deps, path.join(dir, 'node_modules'), 'dir')
  const cli = path.join(dir, 'cli.js')
  fs.copyFileSync(CLI, cli)
  const home = path.join(dir, 'home')
  fs.mkdirSync(home, { recursive: true })
  const port = await freePort()
  const proc = spawn(
    process.execPath,
    [cli, 'daemon', '--device', 'endpoint-test', '--port', String(port), '--db', path.join(dir, 'data.db')],
    { env: { ...process.env, CROSS_AGENT_TEAMS_MCP_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let stderr = ''
  proc.stderr.on('data', (c) => {
    stderr += String(c)
  })
  const base = `http://127.0.0.1:${port}`

  try {
    const deadline = Date.now() + 20_000
    let up = false
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) throw new Error(`daemon exited early (${proc.exitCode})\n${stderr.slice(-1200)}`)
      try {
        const res = await fetch(`${base}/health`)
        if (res.ok) {
          up = true
          break
        }
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 150))
    }
    if (!up) throw new Error(`daemon never became healthy\n${stderr.slice(-1200)}`)
    return await fn(base)
  } finally {
    proc.kill('SIGKILL')
    await new Promise((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve()
      proc.once('exit', resolve)
      setTimeout(resolve, 3000)
    })
    try {
      // Windows cannot unlink a file SQLite still holds; retry rather than fail.
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } catch {
      /* leftover temp dir is not a failure */
    }
  }
}

const post = (base, pathname, body) =>
  fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const get = (base, pathname) => fetch(`${base}${pathname}`)

test('every REST endpoint the adapters rely on exists and answers', { timeout: 90_000 }, async (t) => {
  const result = await withDaemon(async (base) => {
    const calls = {}

    calls.health = (await get(base, '/health')).status
    const reg = await post(base, '/api/register', {
      name: 'endpoint-probe',
      team: 'default',
      session_key: 'endpoint-session-1',
      agent_type: 'custom',
    })
    calls.register = reg.status
    const registered = await reg.json()

    // session_key must round-trip: the Claude mod and the OpenCode badge both
    // find their agent by it, so a silent drop here breaks both.
    const agents = await (await get(base, '/api/agents?team=default')).json()
    const mine = (agents.agents ?? []).find((a) => a.agent_id === registered.agent_id)
    assert.equal(mine?.session_key, 'endpoint-session-1')

    // Cross-team roster: peer federation advertises from this.
    const all = await (await get(base, '/api/agents/all')).json()
    assert.ok(Array.isArray(all.agents), '/api/agents/all must return an agents array')
    assert.ok(all.agents.some((a) => a.agent_id === registered.agent_id))

    calls.heartbeat = (await post(base, '/api/heartbeat', { agent_id: registered.agent_id })).status
    calls.whoami = (await post(base, '/api/whoami', { agent_id: registered.agent_id })).status
    calls.inbox = (await get(base, '/api/inbox?team=default&name=endpoint-probe&since_event_id=0')).status
    calls.send = (
      await post(base, '/api/send', {
        from: { team: 'default', name: 'endpoint-probe' },
        to: { name: 'endpoint-probe', team: 'default' },
        body: 'self-send',
      })
    ).status
    calls.deregister = (await post(base, '/api/deregister', { agent_id: registered.agent_id })).status

    return calls
  })

  if (result?.skipped) return t.skip(result.skipped)

  for (const [name, status] of Object.entries(result)) {
    assert.ok(status >= 200 && status < 300, `${name} returned ${status}`)
  }
})

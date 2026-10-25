import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = path.join(root, 'daemon', 'dist', 'cli.js')
const deps = [process.env.XATS_SETUP_TEST_DEPS, path.join(os.homedir(), '.xats', 'daemon', 'node_modules')]
  .filter(Boolean).find(dir => fs.existsSync(path.join(dir, 'fastify')))

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

async function fixture(fn, env = {}) {
  const scratch = path.join(os.homedir(), '.xats', 'test-scratch')
  fs.mkdirSync(scratch, { recursive: true })
  const dir = fs.mkdtempSync(path.join(scratch, 'claude-bind-'))
  fs.symlinkSync(deps, path.join(dir, 'node_modules'), 'dir')
  fs.copyFileSync(cli, path.join(dir, 'cli.js'))
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const proc = spawn(process.execPath, [path.join(dir, 'cli.js'), 'daemon', '--port', String(port), '--device', 'bind-test', '--db', path.join(dir, 'state.db'), '--pid-file', path.join(dir, 'daemon.pid'), '--no-loopback-companion'], {
    env: { ...process.env, ...env, CROSS_AGENT_TEAMS_MCP_HOME: dir }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  proc.stderr.on('data', chunk => { stderr += chunk.toString() })
  try {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) throw Error(`daemon exited ${proc.exitCode}: ${stderr}`)
      try { if ((await fetch(`${base}/health`)).ok) break } catch { /* startup */ }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal((await fetch(`${base}/health`)).status, 200, `daemon startup: ${stderr}`)
    return await fn(base)
  } finally {
    proc.kill('SIGKILL')
    await new Promise(resolve => { if (proc.exitCode !== null || proc.signalCode !== null) resolve(); else proc.once('exit', resolve) })
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

const post = async (base, route, body) => {
  const response = await fetch(`${base}${route}`, { method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body) })
  return { status: response.status, data: await response.json() }
}
const output = result => JSON.parse(result.content[0].text)
async function mcpClient(base) {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`))
  const client = new Client({ name: 'claude-bind-e2e', version: '1.0.0' })
  await client.connect(transport)
  return { client, close: () => client.close() }
}

test('Claude first MCP call binds exactly its hook identity; resumes keep mailbox ID and stale tokens fail', { timeout: 90000, skip: !deps || !fs.existsSync(cli) }, async () => {
  await fixture(async base => {
    const a = await post(base, '/api/register', { name: 'claude-a', team: 'default', agent_type: 'claude-code', session_key: 'session-a', bind_mcp: true })
    const b = await post(base, '/api/register', { name: 'claude-b', team: 'default', agent_type: 'claude-code', session_key: 'session-b', bind_mcp: true })
    assert.equal(a.status, 200); assert.equal(b.status, 200)
    assert.match(a.data.bind_token, /^[0-9a-f]{64}$/)
    const one = await mcpClient(base)
    const two = await mcpClient(base)
    const unbound = await mcpClient(base)
    try {
      assert.equal(output(await unbound.client.callTool({name:'get_inbox', arguments:{}})).error, 'unknown_agent')
      assert.notEqual(a.data.agent_id, b.data.agent_id)
      assert.equal(output(await one.client.callTool({name:'get_inbox', arguments:{xats_bind_token:a.data.bind_token}})).error, undefined)
      assert.equal(output(await two.client.callTool({name:'get_inbox', arguments:{xats_bind_token:b.data.bind_token}})).error, undefined)
      await assert.rejects(() => unbound.client.callTool({name:'get_inbox', arguments:{xats_bind_token:a.data.bind_token}}))
      await assert.rejects(() => one.client.callTool({name:'get_inbox', arguments:{xats_bind_token:b.data.bind_token}}))
      // Failed cross-session bind must not alter either established identity.
      assert.equal(output(await one.client.callTool({name:'get_inbox', arguments:{}})).error, undefined)
      const offline = await post(base, '/api/deregister', { agent_id:a.data.agent_id, session_key:'session-a', retain_mailbox:true })
      assert.deepEqual(offline, {status:200, data:{ok:true}})
      const sender = await post(base, '/api/register', {name:'sender', team:'default', agent_type:'custom'})
      assert.equal(sender.status, 200)
      const mail = await post(base, '/api/send', {from:{name:'sender', team:'default'}, to:{agent_id:a.data.agent_id}, body:'while-offline', auto_poke:false})
      assert.equal(mail.status, 200)
      const resume = await post(base, '/api/register', {name:'claude-a', team:'default', agent_type:'claude-code', session_key:'session-a', bind_mcp:true})
      assert.equal(resume.status, 200)
      assert.equal(resume.data.agent_id, a.data.agent_id)
      assert.notEqual(resume.data.bind_token, a.data.bind_token)
      const restarted = await mcpClient(base)
      try {
        await assert.rejects(() => restarted.client.callTool({name:'get_inbox', arguments:{xats_bind_token:a.data.bind_token}}))
        // The old session must close before a newly resumed MCP session can
        // claim the identity. A stale live session is never silently displaced.
        await one.close()
        const inbox = output(await restarted.client.callTool({name:'get_inbox', arguments:{xats_bind_token:resume.data.bind_token}}))
        assert.equal(inbox.error, undefined)
        assert.ok(inbox.messages.some(message => message.body === 'while-offline'))
      } finally { await restarted.close() }
    } finally {
      await Promise.allSettled([one.close(), two.close(), unbound.close()])
    }
  })
})

 test('TTL reaper marks a keyed Claude row offline and resume keeps its mailbox identity', { timeout: 60000, skip: !deps || !fs.existsSync(cli) }, async () => {
  await fixture(async base => {
    const original = await post(base, '/api/register', { name: 'claude-resume', team: 'default', agent_type: 'claude-code', session_key: 'resume-key', bind_mcp: true })
    assert.equal(original.status, 200)
    await new Promise(resolve => setTimeout(resolve, 400))
    const agents = await (await fetch(`${base}/api/agents?team=default`)).json()
    const row = agents.agents.find(agent => agent.agent_id === original.data.agent_id)
    assert.equal(row?.online, false)
    // TTL expiry revokes the capability; it cannot bind after offline transition.
    const oldClient = await mcpClient(base)
    try {
      await assert.rejects(() => oldClient.client.callTool({name:'get_inbox', arguments:{xats_bind_token:original.data.bind_token}}))
    } finally { await oldClient.close() }
    const resumed = await post(base, '/api/register', { name: 'claude-resume', team: 'default', agent_type: 'claude-code', session_key: 'resume-key', bind_mcp: true })
    assert.equal(resumed.status, 200)
    assert.equal(resumed.data.agent_id, original.data.agent_id)
    assert.notEqual(resumed.data.bind_token, original.data.bind_token)
    const client = await mcpClient(base)
    try {
      const inbox = output(await client.client.callTool({name:'get_inbox', arguments:{xats_bind_token:resumed.data.bind_token}}))
      assert.equal(inbox.error, undefined)
    } finally { await client.close() }
  }, { AGENT_TTL_MS: '100', AGENT_REAP_INTERVAL_MS: '50' })
})

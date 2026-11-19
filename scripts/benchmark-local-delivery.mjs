#!/usr/bin/env node
// Loopback arrival-hint benchmark only. This does not time model responses,
// Claude queue admission, or native UDS delivery. Requires npm ci.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xats-arrival-bench-'))
const bundle = path.join(dir, 'server.mjs')
let app
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
try {
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'junction')
  await build({ entryPoints: [path.join(root, 'daemon/src/daemon/server.ts')], outfile: bundle,
    bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
  const { startServer } = await import(pathToFileURL(bundle).href)
  const started = await startServer({ dbPath: path.join(dir, 'data.db'), localDevice: 'arrival-bench', port: 0 })
  app = started.app
  const base = `http://127.0.0.1:${started.port}`
  const post = async (route, body, token) => {
    const res = await fetch(base + route, { method: 'POST', headers: {
      'content-type': 'application/json', ...(token ? { 'x-xats-delivery-token': token } : {}),
    }, body: JSON.stringify(body) })
    if (!res.ok) throw new Error(`benchmark HTTP ${res.status}`)
    return res.json()
  }
  await post('/api/register', { name: 'sender', agent_type: 'custom' })
  const local = await post('/api/register', { name: 'local', agent_type: 'claude-code', session_key: 'benchmark-owned', bind_mcp: true, local_delivery: true })
  await post('/api/register', { name: 'poll', agent_type: 'custom' })
  const send = name => post('/api/send', { from: { name: 'sender', team: 'default' }, to: { name }, body: 'arrival timing', auto_poke: name === 'local' })
  const localTimes = [], pollingTimes = []
  let since = 0
  const cpuStart = process.cpuUsage()
  for (let i = 0; i < 12; i++) {
    const waiting = fetch(`${base}/api/local-delivery/wait?timeout_ms=10000`, { headers: { 'x-xats-delivery-token': local.local_delivery.token } })
    await sleep(15)
    const start = performance.now()
    const sent = await send('local')
    const response = await waiting
    if (!response.ok) throw new Error(`wait HTTP ${response.status}`)
    const hint = (await response.json()).hints[0]
    if (hint?.event_id !== sent.event_id) throw new Error('unexpected hint')
    localTimes.push(performance.now() - start)
    // The benchmark observed a hint, not actual host queue admission.
    await post('/api/local-delivery/ack', { attempt_id: hint.attempt_id, stage: 'transport-written' }, local.local_delivery.token)
  }
  const localCpu = process.cpuUsage(cpuStart)
  const pollingCpuStart = process.cpuUsage()
  // Each sample starts just after a successful mailbox poll. Deterministic
  // arrival phases cover one full 3-second poll interval three times.
  for (let i = 0; i < 12; i++) {
    const phase = (i % 4) * 750
    const cycle = performance.now()
    await sleep(phase)
    const start = performance.now()
    const sent = await send('poll')
    await sleep(Math.max(0, 3000 - (performance.now() - cycle)))
    const res = await fetch(`${base}/api/inbox?team=default&name=poll&since_event_id=${since}`)
    const data = await res.json()
    if (!data.messages.some(m => m.event_id === sent.event_id)) throw new Error('missing polled message')
    since = data.last_event_id
    pollingTimes.push(performance.now() - start)
  }
  const summarize = times => {
    const sorted = [...times].sort((a, b) => a - b)
    const percentile = p => Number(sorted[Math.ceil(sorted.length * p) - 1].toFixed(2))
    return { samples: times.length, p50_ms: percentile(0.5), p95_ms: percentile(0.95) }
  }
  console.log(JSON.stringify({
    scope: 'local loopback arrival hints, not model latency or host queue receipts',
    platform: `${process.platform}/${process.arch}`, node: process.version,
    event_driven: { ...summarize(localTimes), process_cpu_microseconds: localCpu },
    polling_3000ms: { ...summarize(pollingTimes), process_cpu_microseconds: process.cpuUsage(pollingCpuStart) },
    caveats: ['Polling baseline simulates the existing 3-second arrival interval with deterministic phases.',
      'CPU includes benchmark, HTTP clients, and daemon in one process, not a production host measurement.',
      'No native Claude transport or model execution is involved.'],
  }, null, 2))
} finally {
  if (app) await app.close()
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

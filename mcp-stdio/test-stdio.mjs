#!/usr/bin/env node
/**
 * End-to-end check for mcp-stdio: spawn the bridge exactly as an MCP client
 * would, then prove tools/list and a real tools/call work through it.
 *
 * Run with the xats daemon up:  node mcp-stdio/test-stdio.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const entry = path.join(here, 'src', 'index.mjs')

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  env: { ...process.env },
  stderr: 'pipe',
})

const client = new Client({ name: 'stdio-bridge-test', version: '0.0.0' }, { capabilities: {} })

let failed = false
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failed = true
}

try {
  await client.connect(transport)
  check('initialize over stdio', true, `server=${client.getServerVersion()?.name ?? 'unknown'}`)

  const tools = await client.listTools()
  const names = tools.tools.map((t) => t.name)
  check('tools/list returns tools', names.length > 0, `${names.length} tools`)
  // The daemon exposes unprefixed tool names; the xats_ prefix is Pi-side only.
  const identityTools = ['list_agents', 'register_agent', 'get_inbox', 'send_message']
  const present = identityTools.filter((t) => names.includes(t))
  check('core xats identity tools are present', present.length >= 3, present.join(', '))

  if (names.includes('echo')) {
    const result = await client.callTool({ name: 'echo', arguments: { msg: 'stdio bridge' } })
    const text = (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
    // A tool error must not be reported as a pass: assert a real result, not just text.
    const ok = result.isError !== true && text.includes('stdio bridge')
    check('tools/call round-trips through the daemon', ok, ok ? text.slice(0, 58) : text.slice(0, 90))
  } else {
    check('tools/call round-trips through the daemon', false, 'no echo tool to exercise')
  }
} catch (error) {
  check('bridge lifecycle', false, error?.message ?? String(error))
} finally {
  await client.close().catch(() => {})
}

console.log(failed ? '\nRESULT: failures above' : '\nRESULT: stdio bridge verified end to end')
process.exit(failed ? 1 : 0)

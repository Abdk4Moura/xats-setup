#!/usr/bin/env node
/**
 * xats-mcp: a stdio MCP server that bridges to the local xats daemon.
 *
 * Why a bridge and not its own logic: the daemon is the single authority for
 * identities, mailboxes and delivery. A second in-process implementation would
 * fork that authority and let two writers disagree about the same mail. So this
 * process speaks stdio MCP to the client and streamable HTTP MCP to the daemon,
 * and owns no state of its own.
 *
 * Hosts that already speak HTTP MCP (Claude Code, Codex, OpenCode v2, Pi) keep
 * using the daemon directly. This exists for stdio-only clients, containerised
 * agents, and registry/aggregator listings that require a runnable stdio command.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const VERSION = '0.1.0'
const DEFAULT_PORT = 9100

function resolveDaemonUrl() {
  const explicit = process.env.XATS_MCP_URL
  if (explicit) return explicit
  const port = process.env.XATS_PORT || DEFAULT_PORT
  return `http://127.0.0.1:${port}/mcp`
}

function fail(message) {
  process.stderr.write(`xats-mcp: ${message}\n`)
  process.exit(1)
}

async function main() {
  const url = resolveDaemonUrl()

  const client = new Client({ name: 'xats-mcp-bridge', version: VERSION }, { capabilities: {} })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  } catch (error) {
    // The common failure is "the daemon is not running", so say that instead of
    // dumping a fetch stack. A bare ECONNREFUSED is the single most likely first
    // experience a new user has.
    const reason = error?.code === 'ECONNREFUSED' || /fetch failed|ECONNREFUSED/i.test(String(error?.message))
      ? `cannot reach the xats daemon at ${url}. Start it with: npx xats-setup --only=daemon,service (or "xats-setup" for a full install).`
      : `cannot reach the xats daemon at ${url}: ${error?.message ?? error}`
    fail(reason)
  }

  // Advertise only what the daemon actually offers, so a client never sees a
  // capability this bridge cannot serve.
  const capabilities = client.getServerCapabilities() ?? {}
  const server = new Server(
    { name: 'xats', version: VERSION },
    {
      capabilities: {
        ...(capabilities.tools ? { tools: {} } : {}),
        ...(capabilities.resources ? { resources: {} } : {}),
        ...(capabilities.prompts ? { prompts: {} } : {}),
      },
    },
  )

  if (capabilities.tools) {
    server.setRequestHandler(ListToolsRequestSchema, async () => client.listTools())
    server.setRequestHandler(CallToolRequestSchema, async (request) =>
      client.callTool({ name: request.params.name, arguments: request.params.arguments ?? {} }))
  }

  if (capabilities.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, async () => client.listResources())
    server.setRequestHandler(ReadResourceRequestSchema, async (request) =>
      client.readResource({ uri: request.params.uri }))
  }

  if (capabilities.prompts) {
    server.setRequestHandler(ListPromptsRequestSchema, async () => client.listPrompts())
    server.setRequestHandler(GetPromptRequestSchema, async (request) =>
      client.getPrompt({ name: request.params.name, arguments: request.params.arguments }))
  }

  const transport = new StdioServerTransport()
  await server.connect(transport)

  const shutdown = () => {
    Promise.resolve(transport.close()).catch(() => {})
    Promise.resolve(client.close()).catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  process.stdin.on('close', shutdown)
}

main().catch((error) => fail(error?.message ?? String(error)))

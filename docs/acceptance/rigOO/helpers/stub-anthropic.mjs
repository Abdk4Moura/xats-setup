// Local Anthropic-shaped stub. No inference, no account, no quota.
// It answers with a real MCP tool_use so the real Claude Code CLI performs
// genuine tool round trips against the real daemon.
import http from 'node:http'

const port = Number(process.argv[2])
const log = process.argv[3]

function textBlock(text) { return { type: 'text', text } }

function pickTool(tools, suffix) {
  return tools.map(t => t?.name).filter(n => typeof n === 'string' && n.endsWith(suffix))[0]
}

function allText(body) {
  const parts = []
  // The SessionStart hook delivers its instructions via `system`, not only
  // `messages`; the bind code lives there.
  const sys = body?.system
  if (typeof sys === 'string') parts.push(sys)
  else if (Array.isArray(sys)) for (const p of sys) if (typeof p?.text === 'string') parts.push(p.text)
  for (const m of body?.messages ?? []) {
    const c = m?.content
    if (typeof c === 'string') parts.push(c)
    else if (Array.isArray(c)) for (const p of c) {
      if (typeof p?.text === 'string') parts.push(p.text)
      if (typeof p?.content === 'string') parts.push(p.content)
    }
  }
  return parts.join('\n')
}

// A read must be attributable to the plugin's own notice, never to the session
// instructions that merely mention "inbox". Only the last user message counts,
// so a tool result (the inbox JSON) does not re-trigger a read.
function lastUserText(body) {
  const msgs = body?.messages ?? []
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role !== 'user') continue
    const c = msgs[i].content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) return c.map(p => (typeof p?.text === 'string' ? p.text : '')).join('\n')
    return ''
  }
  return ''
}

function toolResultCount(body) {
  let n = 0
  for (const m of body?.messages ?? []) {
    if (!Array.isArray(m?.content)) continue
    for (const p of m.content) if (p?.type === 'tool_result') n++
  }
  return n
}

const server = http.createServer((req, res) => {
  if (req.method === 'HEAD') { res.writeHead(200).end(); return }
  let raw = ''
  req.on('data', b => { raw += b })
  req.on('end', () => {
    const path = req.url.split('?')[0]
    if (!path.endsWith('/messages')) { res.writeHead(404).end('{}'); return }
    let body = {}
    try { body = JSON.parse(raw) } catch { /* keep empty */ }
    const tools = Array.isArray(body.tools) ? body.tools : []
    const context = allText(body)
    const results = toolResultCount(body)
    const bind = pickTool(tools, 'bind')
    const inbox = pickTool(tools, 'get_inbox')
    const code = (context.match(/xats_bind with code ([A-Za-z0-9_-]{8,})/) || [])[1]

    let block = textBlock('ok')
    let stop = 'end_turn'
    if (bind && code && results === 0) {
      block = { type: 'tool_use', id: 'toolu_bind', name: bind, input: { code } }
      stop = 'tool_use'
    } else if (inbox && /<xats-inbox>/.test(lastUserText(body))) {
      block = { type: 'tool_use', id: `toolu_inbox_${results}`, name: inbox, input: {} }
      stop = 'tool_use'
    }
    if (log) {
      try { process.stdout.write(`${JSON.stringify({ turn: results, tool: block.type === 'tool_use' ? block.name : null, code: Boolean(code) })}\n`) } catch {}
    }
    const message = { id: `msg_${results}`, type: 'message', role: 'assistant', model: body.model || 'stub',
      content: block.type === 'tool_use' ? [] : [block], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 } }
    if (body.stream) {
      const events = [['message_start', { type: 'message_start', message }]]
      if (block.type === 'tool_use') {
        events.push(['content_block_start', { type: 'content_block_start', index: 0, content_block: { ...block, input: {} } }])
        events.push(['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }])
      } else {
        events.push(['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }])
        events.push(['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: block.text } }])
      }
      events.push(['content_block_stop', { type: 'content_block_stop', index: 0 }])
      events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } }])
      events.push(['message_stop', { type: 'message_stop' }])
      const data = events.map(([name, obj]) => `event: ${name}\ndata: ${JSON.stringify(obj)}\n\n`).join('')
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(data)
    } else {
      message.content = [block]
      message.stop_reason = stop
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(message))
    }
  })
})
server.listen(port, '127.0.0.1', () => process.stdout.write(`stub listening ${port}\n`))

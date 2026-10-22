// Dependency-free stand-in for the local xats daemon, used only where the real
// bundled daemon cannot run (no npm registry, no native modules). It implements
// exactly the loopback API surface the peer federation consumes:
//   GET  /health
//   GET  /api/agents/all
//   POST /api/register | /api/heartbeat | /api/deregister | /api/send
//   GET  /api/inbox
import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';

const portArgIndex = process.argv.indexOf('--port');
const port = portArgIndex > -1 ? Number(process.argv[portArgIndex + 1]) : 0;
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid_port');

const agents = new Map();
const messages = [];
let eventId = 0;

const sendJson = (res, status, body) => {
  const raw = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': raw.length });
  res.end(raw);
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    req.on('data', (chunk) => {
      length += chunk.length;
      if (length > 2 * 1024 * 1024) { req.destroy(new Error('body_too_large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (error) { reject(Object.assign(error, { statusCode: 400 })); }
    });
    req.once('error', reject);
  });
}

function agentId(name, team, role) {
  return createHash('sha256').update(`${team}\0${name}\0${role}`).digest('hex').slice(0, 32);
}

function findAgent({ agent_id, team, name }) {
  if (agent_id) return agents.get(agent_id) || null;
  for (const agent of agents.values()) {
    if (agent.team === team && agent.name === name) return agent;
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /health') return sendJson(res, 200, { ok: true, stub: true });

    if (route === 'GET /api/agents/all') {
      return sendJson(res, 200, { agents: [...agents.values()] });
    }

    if (route === 'POST /api/register') {
      const body = await readBody(req);
      const name = String(body.name || '');
      const team = String(body.team || 'default');
      const role = String(body.role || 'worker');
      if (!name) return sendJson(res, 400, { error: 'name_required' });
      const id = agentId(name, team, role);
      const existing = agents.get(id);
      if (existing) {
        existing.online = true;
        existing.heartbeat_at = Date.now();
        return sendJson(res, 200, { agent_id: id, reconnected: true, agent: existing });
      }
      const agent = {
        agent_id: id,
        name,
        team,
        role,
        agent_type: String(body.agent_type || 'custom'),
        agent_type_name: String(body.agent_type_name || ''),
        model: typeof body.model === 'string' ? body.model : '',
        device: 'stub',
        online: true,
        heartbeat_at: Date.now(),
      };
      agents.set(id, agent);
      return sendJson(res, 200, { agent_id: id, agent });
    }

    if (route === 'POST /api/heartbeat') {
      const body = await readBody(req);
      const agent = agents.get(String(body.agent_id || ''));
      if (!agent) return sendJson(res, 404, { error: 'unknown_agent' });
      agent.online = true;
      agent.heartbeat_at = Date.now();
      return sendJson(res, 200, { ok: true });
    }

    if (route === 'POST /api/deregister') {
      const body = await readBody(req);
      const agent = agents.get(String(body.agent_id || ''));
      if (agent) agent.online = false;
      return sendJson(res, 200, { ok: true });
    }

    if (route === 'POST /api/send') {
      const body = await readBody(req);
      const from = findAgent({ team: body.from?.team, name: body.from?.name, agent_id: body.from?.agent_id });
      if (!from) return sendJson(res, 404, { error: 'unknown_sender' });
      const to = findAgent({ team: body.to?.team, name: body.to?.name, agent_id: body.to?.agent_id });
      if (!to) return sendJson(res, 404, { error: 'unknown_recipient' });
      eventId += 1;
      const message = {
        id: randomUUID(),
        event_id: eventId,
        from_agent_id: from.agent_id,
        to_agent_id: to.agent_id,
        from_name: from.name,
        from_team: from.team,
        to_name: to.name,
        to_team: to.team,
        subject: typeof body.subject === 'string' ? body.subject : null,
        body: String(body.body ?? ''),
        need_reply: body.need_reply === true,
        created_at: Date.now(),
      };
      messages.push(message);
      return sendJson(res, 200, { ok: true, message_id: message.id, event_id: message.event_id });
    }

    if (route === 'GET /api/inbox') {
      const team = url.searchParams.get('team');
      const name = url.searchParams.get('name');
      const since = Number(url.searchParams.get('since_event_id') || 0);
      const recipient = findAgent({ team, name });
      if (!recipient) return sendJson(res, 404, { error: 'unknown_recipient' });
      const inbox = messages.filter((message) => message.to_agent_id === recipient.agent_id && message.event_id > since);
      return sendJson(res, 200, { messages: inbox });
    }

    return sendJson(res, 404, { error: 'not_found' });
  } catch (error) {
    return sendJson(res, Number(error?.statusCode) || 400, { error: error?.message || 'stub_error' });
  }
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`${JSON.stringify({ ready: true, port: server.address().port, stub: true })}\n`);
});
process.once('SIGTERM', () => server.close(() => process.exit(0)));
process.once('SIGINT', () => server.close(() => process.exit(0)));

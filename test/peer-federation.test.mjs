import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { startPeerRuntime, callPeerControl } from '../lib/peer-runtime.mjs';
import { mainPeer } from '../lib/peer-cli.mjs';
import { PEER_API_PREFIX, requestPeer } from '../lib/peer-transport.mjs';
import { purgePeerShadows } from '../lib/peer-federation.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function reachableIPv4() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const item of entries || []) {
      const family = typeof item.family === 'string' ? item.family : item.family === 4 ? 'IPv4' : 'IPv6';
      if (family === 'IPv4' && !item.internal && net.isIP(item.address) === 4) return item.address;
    }
  }
  return null;
}

async function waitFor(check, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) { lastError = error; }
    await delay(100);
  }
  throw lastError || new Error('wait_for_timeout');
}

async function startDaemon(_dir, device) {
  const agents = new Map();
  const byIdentity = new Map();
  const inboxes = new Map();
  let eventId = 0;
  const sendJson = (res, status, body) => {
    const raw = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': raw.length });
    res.end(raw);
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, 200, { ok: true });
      if (req.method === 'GET' && url.pathname === '/api/agents/all') return sendJson(res, 200, { agents: [...agents.values()] });
      if (req.method === 'GET' && url.pathname === '/api/agents') return sendJson(res, 200, { agents: [...agents.values()].filter((agent) => agent.team === url.searchParams.get('team')) });
      if (req.method === 'GET' && url.pathname === '/api/inbox') {
        const row = byIdentity.get(`${device}\0${url.searchParams.get('team')}\0${url.searchParams.get('name')}`);
        if (!row) return sendJson(res, 404, { error: 'unknown_owner' });
        const since = Number(url.searchParams.get('since_event_id') || 0);
        const messages = (inboxes.get(row.agent_id) || []).filter((message) => message.event_id > since);
        return sendJson(res, 200, { messages, has_more: false, last_event_id: messages.at(-1)?.event_id || since });
      }
      if (req.method === 'POST') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        if (url.pathname === '/api/register') {
          const team = body.team || 'default';
          const name = body.name;
          const key = `${device}\0${team}\0${name}`;
          const previous = byIdentity.get(key);
          const row = {
            agent_id: previous?.agent_id || randomUUID(), name, team, device,
            role: body.role || 'default', agent_type: body.agent_type || 'custom',
            agent_type_name: body.agent_type_name || '', model: body.model || '', online: true,
            last_seen_at: new Date().toISOString(),
          };
          agents.set(row.agent_id, row);
          byIdentity.set(key, row);
          return sendJson(res, 200, { agent_id: row.agent_id });
        }
        if (url.pathname === '/api/heartbeat') {
          const row = agents.get(body.agent_id);
          if (!row) return sendJson(res, 404, { error: 'unknown_agent' });
          row.last_seen_at = new Date().toISOString();
          row.online = true;
          return sendJson(res, 200, { ok: true });
        }
        if (url.pathname === '/api/deregister') {
          const row = agents.get(body.agent_id);
          if (!row) return sendJson(res, 404, { error: 'unknown_agent' });
          agents.delete(body.agent_id);
          byIdentity.delete(`${device}\0${row.team}\0${row.name}`);
          return sendJson(res, 200, { ok: true });
        }
        if (url.pathname === '/api/send') {
          const sender = byIdentity.get(`${device}\0${body.from?.team}\0${body.from?.name}`);
          const recipient = body.to?.agent_id
            ? agents.get(body.to.agent_id)
            : byIdentity.get(`${device}\0${body.to?.team || body.from?.team}\0${body.to?.name}`);
          if (!sender) return sendJson(res, 404, { error: 'unknown_sender' });
          if (!recipient) return sendJson(res, 404, { error: 'unknown_recipient' });
          const message = {
            id: randomUUID(), event_id: ++eventId,
            from_agent_id: sender.agent_id, from_name: sender.name, from_device: device, from_team: sender.team,
            to_agent_id: recipient.agent_id, to_team: recipient.team,
            subject: body.subject || null, body: body.body, need_reply: body.need_reply === true,
            sent_at: new Date().toISOString(),
          };
          const queue = inboxes.get(recipient.agent_id) || [];
          queue.push(message);
          inboxes.set(recipient.agent_id, queue);
          return sendJson(res, 200, { message_id: message.id, event_id: message.event_id });
        }
      }
      return sendJson(res, 404, { error: 'not_found' });
    } catch (error) { return sendJson(res, 500, { error: error.message }); }
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function daemonRequest(port, method, pathname, body = null) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(3000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `daemon_http_${response.status}`);
  return data;
}

async function getInbox(port, team, name) {
  return daemonRequest(port, 'GET', `/api/inbox?team=${encodeURIComponent(team)}&name=${encodeURIComponent(name)}&since_event_id=0`);
}

async function pair(leftDir, rightDir, left, right, reachableAddress) {
  const leftEndpoint = `https://${reachableAddress}:${left.peerPort}`;
  const rightEndpoint = `https://${reachableAddress}:${right.peerPort}`;
  const invitePath = path.join(rightDir, 'transfer.invite');
  await mainPeer(['invite', '--endpoint', leftEndpoint, '--out', invitePath], { stateDir: leftDir });
  const waiting = mainPeer(['pair', '--invite-file', invitePath, '--endpoint', rightEndpoint, '--label', 'left-instance'], { stateDir: rightDir });
  const pending = await waitFor(async () => {
    const result = await callPeerControl({ stateDir: leftDir, endpoint: '/pending' });
    return result.pending[0] || null;
  });
  await mainPeer(['approve', pending.pendingId, '--label', 'right-instance'], { stateDir: leftDir });
  await waiting;
}

test('CLI invite pairing over a reachable interface enables roster/message federation, reconnect, dedupe, and revocation', async (t) => {
  const reachableAddress = reachableIPv4();
  if (!reachableAddress) return t.skip('no non-loopback IPv4 interface available for direct peer test');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'xats-peer-federation-'));
  const leftDir = path.join(base, 'left');
  const rightDir = path.join(base, 'right');
  fs.mkdirSync(leftDir, { recursive: true });
  fs.mkdirSync(rightDir, { recursive: true });
  const leftDaemon = await startDaemon(path.join(leftDir, 'daemon'), 'left-device');
  const rightDaemon = await startDaemon(path.join(rightDir, 'daemon'), 'right-device');
  let left;
  let right;
  let restartedLeft;
  t.after(async () => {
    await left?.close();
    await restartedLeft?.close();
    await right?.close();
    await leftDaemon.close();
    await rightDaemon.close();
    fs.rmSync(base, { recursive: true, force: true });
  });

  const alice = await daemonRequest(leftDaemon.port, 'POST', '/api/register', { name: 'alice', team: 'default', role: 'worker', agent_type: 'custom' });
  const bob = await daemonRequest(rightDaemon.port, 'POST', '/api/register', { name: 'bob', team: 'default', role: 'worker', agent_type: 'custom' });
  const charlie = await daemonRequest(rightDaemon.port, 'POST', '/api/register', { name: 'charlie', team: 'project-x', role: 'worker', agent_type: 'custom' });
  const leftPeerDir = path.join(leftDir, 'peer');
  const rightPeerDir = path.join(rightDir, 'peer');
  left = await startPeerRuntime({ stateDir: leftPeerDir, host: '::', port: 0, mdns: false, daemonPort: leftDaemon.port, onLog() {} });
  right = await startPeerRuntime({ stateDir: rightPeerDir, host: '::', port: 0, mdns: false, daemonPort: rightDaemon.port, onLog() {} });
  const originalLeftPort = left.peerPort;
  const leftDeviceId = left.identity.deviceId;
  await pair(leftPeerDir, rightPeerDir, left, right, reachableAddress);

  const shadowOnLeft = await waitFor(async () => {
    await left.federation.syncOnce();
    const roster = await daemonRequest(leftDaemon.port, 'GET', '/api/agents/all');
    return roster.agents.find((agent) => agent.agent_type_name === 'xats-peer-shadow' && agent.name.endsWith('_bob')) || null;
  });
  const shadowOnRight = await waitFor(async () => {
    await right.federation.syncOnce();
    const roster = await daemonRequest(rightDaemon.port, 'GET', '/api/agents/all');
    return roster.agents.find((agent) => agent.agent_type_name === 'xats-peer-shadow' && agent.name.endsWith('_alice')) || null;
  });
  assert.equal(shadowOnLeft.online, true);
  assert.equal(shadowOnRight.online, true);
  const crossTeamShadow = await waitFor(async () => {
    const roster = await daemonRequest(leftDaemon.port, 'GET', '/api/agents/all');
    return roster.agents.find((agent) => agent.team === 'project-x' && agent.name.endsWith('_charlie')) || null;
  });
  assert.equal(crossTeamShadow.online, true);

  const rosterResponse = await requestPeer({
    peer: left.trustStore.get(right.identity.deviceId),
    identity: left.identity,
    method: 'GET',
    path: `${PEER_API_PREFIX}/agents/roster`,
  });
  assert.equal(rosterResponse.status, 200);
  assert.equal(rosterResponse.body.instance_id, right.identity.deviceId);
  assert.ok(rosterResponse.body.agents.some((agent) => agent.name === 'bob' && agent.agent_id === bob.agent_id));
  assert.ok(rosterResponse.body.agents.some((agent) => agent.name === 'charlie' && agent.team === 'project-x' && agent.agent_id === charlie.agent_id));

  await daemonRequest(leftDaemon.port, 'POST', '/api/send', {
    from: { team: 'default', name: 'alice' },
    to: { team: 'default', name: shadowOnLeft.name },
    subject: 'federation test',
    body: 'hello from alice',
  });
  const firstDelivery = await waitFor(async () => {
    await left.federation.syncOnce();
    await right.federation.syncOnce();
    const inbox = await getInbox(rightDaemon.port, 'default', 'bob');
    return inbox.messages.find((message) => message.body === 'hello from alice') || null;
  });
  assert.equal(firstDelivery.body, 'hello from alice');
  assert.match(firstDelivery.from_name, /^xpeer_/);

  const duplicatePayload = {
    message_id: `${left.identity.deviceId}:dedupe-case-001`,
    origin_device_id: left.identity.deviceId,
    origin_message_id: 'dedupe-case-001',
    from_agent_id: alice.agent_id,
    from_name: 'alice',
    from_team: 'default',
    from_device: 'left-device',
    to_agent_id: bob.agent_id,
    to_name: 'bob',
    to_team: 'default',
    to_device_id: right.identity.deviceId,
    subject: 'duplicate test',
    body: 'exactly once',
    need_reply: false,
    hops: 0,
  };
  const peerAtLeft = left.trustStore.get(right.identity.deviceId);
  const firstDuplicateAttempt = await requestPeer({ peer: peerAtLeft, identity: left.identity, method: 'POST', path: `${PEER_API_PREFIX}/messages/deliver`, body: duplicatePayload, nonce: 'd'.repeat(32) });
  const replayAttempt = await requestPeer({ peer: peerAtLeft, identity: left.identity, method: 'POST', path: `${PEER_API_PREFIX}/messages/deliver`, body: duplicatePayload, nonce: 'd'.repeat(32) });
  const duplicateAttempt = await requestPeer({ peer: peerAtLeft, identity: left.identity, method: 'POST', path: `${PEER_API_PREFIX}/messages/deliver`, body: duplicatePayload });
  assert.equal(firstDuplicateAttempt.status, 200);
  assert.equal(firstDuplicateAttempt.body.ok, true);
  assert.equal(replayAttempt.status, 409, 'same signed request nonce is rejected as a replay');
  assert.equal(duplicateAttempt.status, 200);
  assert.equal(duplicateAttempt.body.duplicate, true, 'new request nonce cannot redeliver the same origin message');
  const bobMessages = (await getInbox(rightDaemon.port, 'default', 'bob')).messages;
  assert.equal(bobMessages.filter((message) => message.body === 'exactly once').length, 1);

  await daemonRequest(rightDaemon.port, 'POST', '/api/send', {
    from: { team: 'default', name: 'bob' },
    to: { team: 'default', name: shadowOnRight.name },
    subject: 'reply',
    body: 'hello from bob',
  });
  const reply = await waitFor(async () => {
    await right.federation.syncOnce();
    await left.federation.syncOnce();
    const inbox = await getInbox(leftDaemon.port, 'default', 'alice');
    return inbox.messages.find((message) => message.body === 'hello from bob') || null;
  });
  assert.equal(reply.body, 'hello from bob');

  await left.close();
  left = null;
  await daemonRequest(rightDaemon.port, 'POST', '/api/send', {
    from: { team: 'default', name: 'bob' },
    to: { team: 'default', name: shadowOnRight.name },
    subject: 'reconnect',
    body: 'queued while disconnected',
  });
  await right.federation.syncOnce();
  assert.equal(right.federation.status().peers.find((peer) => peer.deviceId === leftDeviceId)?.connected, false);

  restartedLeft = await startPeerRuntime({ stateDir: leftPeerDir, host: '::', port: originalLeftPort, mdns: false, daemonPort: leftDaemon.port, onLog() {} });
  const queued = await waitFor(async () => {
    await right.federation.syncOnce();
    await restartedLeft.federation.syncOnce();
    const inbox = await getInbox(leftDaemon.port, 'default', 'alice');
    return inbox.messages.find((message) => message.body === 'queued while disconnected') || null;
  });
  assert.equal(queued.body, 'queued while disconnected');
  assert.equal(right.federation.status().peers.find((peer) => peer.deviceId === restartedLeft.identity.deviceId)?.connected, true);

  const leftRecordAtRight = right.trustStore.get(restartedLeft.identity.deviceId);
  assert.ok(leftRecordAtRight);
  await callPeerControl({ stateDir: rightPeerDir, method: 'POST', endpoint: '/revoke', body: { deviceId: restartedLeft.identity.deviceId } });
  const afterRevoke = await requestPeer({ peer: restartedLeft.trustStore.get(right.identity.deviceId), identity: restartedLeft.identity, method: 'GET', path: `${PEER_API_PREFIX}/agents/roster` });
  assert.equal(afterRevoke.status, 403);
  assert.equal(right.trustStore.get(restartedLeft.identity.deviceId), null);
  const rightRosterAfterRevoke = await daemonRequest(rightDaemon.port, 'GET', '/api/agents/all');
  assert.equal(rightRosterAfterRevoke.agents.some((agent) => agent.agent_type_name === 'xats-peer-shadow' && agent.name.endsWith('_alice')), false);
  const removedShadows = await purgePeerShadows({ daemonPort: leftDaemon.port });
  assert.ok(removedShadows >= 1, 'reset cleanup removes remaining peer shadow agents from the local daemon');
});

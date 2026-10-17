import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { PEER_API_PREFIX, requestPeer } from './peer-transport.mjs';

const MAX_ROSTER_AGENTS = 1000;
const MAX_REMOTE_MESSAGE_BYTES = 512 * 1024;
const MAX_LEDGER_ITEMS = 20_000;
const LEDGER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SHADOW_TYPE = 'xats-peer-shadow';
const SYNC_INTERVAL_MS = 5_000;
const LOCAL_REQUEST_TIMEOUT_MS = 8_000;

function parseJson(text) {
  try { return text ? JSON.parse(text) : {}; }
  catch { throw new Error('daemon_invalid_json'); }
}

function atomicWrite(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch { /* best effort */ }
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

function localRequest({ port, token, method, pathname, body, timeoutMs = LOCAL_REQUEST_TIMEOUT_MS }) {
  const raw = body == null ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: pathname,
      timeout: timeoutMs,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(raw ? { 'content-type': 'application/json', 'content-length': raw.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      let length = 0;
      res.on('data', (chunk) => {
        length += chunk.length;
        if (length > 2 * 1024 * 1024) {
          req.destroy(new Error('daemon_response_too_large'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        try {
          const data = parseJson(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(Object.assign(new Error(data.error || `daemon_http_${res.statusCode}`), { statusCode: res.statusCode }));
          } else resolve(data);
        } catch (error) { reject(error); }
      });
    });
    req.once('timeout', () => req.destroy(new Error('daemon_request_timeout')));
    req.once('error', reject);
    if (raw) req.write(raw);
    req.end();
  });
}

function safeRosterAgent(agent) {
  if (!agent || typeof agent !== 'object') return null;
  const strings = ['agent_id', 'name', 'team'];
  if (strings.some((key) => typeof agent[key] !== 'string' || !agent[key] || agent[key].length > 512)) return null;
  if (agent.name.includes(':') || agent.name.includes('(') || agent.name.includes(')') || agent.team.includes('(') || agent.team.includes(')')) return null;
  return {
    agent_id: agent.agent_id,
    name: agent.name,
    team: agent.team,
    device: typeof agent.device === 'string' ? agent.device.slice(0, 64) : '',
    role: typeof agent.role === 'string' ? agent.role.slice(0, 128) : 'default',
    agent_type: typeof agent.agent_type === 'string' ? agent.agent_type.slice(0, 64) : 'custom',
    agent_type_name: typeof agent.agent_type_name === 'string' ? agent.agent_type_name.slice(0, 128) : '',
    model: typeof agent.model === 'string' ? agent.model.slice(0, 256) : '',
    online: agent.online === true,
  };
}

function isShadow(agent) {
  return agent?.agent_type_name === SHADOW_TYPE || agent?.role === '__peer_shadow__' || agent?.role === '__channel_proxy__';
}

function shadowAgentName(peerDeviceId, remoteAgentId, remoteName) {
  return `xpeer_${peerDeviceId}_${remoteAgentId}_${remoteName}`;
}

function peerAgentKey(peerDeviceId, agentId) {
  return `${peerDeviceId}:${agentId}`;
}

function validMessageString(value, maxBytes, { allowEmpty = false } = {}) {
  return typeof value === 'string' && (allowEmpty || value.length > 0) && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

class PeerMessageLedger {
  constructor(filePath, now = () => Date.now()) {
    this.filePath = filePath;
    this.now = now;
    this.cursors = new Map();
    this.delivered = new Map();
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (data?.version !== 1 || !Array.isArray(data.delivered) || !data.cursors || typeof data.cursors !== 'object') throw new Error('invalid_peer_message_ledger');
      for (const [key, value] of Object.entries(data.cursors)) {
        if (typeof key === 'string' && Number.isSafeInteger(value) && value >= 0) this.cursors.set(key, value);
      }
      for (const entry of data.delivered) {
        if (entry && typeof entry.key === 'string' && Number.isSafeInteger(entry.at)) this.delivered.set(entry.key, entry.at);
      }
      try { fs.chmodSync(filePath, 0o600); } catch { /* best effort */ }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    this.prune();
  }

  cursor(peerDeviceId, shadowId) {
    return this.cursors.get(`${peerDeviceId}:${shadowId}`) || 0;
  }

  setCursor(peerDeviceId, shadowId, eventId) {
    if (!Number.isSafeInteger(eventId) || eventId < 0) throw new Error('invalid_event_cursor');
    this.cursors.set(`${peerDeviceId}:${shadowId}`, eventId);
    this.save();
  }

  hasDelivered(peerDeviceId, messageId) {
    return this.delivered.has(`${peerDeviceId}:${messageId}`);
  }

  markDelivered(peerDeviceId, messageId) {
    this.delivered.set(`${peerDeviceId}:${messageId}`, this.now());
    this.prune();
    this.save();
  }

  prune() {
    const cutoff = this.now() - LEDGER_TTL_MS;
    for (const [key, at] of this.delivered) if (at < cutoff) this.delivered.delete(key);
    while (this.delivered.size > MAX_LEDGER_ITEMS) this.delivered.delete(this.delivered.keys().next().value);
  }

  save() {
    const cursors = Object.fromEntries(this.cursors);
    const delivered = [...this.delivered].map(([key, at]) => ({ key, at }));
    atomicWrite(this.filePath, { version: 1, cursors, delivered });
  }
}

export class PeerFederation {
  constructor({ identity, trustStore, stateDir, daemonPort = 9100, daemonToken = process.env.CROSS_AGENT_TEAMS_MCP_TOKEN, onLog = () => {}, syncIntervalMs = SYNC_INTERVAL_MS } = {}) {
    if (!identity || !trustStore || !stateDir) throw new TypeError('peer_federation_configuration_required');
    if (!Number.isInteger(daemonPort) || daemonPort < 1 || daemonPort > 65535) throw new TypeError('invalid_daemon_port');
    this.identity = identity;
    this.trustStore = trustStore;
    this.stateDir = stateDir;
    this.daemonPort = daemonPort;
    this.daemonToken = daemonToken || null;
    this.onLog = onLog;
    this.syncIntervalMs = syncIntervalMs;
    this.ledger = new PeerMessageLedger(path.join(stateDir, 'messages.json'));
    this.remoteAgents = new Map();
    this.shadows = new Map();
    this.peerStates = new Map();
    this.timer = null;
    this.syncing = false;
    this.closed = false;
    this.daemonAvailable = false;
  }

  async localAgents() {
    const result = await localRequest({ port: this.daemonPort, token: this.daemonToken, method: 'GET', pathname: '/api/agents/all' });
    if (!Array.isArray(result.agents) || result.agents.length > MAX_ROSTER_AGENTS * 4) throw new Error('invalid_local_roster');
    return result.agents.map(safeRosterAgent).filter(Boolean);
  }

  async getPublicRoster() {
    const agents = await this.localAgents();
    this.daemonAvailable = true;
    const reachable = agents.filter((agent) => agent.online && !isShadow(agent));
    if (reachable.length > MAX_ROSTER_AGENTS) throw new Error('local_roster_too_large');
    return {
      instance_id: this.identity.deviceId,
      agents: reachable,
      updated_at: Date.now(),
    };
  }

  async deliverMessage(message, authenticatedPeer) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return { ok: false, error: 'invalid_message' };
    const peerDeviceId = authenticatedPeer?.deviceId;
    if (!/^[a-f0-9]{32}$/.test(peerDeviceId || '') || message.origin_device_id !== peerDeviceId) return { ok: false, error: 'origin_peer_mismatch' };
    if (message.to_device_id !== this.identity.deviceId || !Number.isInteger(message.hops) || message.hops !== 0) return { ok: false, error: 'invalid_route' };
    if (!validMessageString(message.origin_message_id, 256) || message.message_id !== `${peerDeviceId}:${message.origin_message_id}`) return { ok: false, error: 'invalid_message_id' };
    if (!validMessageString(message.from_agent_id, 128) || !validMessageString(message.to_agent_id, 128)) return { ok: false, error: 'invalid_agent_id' };
    if (!validMessageString(message.from_name, 512) || !validMessageString(message.from_team, 512) || !validMessageString(message.to_name, 512) || !validMessageString(message.to_team, 512)) return { ok: false, error: 'invalid_message_address' };
    if (!validMessageString(message.body, MAX_REMOTE_MESSAGE_BYTES) || (message.subject != null && !validMessageString(message.subject, 2048, { allowEmpty: true }))) return { ok: false, error: 'invalid_message_content' };
    const dedupeKey = message.message_id;
    if (this.ledger.hasDelivered(peerDeviceId, dedupeKey)) return { ok: true, duplicate: true };

    const remoteSender = this.remoteAgents.get(peerAgentKey(peerDeviceId, message.from_agent_id));
    if (!remoteSender || remoteSender.agent.name !== message.from_name || remoteSender.agent.team !== message.from_team) return { ok: false, error: 'unknown_remote_sender' };
    const agents = await this.localAgents();
    this.daemonAvailable = true;
    const target = agents.find((agent) => agent.agent_id === message.to_agent_id && agent.name === message.to_name && agent.team === message.to_team && !isShadow(agent));
    if (!target) return { ok: false, error: 'unknown_local_recipient' };
    try {
      const result = await localRequest({
        port: this.daemonPort,
        token: this.daemonToken,
        method: 'POST',
        pathname: '/api/send',
        body: {
          from: { team: remoteSender.shadow.team, name: remoteSender.shadow.name },
          to: { agent_id: target.agent_id },
          ...(typeof message.subject === 'string' ? { subject: message.subject } : {}),
          body: message.body,
          need_reply: message.need_reply === true,
        },
      });
      this.ledger.markDelivered(peerDeviceId, dedupeKey);
      return { ok: true, local_message_id: result.message_id || null };
    } catch (error) {
      return { ok: false, error: error.message || 'local_delivery_failed' };
    }
  }

  async refreshPeer(peer) {
    if (!this.trustStore.get(peer.deviceId)) throw new Error('peer_revoked');
    const remote = await requestPeer({
      peer,
      identity: this.identity,
      method: 'GET',
      path: `${PEER_API_PREFIX}/agents/roster`,
    });
    const data = remote.body;
    if (remote.status !== 200 || data?.instance_id !== peer.deviceId || !Array.isArray(data.agents) || data.agents.length > MAX_ROSTER_AGENTS) throw new Error('invalid_remote_roster');
    const newRemote = new Map();
    const localRoster = await this.localAgents();
    for (const raw of data.agents) {
      const agent = safeRosterAgent(raw);
      if (!agent || !agent.online || isShadow(agent)) continue;
      const key = peerAgentKey(peer.deviceId, agent.agent_id);
      if (newRemote.has(key)) throw new Error('duplicate_remote_agent_id');
      newRemote.set(key, { agent, peerDeviceId: peer.deviceId });
    }

    const now = Date.now();
    for (const [key, prior] of this.remoteAgents) if (prior.peerDeviceId === peer.deviceId && !newRemote.has(key)) this.remoteAgents.delete(key);
    for (const [key, item] of newRemote) {
      const shadow = await this.ensureShadow(peer, item.agent, localRoster);
      item.shadow = shadow;
      item.lastSeenAt = now;
      this.remoteAgents.set(key, item);
    }
    this.peerStates.set(peer.deviceId, {
      ...(this.peerStates.get(peer.deviceId) || {}),
      deviceId: peer.deviceId,
      label: peer.label || null,
      endpoint: peer.endpoint,
      connected: true,
      lastSuccessAt: now,
      remoteAgentCount: newRemote.size,
      lastError: null,
    });
    return newRemote.size;
  }

  async ensureShadow(peer, remoteAgent, localRoster = []) {
    const key = peerAgentKey(peer.deviceId, remoteAgent.agent_id);
    const baseName = shadowAgentName(peer.deviceId, remoteAgent.agent_id, remoteAgent.name);
    let shadowName = baseName;
    let suffix = 0;
    while (localRoster.some((agent) => agent.team === remoteAgent.team && agent.name === shadowName && !isShadow(agent))) {
      shadowName = `${baseName}_peer${++suffix}`;
    }
    const existing = this.shadows.get(key);
    if (existing && existing.name === shadowName && existing.team === remoteAgent.team) {
      if (Date.now() - existing.lastHeartbeatAt > 20_000) {
        await localRequest({ port: this.daemonPort, token: this.daemonToken, method: 'POST', pathname: '/api/heartbeat', body: { agent_id: existing.agent_id } });
        existing.lastHeartbeatAt = Date.now();
      }
      return existing;
    }
    const result = await localRequest({
      port: this.daemonPort,
      token: this.daemonToken,
      method: 'POST',
      pathname: '/api/register',
      body: {
        name: shadowName,
        team: remoteAgent.team,
        role: '__peer_shadow__',
        agent_type: 'custom',
        agent_type_name: SHADOW_TYPE,
        model: remoteAgent.model || undefined,
      },
    });
    if (typeof result.agent_id !== 'string') throw new Error('shadow_registration_failed');
    const shadow = { agent_id: result.agent_id, name: shadowName, team: remoteAgent.team, peerDeviceId: peer.deviceId, remoteAgentId: remoteAgent.agent_id, lastHeartbeatAt: Date.now() };
    localRoster.push({ agent_id: shadow.agent_id, name: shadow.name, team: shadow.team, role: '__peer_shadow__', agent_type_name: SHADOW_TYPE });
    this.shadows.set(key, shadow);
    return shadow;
  }

  async forwardOutbox(peer) {
    if (!this.trustStore.get(peer.deviceId)) return 0;
    const remoteForPeer = [...this.remoteAgents.values()].filter((entry) => entry.peerDeviceId === peer.deviceId);
    if (!remoteForPeer.length) return 0;
    const local = await this.localAgents();
    const localById = new Map(local.map((agent) => [agent.agent_id, agent]));
    let sent = 0;
    for (const remote of remoteForPeer) {
      const shadow = remote.shadow;
      const cursor = this.ledger.cursor(peer.deviceId, shadow.agent_id);
      const query = new URLSearchParams({ team: shadow.team, name: shadow.name, since_event_id: String(cursor) });
      const inbox = await localRequest({ port: this.daemonPort, token: this.daemonToken, method: 'GET', pathname: `/api/inbox?${query}` });
      if (!Array.isArray(inbox.messages)) throw new Error('invalid_shadow_inbox');
      for (const message of inbox.messages) {
        const eventId = Number(message.event_id);
        if (!Number.isSafeInteger(eventId) || eventId < 0) continue;
        const source = localById.get(message.from_agent_id);
        if (!source || isShadow(source)) {
          this.ledger.setCursor(peer.deviceId, shadow.agent_id, eventId);
          continue;
        }
        const originMessageId = String(message.id || `${shadow.agent_id}:${eventId}`);
        const payload = {
          message_id: `${this.identity.deviceId}:${originMessageId}`,
          origin_device_id: this.identity.deviceId,
          origin_message_id: originMessageId,
          from_agent_id: source.agent_id,
          from_name: source.name,
          from_team: source.team,
          from_device: source.device,
          to_agent_id: remote.agent.agent_id,
          to_name: remote.agent.name,
          to_team: remote.agent.team,
          to_device_id: peer.deviceId,
          subject: typeof message.subject === 'string' ? message.subject : null,
          body: message.body,
          need_reply: message.need_reply === true,
          hops: 0,
        };
        try {
          if (!this.trustStore.get(peer.deviceId)) return sent;
          const response = await requestPeer({
            peer,
            identity: this.identity,
            method: 'POST',
            path: `${PEER_API_PREFIX}/messages/deliver`,
            body: payload,
          });
          if (response.status < 200 || response.status >= 300 || response.body?.ok !== true) throw new Error(response.body?.error || `peer_delivery_http_${response.status}`);
          this.ledger.setCursor(peer.deviceId, shadow.agent_id, eventId);
          sent++;
        } catch (error) {
          const state = this.peerStates.get(peer.deviceId) || { deviceId: peer.deviceId, endpoint: peer.endpoint, label: peer.label || null };
          this.peerStates.set(peer.deviceId, { ...state, lastError: error.message || 'delivery_failed' });
          return sent;
        }
      }
    }
    return sent;
  }

  async syncOnce() {
    if (this.syncing || this.closed) return;
    this.syncing = true;
    try {
      try {
        await this.localAgents();
        this.daemonAvailable = true;
      } catch (error) {
        const wasAvailable = this.daemonAvailable;
        this.daemonAvailable = false;
        if (wasAvailable || !this.localDaemonError) this.onLog(`local daemon unavailable for peer federation: ${error.message}`);
        this.localDaemonError = error.message;
        return;
      }
      for (const peer of this.trustStore.list()) {
        try {
          await this.refreshPeer(peer);
          await this.forwardOutbox(peer);
        } catch (error) {
          const prior = this.peerStates.get(peer.deviceId) || { deviceId: peer.deviceId, label: peer.label || null, endpoint: peer.endpoint };
          this.peerStates.set(peer.deviceId, { ...prior, connected: false, lastError: error.message || 'peer_unavailable' });
          if (prior.connected !== false || prior.lastError !== (error.message || 'peer_unavailable')) this.onLog(`peer ${peer.deviceId} unavailable: ${error.message}`);
        }
      }
    } finally {
      this.syncing = false;
    }
  }

  start() {
    if (this.timer || this.closed) return;
    void this.syncOnce();
    this.timer = setInterval(() => void this.syncOnce(), this.syncIntervalMs);
    this.timer.unref?.();
  }

  async forgetPeer(deviceId) {
    this.peerStates.delete(deviceId);
    for (const [key, value] of this.remoteAgents) if (value.peerDeviceId === deviceId) this.remoteAgents.delete(key);
    const ids = new Map();
    for (const [key, shadow] of this.shadows) {
      if (shadow.peerDeviceId !== deviceId) continue;
      ids.set(shadow.agent_id, shadow.name);
      this.shadows.delete(key);
    }
    try {
      const local = await this.localAgents();
      for (const agent of local) {
        if (agent.agent_type_name === SHADOW_TYPE && agent.name.startsWith(`xpeer_${deviceId}_`)) ids.set(agent.agent_id, agent.name);
      }
    } catch { /* local daemon may be stopped; authorization is already revoked */ }
    for (const [agentId, name] of ids) {
      try {
        await localRequest({ port: this.daemonPort, token: this.daemonToken, method: 'POST', pathname: '/api/deregister', body: { agent_id: agentId } });
      } catch (error) { this.onLog(`could not remove revoked peer shadow ${name}: ${error.message}`); }
    }
  }

  status() {
    return {
      daemonAvailable: this.daemonAvailable,
      peers: [...this.peerStates.values()].map((peer) => ({ ...peer })),
      remoteAgentCount: this.remoteAgents.size,
    };
  }

  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export async function purgePeerShadows({ daemonPort = 9100, daemonToken = process.env.CROSS_AGENT_TEAMS_MCP_TOKEN } = {}) {
  if (!Number.isInteger(daemonPort) || daemonPort < 1 || daemonPort > 65535) throw new TypeError('invalid_daemon_port');
  const result = await localRequest({ port: daemonPort, token: daemonToken || null, method: 'GET', pathname: '/api/agents/all' });
  if (!Array.isArray(result.agents) || result.agents.length > MAX_ROSTER_AGENTS * 4) throw new Error('invalid_local_roster');
  const shadows = result.agents.filter((agent) => agent?.agent_type_name === SHADOW_TYPE && typeof agent.agent_id === 'string');
  for (const shadow of shadows) {
    await localRequest({ port: daemonPort, token: daemonToken || null, method: 'POST', pathname: '/api/deregister', body: { agent_id: shadow.agent_id } });
  }
  return shadows.length;
}

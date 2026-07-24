#!/usr/bin/env node

// src/cli.ts
import { existsSync as existsSync2, readFileSync as readFileSync2, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// src/daemon/server.ts
import Fastify from "fastify";
import { createServer as createHttpServer } from "node:http";

// src/storage/db.ts
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
function openDb(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  return db;
}

// src/storage/schema.ts
var DDL = [
  `CREATE TABLE IF NOT EXISTS events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_team TEXT NOT NULL,
    to_team TEXT NOT NULL,
    event_type TEXT NOT NULL,
    actor_agent_id TEXT,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_events_from_team_eventid ON events(from_team, event_id)`,
  `CREATE INDEX IF NOT EXISTS idx_events_to_team_eventid ON events(to_team, event_id)`,
  `CREATE TABLE IF NOT EXISTS agents (
    agent_id TEXT PRIMARY KEY,
    agent_type TEXT,
    agent_type_name TEXT,
    device TEXT NOT NULL,
    team TEXT NOT NULL,
    role TEXT NOT NULL,
    name TEXT NOT NULL,
    model TEXT,
    registered_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    last_processed_event_id INTEGER NOT NULL DEFAULT 0,
    tmux_pane_id TEXT,
    claude_ui_pid INTEGER,
    runtime_ui_pid INTEGER,
    runtime_tty TEXT,
    runtime_verification_mode TEXT,
    runtime_bound_at TEXT,
    channel_session_id TEXT,
    delivery_kind TEXT NOT NULL DEFAULT 'none',
    delivery_payload TEXT,
    remote_addr TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS agents_identity_idx ON agents(device, team, name)`,
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events(event_id),
    from_team TEXT NOT NULL,
    to_team TEXT NOT NULL,
    from_agent_id TEXT NOT NULL,
    to_agent_id TEXT,
    to_role TEXT,
    subject TEXT,
    body TEXT NOT NULL,
    need_reply INTEGER NOT NULL DEFAULT 1,
    sent_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS message_delivery_status (
    message_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    wake_status TEXT NOT NULL CHECK(wake_status IN ('delivered','retrying','skipped','failed')),
    skip_reason TEXT,
    retry_attempts INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    delivered_at TEXT,
    PRIMARY KEY (message_id, agent_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_message_delivery_status_message ON message_delivery_status(message_id)`,
  `CREATE TABLE IF NOT EXISTS codex_pane_pre_registrations (
    pane_id TEXT PRIMARY KEY,
    xats_agent_id TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`
];
function migrateAgentsDeliveryColumns(db) {
  const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='agents'`).get();
  if (!tableExists) return;
  const cols = db.pragma("table_info(agents)");
  const existing = new Set(cols.map((c) => c.name));
  const renameClient = existing.has("client") && !existing.has("agent_type");
  const renameClientName = existing.has("client_name") && !existing.has("agent_type_name");
  if (renameClient || renameClientName) {
    const renameTx = db.transaction(() => {
      if (renameClient) {
        db.exec(`ALTER TABLE agents RENAME COLUMN client TO agent_type`);
      }
      if (renameClientName) {
        db.exec(`ALTER TABLE agents RENAME COLUMN client_name TO agent_type_name`);
      }
    });
    renameTx();
    const colsAfter = db.pragma("table_info(agents)");
    existing.clear();
    for (const c of colsAfter) existing.add(c.name);
  }
  const needAgentType = !existing.has("agent_type");
  const needAgentTypeName = !existing.has("agent_type_name");
  const needKind = !existing.has("delivery_kind");
  const needPayload = !existing.has("delivery_payload");
  const needRuntimeUiPid = !existing.has("runtime_ui_pid");
  const needRuntimeTty = !existing.has("runtime_tty");
  const needRuntimeVerificationMode = !existing.has("runtime_verification_mode");
  const needRuntimeBoundAt = !existing.has("runtime_bound_at");
  const needClaudeUiPid = !existing.has("claude_ui_pid");
  if (!needAgentType && !needAgentTypeName && !needKind && !needPayload && !needRuntimeUiPid && !needRuntimeTty && !needRuntimeVerificationMode && !needRuntimeBoundAt && !needClaudeUiPid) return;
  const tx = db.transaction(() => {
    if (needAgentType) {
      db.exec(`ALTER TABLE agents ADD COLUMN agent_type TEXT`);
    }
    if (needAgentTypeName) {
      db.exec(`ALTER TABLE agents ADD COLUMN agent_type_name TEXT`);
    }
    if (needKind) {
      db.exec(`ALTER TABLE agents ADD COLUMN delivery_kind TEXT NOT NULL DEFAULT 'none'`);
    }
    if (needPayload) {
      db.exec(`ALTER TABLE agents ADD COLUMN delivery_payload TEXT`);
    }
    if (needRuntimeUiPid) {
      db.exec(`ALTER TABLE agents ADD COLUMN runtime_ui_pid INTEGER`);
    }
    if (needRuntimeTty) {
      db.exec(`ALTER TABLE agents ADD COLUMN runtime_tty TEXT`);
    }
    if (needRuntimeVerificationMode) {
      db.exec(`ALTER TABLE agents ADD COLUMN runtime_verification_mode TEXT`);
    }
    if (needRuntimeBoundAt) {
      db.exec(`ALTER TABLE agents ADD COLUMN runtime_bound_at TEXT`);
    }
    if (needClaudeUiPid) {
      db.exec(`ALTER TABLE agents ADD COLUMN claude_ui_pid INTEGER`);
    }
    if (needKind || needPayload) {
      db.exec(`UPDATE agents
        SET delivery_kind = 'claude-channel',
            delivery_payload = json_object('channel_session_id', channel_session_id)
        WHERE channel_session_id IS NOT NULL AND delivery_kind = 'none'`);
    }
  });
  tx();
}
function hasDeviceIdentityIndex(db) {
  const indexes = db.pragma("index_list(agents)");
  const found = indexes.find((index) => index.name === "agents_identity_idx");
  if (!found) return false;
  const info = db.pragma("index_info(agents_identity_idx)");
  const ordered = info.sort((a, b) => a.seqno - b.seqno).map((row) => row.name);
  return ordered.length === 3 && ordered[0] === "device" && ordered[1] === "team" && ordered[2] === "name";
}
function migrateAgentsDeviceColumns(db, localDevice) {
  const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='agents'`).get();
  if (!tableExists) return;
  const cols = db.pragma("table_info(agents)");
  const existing = new Set(cols.map((c) => c.name));
  const needDevice = !existing.has("device");
  const needRemoteAddr = !existing.has("remote_addr");
  const needIdentityIndex = !hasDeviceIdentityIndex(db);
  if (!needDevice && !needRemoteAddr && !needIdentityIndex) return;
  const tx = db.transaction(() => {
    if (needDevice) {
      const badRow = db.prepare(
        `SELECT team, name
         FROM agents
         WHERE instr(name, ':') > 0
         ORDER BY rowid ASC
         LIMIT 1`
      ).get();
      if (badRow) {
        throw new Error(
          `device migration blocked: offending row (${badRow.team}, ${badRow.name}) contains ':'`
        );
      }
      db.exec(`ALTER TABLE agents ADD COLUMN device TEXT`);
    }
    if (needRemoteAddr) {
      db.exec(`ALTER TABLE agents ADD COLUMN remote_addr TEXT`);
    }
    if (needDevice) {
      db.prepare(`UPDATE agents SET device = ? WHERE device IS NULL`).run(localDevice);
    }
    if (needIdentityIndex) {
      db.exec(`DROP INDEX IF EXISTS agents_identity_idx`);
      db.exec(`CREATE UNIQUE INDEX agents_identity_idx ON agents(device, team, name)`);
    }
  });
  tx();
}
function migrateMessagesNeedReplyColumn(db) {
  const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='messages'`).get();
  if (!tableExists) return;
  const cols = db.pragma("table_info(messages)");
  const existing = new Set(cols.map((c) => c.name));
  if (existing.has("need_reply")) return;
  db.exec(`ALTER TABLE messages ADD COLUMN need_reply INTEGER NOT NULL DEFAULT 1`);
}
function migrateAgentsCursorWatermark(db) {
  db.exec(
    `UPDATE agents
        SET last_processed_event_id = COALESCE((SELECT MAX(event_id) FROM events), 0)
      WHERE last_processed_event_id = 0`
  );
}
function dropLegacyTaskContractTables(db) {
  db.exec(`DROP TABLE IF EXISTS tasks`);
  db.exec(`DROP TABLE IF EXISTS contracts`);
  db.exec(`DROP TABLE IF EXISTS contract_subscriptions`);
}
function applySchema(db, opts = {}) {
  for (const sql of DDL) db.exec(sql);
  dropLegacyTaskContractTables(db);
  migrateAgentsDeliveryColumns(db);
  migrateAgentsDeviceColumns(db, opts.localDevice ?? "local");
  migrateMessagesNeedReplyColumn(db);
  migrateAgentsCursorWatermark(db);
}

// src/storage/agents-repo.ts
import { randomUUID } from "node:crypto";

// src/lib/delivery-spec.ts
var DELIVERY_KINDS = [
  "none",
  "claude-channel",
  "codex-appserver",
  "opencode-server",
  "claude-job"
];
function parseDeliveryRow(row) {
  const kind = row.delivery_kind;
  if (kind === "none") {
    return { kind: "none" };
  }
  if (!DELIVERY_KINDS.includes(kind)) {
    throw new Error("corrupt_delivery_payload");
  }
  let payload;
  try {
    payload = row.delivery_payload == null ? {} : JSON.parse(row.delivery_payload);
  } catch {
    throw new Error("corrupt_delivery_payload");
  }
  if (typeof payload !== "object" || payload === null) {
    throw new Error("corrupt_delivery_payload");
  }
  const record = payload;
  if (kind === "claude-channel") {
    const csid = record.channel_session_id;
    if (typeof csid !== "string" || csid.length === 0) {
      throw new Error("corrupt_delivery_payload");
    }
    return { kind: "claude-channel", channel_session_id: csid };
  }
  if (kind === "codex-appserver") {
    const threadId = record.thread_id;
    if (typeof threadId !== "string" || threadId.length === 0) {
      throw new Error("corrupt_delivery_payload");
    }
    const wsUrl = record.ws_url;
    if (typeof wsUrl !== "string" || wsUrl.length === 0) {
      throw new Error("corrupt_delivery_payload");
    }
    const hasAuthTokenRef = Object.prototype.hasOwnProperty.call(record, "auth_token_ref");
    if (hasAuthTokenRef) {
      const authTokenRef = record.auth_token_ref;
      if (typeof authTokenRef !== "string" || authTokenRef.length === 0) {
        throw new Error("corrupt_delivery_payload");
      }
      return {
        kind: "codex-appserver",
        thread_id: threadId,
        ws_url: wsUrl,
        auth_token_ref: authTokenRef
      };
    }
    return { kind: "codex-appserver", thread_id: threadId, ws_url: wsUrl };
  }
  if (kind === "opencode-server") {
    const sessionId = record.session_id;
    if (typeof sessionId !== "string" || sessionId.length === 0 || !sessionId.startsWith("ses")) {
      throw new Error("corrupt_delivery_payload");
    }
    const baseUrl = record.base_url;
    if (typeof baseUrl !== "string" || baseUrl.length === 0) {
      throw new Error("corrupt_delivery_payload");
    }
    const hasAuthTokenRef = Object.prototype.hasOwnProperty.call(record, "auth_token_ref");
    if (hasAuthTokenRef) {
      const authTokenRef = record.auth_token_ref;
      if (typeof authTokenRef !== "string" || authTokenRef.length === 0) {
        throw new Error("corrupt_delivery_payload");
      }
      return {
        kind: "opencode-server",
        session_id: sessionId,
        base_url: baseUrl,
        auth_token_ref: authTokenRef
      };
    }
    return { kind: "opencode-server", session_id: sessionId, base_url: baseUrl };
  }
  if (kind === "claude-job") {
    const jobId = record.job_id;
    if (typeof jobId !== "string" || jobId.length === 0) {
      throw new Error("corrupt_delivery_payload");
    }
    const jobDir = record.job_dir;
    if (typeof jobDir !== "string" || jobDir.length === 0) {
      throw new Error("corrupt_delivery_payload");
    }
    return { kind: "claude-job", job_id: jobId, job_dir: jobDir };
  }
  throw new Error("corrupt_delivery_payload");
}
function serializeDelivery(spec) {
  if (spec.kind === "none") {
    return { delivery_kind: "none", delivery_payload: null };
  }
  const { kind, ...rest } = spec;
  return {
    delivery_kind: kind,
    delivery_payload: JSON.stringify(rest)
  };
}
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function readTrimmedString(input, key) {
  const value = input[key];
  if (typeof value !== "string") return void 0;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "";
}
function validateDeliveryForWrite(input) {
  if (typeof input !== "object" || input === null) {
    return { error: "invalid_delivery", reason: "unknown_kind" };
  }
  const record = input;
  const kind = record.kind;
  if (kind === "none") {
    return { ok: { kind: "none" } };
  }
  if (kind === "claude-channel") {
    const csid = readTrimmedString(record, "channel_session_id");
    if (csid === void 0 || csid.length === 0) {
      return { error: "invalid_delivery", reason: "missing_channel_session_id" };
    }
    return { ok: { kind: "claude-channel", channel_session_id: csid } };
  }
  if (kind === "codex-appserver") {
    const threadId = readTrimmedString(record, "thread_id");
    if (threadId === void 0 || threadId.length === 0 || !UUID_RE.test(threadId)) {
      return { error: "invalid_delivery", reason: "invalid_thread_id" };
    }
    const wsUrl = readTrimmedString(record, "ws_url");
    if (wsUrl === void 0 || wsUrl.length === 0) {
      return { error: "invalid_delivery", reason: "invalid_ws_url" };
    }
    try {
      const parsed = new URL(wsUrl);
      if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
        return { error: "invalid_delivery", reason: "invalid_ws_url" };
      }
    } catch {
      return { error: "invalid_delivery", reason: "invalid_ws_url" };
    }
    const authTokenRef = readTrimmedString(record, "auth_token_ref");
    if (authTokenRef === "") {
      return { error: "invalid_delivery", reason: "invalid_auth_token_ref" };
    }
    return {
      ok: {
        kind: "codex-appserver",
        thread_id: threadId,
        ws_url: wsUrl,
        ...authTokenRef === void 0 ? {} : { auth_token_ref: authTokenRef }
      }
    };
  }
  if (kind === "opencode-server") {
    const sessionId = readTrimmedString(record, "session_id");
    if (sessionId === void 0 || sessionId.length === 0 || !sessionId.startsWith("ses")) {
      return { error: "invalid_delivery", reason: "invalid_session_id" };
    }
    const baseUrl = readTrimmedString(record, "base_url");
    if (baseUrl === void 0 || baseUrl.length === 0) {
      return { error: "invalid_delivery", reason: "invalid_base_url" };
    }
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { error: "invalid_delivery", reason: "invalid_base_url" };
      }
    } catch {
      return { error: "invalid_delivery", reason: "invalid_base_url" };
    }
    const authTokenRef = readTrimmedString(record, "auth_token_ref");
    if (authTokenRef === "") {
      return { error: "invalid_delivery", reason: "invalid_auth_token_ref" };
    }
    return {
      ok: {
        kind: "opencode-server",
        session_id: sessionId,
        base_url: baseUrl,
        ...authTokenRef === void 0 ? {} : { auth_token_ref: authTokenRef }
      }
    };
  }
  if (kind === "claude-job") {
    const jobId = readTrimmedString(record, "job_id");
    if (jobId === void 0 || jobId.length === 0) {
      return { error: "invalid_delivery", reason: "missing_job_id" };
    }
    const jobDir = readTrimmedString(record, "job_dir");
    if (jobDir === void 0 || jobDir.length === 0) {
      return { error: "invalid_delivery", reason: "missing_job_dir" };
    }
    return { ok: { kind: "claude-job", job_id: jobId, job_dir: jobDir } };
  }
  return { error: "invalid_delivery", reason: "unknown_kind" };
}

// src/storage/agents-repo.ts
var REACHABLE_MS_DEFAULT = 18e4;
function isAgentLive(agent, args) {
  const lastSeenMs = new Date(agent.last_seen_at).getTime();
  if (!Number.isFinite(lastSeenMs)) return false;
  return Date.now() - lastSeenMs <= args.ttlMs;
}
function toAgentRow(row) {
  const delivery = parseDeliveryRow(row);
  return {
    agent_id: row.agent_id,
    agent_type: row.agent_type,
    agent_type_name: row.agent_type_name,
    device: row.device,
    team: row.team,
    role: row.role,
    name: row.name,
    model: row.model,
    tmux_pane_id: row.tmux_pane_id,
    runtime_ui_pid: row.runtime_ui_pid,
    delivery,
    channel_session_id: delivery.kind === "claude-channel" ? delivery.channel_session_id : null,
    last_seen_at: row.last_seen_at
  };
}
var AgentsRepo = class {
  constructor(db) {
    this.db = db;
    this.list = this.list.bind(this);
  }
  db;
  findByIdentity(args) {
    return this.db.prepare(
      `SELECT agent_id FROM agents WHERE device=? AND team=? AND name=?`
    ).get(args.device, args.team, args.name);
  }
  findByRuntimeUiPid(ui_pid, localDevice) {
    return this.db.prepare(
      `SELECT agent_id, device, team, name, role, last_seen_at
       FROM agents
       WHERE device = ?
         AND role != '__channel_proxy__'
         AND runtime_ui_pid IS NOT NULL
         AND runtime_ui_pid = ?
       ORDER BY last_seen_at DESC`
    ).all(localDevice, ui_pid);
  }
  register(input) {
    const team = input.team ?? "default";
    const device = input.device ?? "local";
    const role = input.role ?? "default";
    const name = input.name;
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const newId = randomUUID();
    const delivery = input.delivery ?? { kind: "none" };
    const serialized = serializeDelivery(delivery);
    const preserveExistingDelivery = input.delivery === void 0 ? 1 : 0;
    const tx = this.db.transaction(() => {
      this.writeAgentRow({
        newId,
        input,
        team,
        device,
        role,
        name,
        now,
        serialized,
        preserveExistingDelivery
      });
      const rebindCsid = role === "__channel_proxy__" && input.claude_ui_pid !== void 0 && delivery.kind === "claude-channel" ? delivery.channel_session_id : void 0;
      if (rebindCsid !== void 0) {
        this.reactiveRebindHosts({
          proxy_device: device,
          team,
          claude_ui_pid: input.claude_ui_pid,
          new_csid: rebindCsid
        });
      }
    });
    tx();
    const row = this.db.prepare(
      `SELECT agent_id FROM agents WHERE device=? AND team=? AND name=?`
    ).get(device, team, name);
    return { agent_id: row.agent_id, team };
  }
  writeAgentRow(args) {
    const { newId, input, team, device, role, name, now, serialized, preserveExistingDelivery } = args;
    this.db.prepare(
      `INSERT INTO agents (
         agent_id, agent_type, agent_type_name, device, team, role, name, model, registered_at, last_seen_at,
         tmux_pane_id, claude_ui_pid, runtime_ui_pid, delivery_kind, delivery_payload, remote_addr,
         last_processed_event_id
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               COALESCE((SELECT MAX(event_id) FROM events), 0))
       ON CONFLICT (device, team, name) DO UPDATE SET
         agent_type = excluded.agent_type,
         agent_type_name = excluded.agent_type_name,
         role = excluded.role,
         model = excluded.model,
         last_seen_at = excluded.last_seen_at,
         tmux_pane_id = COALESCE(excluded.tmux_pane_id, tmux_pane_id),
         claude_ui_pid = COALESCE(excluded.claude_ui_pid, claude_ui_pid),
         runtime_ui_pid = COALESCE(excluded.runtime_ui_pid, runtime_ui_pid),
         remote_addr = excluded.remote_addr,
         delivery_kind = CASE
           WHEN ? THEN delivery_kind
           ELSE excluded.delivery_kind
         END,
         delivery_payload = CASE
           WHEN ? THEN delivery_payload
           ELSE excluded.delivery_payload
         END`
    ).run(
      newId,
      input.agent_type ?? null,
      input.agent_type_name ?? null,
      device,
      team,
      role,
      name,
      input.model ?? null,
      now,
      now,
      input.tmux_pane_id ?? null,
      input.claude_ui_pid ?? null,
      input.runtime_ui_pid ?? null,
      serialized.delivery_kind,
      serialized.delivery_payload,
      input.remote_addr ?? null,
      preserveExistingDelivery,
      preserveExistingDelivery
    );
  }
  reactiveRebindHosts(args) {
    this.db.prepare(
      `UPDATE agents
       SET delivery_kind = 'claude-channel',
           delivery_payload = json_object('channel_session_id', ?)
       WHERE role != '__channel_proxy__'
         AND device = ?
         AND runtime_ui_pid IS NOT NULL
         AND runtime_ui_pid = ?
         AND team = ?
         AND (
           delivery_kind = 'none'
           OR (delivery_kind = 'claude-channel'
               AND json_extract(delivery_payload,'$.channel_session_id') != ?)
         )`
    ).run(args.new_csid, args.proxy_device, args.claude_ui_pid, args.team, args.new_csid);
  }
  setDelivery(agent_id, spec) {
    const serialized = serializeDelivery(spec);
    this.db.prepare(
      `UPDATE agents
       SET delivery_kind=?, delivery_payload=?
       WHERE agent_id=?`
    ).run(serialized.delivery_kind, serialized.delivery_payload, agent_id);
  }
  setAgentType(agent_id, agent_type, agent_type_name) {
    this.db.prepare(
      `UPDATE agents
       SET agent_type=?,
           agent_type_name=?
       WHERE agent_id=?`
    ).run(agent_type, agent_type_name ?? null, agent_id);
  }
  setRuntimeBinding(agent_id, args) {
    this.db.prepare(
      `UPDATE agents
       SET tmux_pane_id=?,
           runtime_ui_pid=?,
           runtime_tty=?,
           runtime_verification_mode=?,
           runtime_bound_at=?
       WHERE agent_id=?`
    ).run(
      args.tmux_pane_id,
      args.runtime_ui_pid,
      args.runtime_tty,
      args.runtime_verification_mode,
      args.runtime_bound_at ?? (/* @__PURE__ */ new Date()).toISOString(),
      agent_id
    );
  }
  list(args) {
    const exclude = args.excludeRoles ?? [];
    const ttlMs = args.ttlMs ?? REACHABLE_MS_DEFAULT;
    const baseSelect = `SELECT
         agent_id,
         agent_type,
         agent_type_name,
         device,
         team,
         role,
         name,
         model,
         tmux_pane_id,
         runtime_ui_pid,
         delivery_kind,
         delivery_payload,
         last_seen_at
       FROM agents
       WHERE team=?`;
    const orderBy = ` ORDER BY registered_at ASC`;
    let rows;
    if (exclude.length > 0) {
      const placeholders = exclude.map(() => "?").join(",");
      rows = this.db.prepare(
        `${baseSelect} AND role NOT IN (${placeholders})${orderBy}`
      ).all(args.team, ...exclude);
    } else {
      rows = this.db.prepare(`${baseSelect}${orderBy}`).all(args.team);
    }
    return rows.map((row) => {
      const agent = toAgentRow(row);
      return {
        ...agent,
        online: isAgentLive(agent, { ttlMs })
      };
    });
  }
  touch(agent_id) {
    this.db.prepare(`UPDATE agents SET last_seen_at=? WHERE agent_id=?`).run((/* @__PURE__ */ new Date()).toISOString(), agent_id);
  }
  deleteOlderThan(threshold) {
    const result = this.db.prepare(
      `DELETE FROM agents WHERE last_seen_at < ?`
    ).run(threshold);
    return result.changes;
  }
  deleteById(agent_id) {
    const result = this.db.prepare(
      `DELETE FROM agents
       WHERE agent_id=?`
    ).run(agent_id);
    return result.changes === 1;
  }
  getById(agent_id) {
    const row = this.db.prepare(
      `SELECT
         agent_id,
         agent_type,
         agent_type_name,
         device,
         team,
         role,
         name,
         model,
         tmux_pane_id,
         runtime_ui_pid,
         delivery_kind,
         delivery_payload,
         last_seen_at
       FROM agents
       WHERE agent_id=?`
    ).get(agent_id);
    if (!row) return void 0;
    return toAgentRow(row);
  }
  findById(agent_id) {
    return this.getById(agent_id);
  }
};

// src/mcp/control-plane-reject.ts
function sendControlPlaneReject(reply, status) {
  return reply.code(status).send();
}

// src/daemon/auth.ts
function extractToken(req) {
  const h = req.headers["authorization"];
  if (typeof h === "string" && h.startsWith("Bearer ")) return h.slice(7);
  const q = req.query?.token;
  return typeof q === "string" ? q : void 0;
}
function makeAuthHook(expected) {
  return async (req, reply) => {
    if (req.url.startsWith("/health")) return;
    if (!expected) return;
    const got = extractToken(req);
    if (got !== expected) return sendControlPlaneReject(reply, 401);
  };
}

// src/mcp/transport.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID as randomUUID5, createHash } from "node:crypto";

// src/mcp/echo.ts
import { z } from "zod";
var echoSchema = { msg: z.string() };
async function echoHandler(args) {
  const out = { msg: args.msg, echoed_at: (/* @__PURE__ */ new Date()).toISOString() };
  return { content: [{ type: "text", text: JSON.stringify(out) }] };
}

// src/mcp/tools.ts
import { z as z3 } from "zod";

// src/storage/events-outbox.ts
var EventsOutbox = class {
  constructor(db) {
    this.db = db;
  }
  db;
  append(args) {
    const stmt = this.db.prepare(
      `INSERT INTO events (from_team, to_team, event_type, actor_agent_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const info = stmt.run(
      args.from_team,
      args.to_team,
      args.event_type,
      args.actor_agent_id ?? null,
      JSON.stringify(args.payload),
      (/* @__PURE__ */ new Date()).toISOString()
    );
    return Number(info.lastInsertRowid);
  }
  since(args) {
    const limit = Math.min(args.limit ?? 100, 500);
    return this.db.prepare(
      `SELECT * FROM events WHERE to_team = ? AND event_id > ? ORDER BY event_id ASC LIMIT ?`
    ).all(args.team, args.since_event_id, limit);
  }
};

// src/lib/default-team.ts
import { basename } from "node:path";
function deriveDefaultTeam(input) {
  const explicitTeam = input.team?.trim();
  if (explicitTeam) return explicitTeam;
  if (input.project_dir !== void 0) {
    const projectTeam = basename(input.project_dir).trim().toLowerCase();
    if (projectTeam) return projectTeam;
  }
  return "default";
}

// src/mcp/register-agent.ts
function identityKey(device, team, name) {
  return `${device}\0${team}\0${name}`;
}
function validateNameLabel(name) {
  if (name.includes(":") || name.includes("(") || name.includes(")")) {
    return { error: "invalid_name_label" };
  }
  return { ok: name };
}
function validateTeamLabel(team) {
  if (team.includes("(") || team.includes(")")) {
    return { error: "invalid_team_label" };
  }
  return { ok: team };
}
function resolveEffectiveDevice(args) {
  const origin = args.originInfo?.origin ?? "local";
  const remote_addr = args.originInfo?.remote_addr ?? null;
  const requestedDevice = args.requestedDevice?.trim();
  if (origin === "local") {
    if (requestedDevice && requestedDevice !== args.localDevice) {
      return { error: "device_spoofing_from_loopback" };
    }
    return { ok: args.localDevice, remote_addr: null };
  }
  if (!requestedDevice) {
    return { error: "device_required_from_remote" };
  }
  if (requestedDevice.includes(":") || requestedDevice.length > 64) {
    return { error: "invalid_device_label" };
  }
  const normalizedDevice = requestedDevice.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  if (normalizedDevice === args.localDevice) {
    return { error: "device_spoofing_local_label_from_remote" };
  }
  return { ok: normalizedDevice, remote_addr };
}
var RegisterAgentService = class {
  repo;
  connections = /* @__PURE__ */ new Map();
  deps;
  constructor(db, deps = {}) {
    this.repo = new AgentsRepo(db);
    this.deps = deps;
  }
  register(input) {
    const validated = input.delivery === void 0 ? void 0 : validateDeliveryForWrite(input.delivery);
    if (validated && "error" in validated) return validated;
    const role = input.role ?? "default";
    if (input.claude_ui_pid !== void 0 && role !== "__channel_proxy__") {
      return { error: "claude_ui_pid_requires_channel_proxy" };
    }
    const validName = validateNameLabel(input.name);
    if ("error" in validName) return validName;
    if (input.team !== void 0) {
      const validTeam = validateTeamLabel(input.team);
      if ("error" in validTeam) return validTeam;
    }
    const resolvedDevice = resolveEffectiveDevice({
      requestedDevice: input.device ?? void 0,
      originInfo: this.deps.getSessionOrigin?.(input.connection_id),
      localDevice: this.deps.localDevice ?? "local"
    });
    if ("error" in resolvedDevice) return resolvedDevice;
    const team = deriveDefaultTeam({
      team: input.team,
      project_dir: input.project_dir
    });
    const key = identityKey(resolvedDevice.ok, team, input.name);
    const bound = this.connections.get(key);
    if (bound && bound !== input.connection_id) {
      let closed = false;
      if (this.deps.closeSessionByConnectionId) {
        try {
          closed = this.deps.closeSessionByConnectionId(bound);
        } catch {
        }
      }
      const log = this.deps.log ?? (() => {
      });
      try {
        log(`register_agent takeover: old=${bound} new=${input.connection_id} device=${resolvedDevice.ok} team=${team} name=${input.name} closed=${closed}`);
      } catch {
      }
    }
    this.connections.set(key, input.connection_id);
    return this.repo.register({
      agent_type: input.agent_type,
      agent_type_name: input.agent_type_name,
      device: resolvedDevice.ok,
      model: input.model,
      name: input.name,
      role,
      team,
      tmux_pane_id: input.tmux_pane_id,
      delivery: validated?.ok,
      claude_ui_pid: input.claude_ui_pid,
      runtime_ui_pid: input.runtime_ui_pid,
      remote_addr: resolvedDevice.remote_addr
    });
  }
  releaseConnection(agent_id, connection_id) {
    for (const [k, cid] of this.connections) {
      if (cid === connection_id) this.connections.delete(k);
    }
    void agent_id;
  }
};

// src/mcp/send-message.ts
import { randomUUID as randomUUID2 } from "node:crypto";

// src/daemon/tmux-cli.ts
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
var pExecFile = promisify(execFile);
var _isTmuxAvailable = null;
async function isTmuxAvailable() {
  if (_isTmuxAvailable !== null) return _isTmuxAvailable;
  try {
    await pExecFile("tmux", ["-V"]);
    _isTmuxAvailable = true;
  } catch {
    _isTmuxAvailable = false;
  }
  return _isTmuxAvailable;
}
var TMUX_CAPTURE_TIMEOUT_MS = 5e3;
async function capturePaneTail(paneId, lines = 8) {
  const { stdout } = await pExecFile(
    "tmux",
    ["capture-pane", "-t", paneId, "-p", "-S", `-${lines}`],
    { timeout: TMUX_CAPTURE_TIMEOUT_MS }
  );
  return stdout;
}
function loadBuffer(bufferName, prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn("tmux", ["load-buffer", "-b", bufferName, "-"]);
    let stderr = "";
    child.on("error", reject);
    if (child.stderr) {
      child.stderr.on("data", (b) => {
        stderr += b.toString("utf8");
      });
    }
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`load-buffer exit ${code}: ${stderr}`));
    });
    child.stdin.write(Buffer.from(prompt, "utf8"));
    child.stdin.end();
  });
}
async function pasteBuffer(bufferName, paneId) {
  await pExecFile("tmux", ["paste-buffer", "-b", bufferName, "-t", paneId, "-p", "-d"]);
}
async function sendEnter(paneId) {
  await pExecFile("tmux", ["send-keys", "-t", paneId, "Enter"]);
}

// src/mcp/poke-guard.ts
var DEFAULT_QUIET_MS = 2e3;
var GUARD_TAIL_LINES = 8;
var _captureImpl = capturePaneTail;
function resolveQuietMs(opt) {
  if (typeof opt === "number" && Number.isInteger(opt) && opt > 0) return opt;
  const raw = process.env.POKE_QUIET_MS;
  if (raw === void 0) return DEFAULT_QUIET_MS;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_QUIET_MS;
}
async function runQuietGuard(paneId, quietMs) {
  const ms = resolveQuietMs(quietMs);
  const before = await _captureImpl(paneId, GUARD_TAIL_LINES);
  await new Promise((r) => setTimeout(r, ms));
  const after = await _captureImpl(paneId, GUARD_TAIL_LINES);
  return before === after ? "pass" : "fail";
}

// src/mcp/poke-retry.ts
var RETRY_DELAYS_MS = [3e4, 18e4, 6e5];
var RETRY_DELAYS_S = [30, 180, 600];
var retryMap = /* @__PURE__ */ new Map();
function keyOf(ctx) {
  return `${ctx.messageId}:${ctx.agentId}`;
}
function scheduleRetry(ctx) {
  const key = keyOf(ctx);
  cancelRetry(key);
  retryMap.set(key, { attempt: 0, ctx });
  enqueueNext(key);
}
function enqueueNext(key) {
  const entry = retryMap.get(key);
  if (!entry) return;
  if (entry.attempt >= RETRY_DELAYS_MS.length) {
    retryMap.delete(key);
    return;
  }
  const delay2 = RETRY_DELAYS_MS[entry.attempt];
  entry.timer = setTimeout(() => {
    void tick(key);
  }, delay2);
}
async function tick(key) {
  const entry = retryMap.get(key);
  if (!entry) return;
  const { ctx } = entry;
  try {
    const agent = ctx.lookupAgentFn(ctx.agentId);
    if (!agent || !agent.tmux_pane_id) {
      ctx.updateStatusFn?.({
        agentId: ctx.agentId,
        wake_status: "failed",
        skip_reason: "no_pane",
        retry_attempts: entry.attempt
      });
      retryMap.delete(key);
      return;
    }
    if (new Date(agent.last_seen_at).getTime() > new Date(ctx.sentAt).getTime()) {
      ctx.updateStatusFn?.({
        agentId: ctx.agentId,
        wake_status: "skipped",
        skip_reason: "recipient_active",
        retry_attempts: entry.attempt
      });
      retryMap.delete(key);
      return;
    }
    const guard = await ctx.paneGuardFn(agent.tmux_pane_id);
    if (guard === "pass") {
      await ctx.pokeFn({
        team: ctx.team,
        fromAgentId: ctx.fromAgentId,
        targetAgentId: ctx.agentId,
        paneId: agent.tmux_pane_id,
        body: ctx.body
      });
      ctx.updateStatusFn?.({
        agentId: ctx.agentId,
        wake_status: "delivered",
        skip_reason: null,
        retry_attempts: entry.attempt + 1,
        delivered_at: (/* @__PURE__ */ new Date()).toISOString()
      });
      retryMap.delete(key);
      return;
    }
    entry.attempt += 1;
    if (entry.attempt >= RETRY_DELAYS_MS.length) {
      ctx.updateStatusFn?.({
        agentId: ctx.agentId,
        wake_status: "failed",
        skip_reason: "retry_exhausted",
        retry_attempts: entry.attempt
      });
      retryMap.delete(key);
      return;
    }
    ctx.updateStatusFn?.({
      agentId: ctx.agentId,
      wake_status: "retrying",
      skip_reason: "guard_failed",
      retry_attempts: entry.attempt
    });
    enqueueNext(key);
  } catch {
    ctx.updateStatusFn?.({
      agentId: ctx.agentId,
      wake_status: "failed",
      skip_reason: "retry_exhausted",
      retry_attempts: entry.attempt
    });
    retryMap.delete(key);
  }
}
function cancelRetry(key) {
  const entry = retryMap.get(key);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  retryMap.delete(key);
}
function clearAllRetries() {
  for (const [, v] of retryMap) if (v.timer) clearTimeout(v.timer);
  retryMap.clear();
}

// src/mcp/auto-poke-fanout.ts
function hasNonTmuxTransport(recipient) {
  return recipient.delivery !== void 0 && recipient.delivery.kind !== "none";
}
async function fanoutAutoPoke(args) {
  const pokeFn = args.deps.poke;
  const tmuxAvail = args.deps.tmuxAvailable ?? isTmuxAvailable;
  const results = await Promise.all(args.recipients.map(async (r) => {
    try {
      const nonTmuxTransport = hasNonTmuxTransport(r);
      if (r.agent_id === args.fromAgentId) {
        return { agent_id: r.agent_id, poked: false, reason: "self", paneId: null };
      }
      if (!nonTmuxTransport && !r.tmux_pane_id) {
        return { agent_id: r.agent_id, poked: false, reason: "no_pane", paneId: null };
      }
      if (!nonTmuxTransport && !await tmuxAvail()) {
        return { agent_id: r.agent_id, poked: false, reason: "tmux_unavailable", paneId: r.tmux_pane_id };
      }
      if (!pokeFn) {
        return { agent_id: r.agent_id, poked: false, reason: "tmux_unavailable", paneId: r.tmux_pane_id };
      }
      const out = await pokeFn({
        team: args.team,
        fromAgentId: args.fromAgentId,
        targetAgentId: r.agent_id,
        paneId: r.tmux_pane_id,
        body: args.body
      });
      if (out.ok) return { agent_id: r.agent_id, poked: true, reason: void 0, paneId: r.tmux_pane_id };
      return {
        agent_id: r.agent_id,
        poked: false,
        reason: out.reason ?? "guard_failed",
        paneId: r.tmux_pane_id
      };
    } catch {
      return { agent_id: r.agent_id, poked: false, reason: "guard_failed", paneId: r.tmux_pane_id };
    }
  }));
  let retryScheduledCount = 0;
  if (args.retry && pokeFn) {
    const scheduleFn = args.retry.scheduleRetryFn ?? scheduleRetry;
    for (const res of results) {
      if (!res.poked && res.reason === "guard_failed" && res.paneId) {
        scheduleFn({
          agentId: res.agent_id,
          messageId: args.retry.messageId,
          fromAgentId: args.fromAgentId,
          body: args.body,
          team: args.team,
          sentAt: args.retry.sentAt,
          paneId: res.paneId,
          paneGuardFn: runQuietGuard,
          pokeFn: async (pokeArgs) => {
            await pokeFn({ ...pokeArgs, skipGuard: true });
          },
          lookupAgentFn: args.retry.lookupAgentFn,
          updateStatusFn: args.retry.updateStatusFn
        });
        retryScheduledCount += 1;
      }
    }
  }
  const poked = results.some((x) => x.poked);
  const skipReasons = results.filter((x) => !x.poked && x.reason !== void 0).map((x) => ({ agent_id: x.agent_id, reason: x.reason }));
  const deliveredAgentIds = results.filter((x) => x.poked).map((x) => x.agent_id);
  return { poked, skipReasons, deliveredAgentIds, retryScheduledCount };
}

// src/mcp/delivery-status.ts
function recordInitialDeliveryStatuses(db, args) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const skipped = new Map(args.skipped.map((x) => [x.agent_id, x.reason]));
  const stmt = db.prepare(
    `INSERT INTO message_delivery_status
       (message_id, agent_id, wake_status, skip_reason, retry_attempts, updated_at, delivered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(message_id, agent_id) DO UPDATE SET
       wake_status=excluded.wake_status,
       skip_reason=excluded.skip_reason,
       retry_attempts=excluded.retry_attempts,
       updated_at=excluded.updated_at,
       delivered_at=excluded.delivered_at`
  );
  const tx = db.transaction(() => {
    for (const agentId of args.recipients) {
      const reason = args.autoPokeDisabled ? "auto_poke_disabled" : skipped.get(agentId);
      const delivered = args.delivered.has(agentId);
      const status = delivered ? "delivered" : reason === "guard_failed" ? "retrying" : "skipped";
      stmt.run(
        args.messageId,
        agentId,
        status,
        delivered ? null : reason,
        0,
        now,
        delivered ? now : null
      );
    }
  });
  tx();
}
function updateDeliveryStatus(db, messageId, agentId, args) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  db.prepare(
    `UPDATE message_delivery_status
     SET wake_status=?,
         skip_reason=?,
         retry_attempts=COALESCE(?, retry_attempts),
         updated_at=?,
         delivered_at=?
     WHERE message_id=? AND agent_id=?`
  ).run(
    args.wake_status,
    args.skip_reason ?? null,
    args.retry_attempts ?? null,
    now,
    args.delivered_at === void 0 ? null : args.delivered_at,
    messageId,
    agentId
  );
}
var GetDeliveryStatusService = class {
  constructor(db) {
    this.db = db;
  }
  db;
  get(args) {
    const owned = this.db.prepare(
      `SELECT 1 AS ok FROM messages WHERE id=? AND from_agent_id=? LIMIT 1`
    ).get(args.message_id, args.caller);
    if (!owned) return { error: "unknown_message" };
    const rows = this.db.prepare(
      `SELECT agent_id, wake_status, skip_reason, retry_attempts, updated_at, delivered_at
       FROM message_delivery_status
       WHERE message_id=?
       ORDER BY agent_id ASC`
    ).all(args.message_id);
    return { message_id: args.message_id, statuses: rows };
  }
};

// src/mcp/fanout-with-retry.ts
async function runFanoutWithRetry(args) {
  const { db } = args;
  const fanout = await fanoutAutoPoke({
    team: args.team,
    fromAgentId: args.fromAgentId,
    recipients: args.recipients,
    body: args.body,
    deps: args.deps,
    retry: {
      messageId: args.messageId,
      sentAt: args.sentAt,
      lookupAgentFn: (agentId) => db.prepare(
        "SELECT agent_id, tmux_pane_id, last_seen_at FROM agents WHERE agent_id=?"
      ).get(agentId),
      updateStatusFn: (status) => {
        updateDeliveryStatus(db, args.messageId, status.agentId, status);
      }
    }
  });
  recordInitialDeliveryStatuses(db, {
    messageId: args.messageId,
    recipients: args.recipients.map((r) => r.agent_id),
    delivered: new Set(fanout.deliveredAgentIds),
    skipped: fanout.skipReasons
  });
  const retry_scheduled = fanout.retryScheduledCount > 0;
  return {
    poked: fanout.poked,
    poke_skip_reasons: fanout.skipReasons,
    retry_scheduled,
    ...retry_scheduled ? { retry_delays_s: [...RETRY_DELAYS_S] } : {}
  };
}

// src/mcp/send-message.ts
function parseToAgentName(raw, callerDevice) {
  const colon = raw.indexOf(":");
  if (colon < 0) {
    return { ok: { name: raw, device: callerDevice } };
  }
  const name = raw.slice(0, colon);
  const device = raw.slice(colon + 1);
  if (name.length === 0 || device.length === 0) {
    return { error: "invalid_to_agent_name" };
  }
  return { ok: { name, device } };
}
var SendMessageService = class {
  constructor(db, agents, events, deps = {}) {
    this.db = db;
    this.agents = agents;
    this.events = events;
    this.deps = deps;
  }
  db;
  agents;
  events;
  deps;
  async send(input) {
    const hasId = typeof input.to_agent_id === "string" && input.to_agent_id.length > 0;
    const hasName = typeof input.to_agent_name === "string" && input.to_agent_name.length > 0;
    if (!hasId && !hasName) return { error: "missing_recipient" };
    if (hasId && hasName) return { error: "ambiguous_recipient" };
    const fromRow = this.agents.findById(input.from);
    if (!fromRow) return { error: "unknown_recipient" };
    const fromTeam = fromRow.team;
    const toTeam = input.to_team ?? fromTeam;
    let resolvedId;
    if (hasId) {
      resolvedId = input.to_agent_id;
    } else {
      const parsed = parseToAgentName(input.to_agent_name, fromRow.device);
      if ("error" in parsed) return parsed;
      const hit = this.agents.findByIdentity({
        device: parsed.ok.device,
        team: toTeam,
        name: parsed.ok.name
      });
      if (!hit) return { error: "unknown_recipient" };
      resolvedId = hit.agent_id;
    }
    const rcpt = this.db.prepare(
      `SELECT
         agent_id,
         team,
         tmux_pane_id,
         delivery_kind,
         delivery_payload,
         last_seen_at
       FROM agents
       WHERE agent_id=?`
    ).get(resolvedId);
    if (!rcpt || rcpt.team !== toTeam) return { error: "unknown_recipient" };
    const ttlMs = REACHABLE_MS_DEFAULT;
    const lastSeenMs = new Date(rcpt.last_seen_at).getTime();
    const ageMs = Date.now() - lastSeenMs;
    if (!Number.isFinite(lastSeenMs) || ageMs > ttlMs) {
      const ageSec = Math.floor(ageMs / 1e3);
      return { error: "unreachable", detail: `recipient not online (last seen ${ageSec}s ago)` };
    }
    const recipientRow = {
      agent_id: rcpt.agent_id,
      tmux_pane_id: rcpt.tmux_pane_id,
      delivery: parseDeliveryRow(rcpt)
    };
    const baseResult = this.insert({ fromTeam, toTeam, from: input.from, toAgentId: rcpt.agent_id, input });
    const delivery = parseDeliveryRow(rcpt);
    if (delivery.kind === "claude-job" && delivery.job_dir) {
      try {
        const fs = await import("node:fs/promises");
        const wakePath = `${delivery.job_dir}/.xats-wake`;
        await fs.writeFile(wakePath, (/* @__PURE__ */ new Date()).toISOString());
      } catch {
      }
    }
    const autoPokeEnabled = input.auto_poke !== false;
    if (!autoPokeEnabled) {
      recordInitialDeliveryStatuses(this.db, {
        messageId: baseResult.message_id,
        recipients: [rcpt.agent_id],
        delivered: /* @__PURE__ */ new Set(),
        skipped: [],
        autoPokeDisabled: true
      });
      return { ...baseResult, poked: false, retry_scheduled: false };
    }
    const envelope = await runFanoutWithRetry({
      db: this.db,
      team: toTeam,
      fromAgentId: input.from,
      recipients: [recipientRow],
      body: input.body,
      deps: this.deps,
      messageId: baseResult.message_id,
      sentAt: baseResult.sent_at
    });
    return {
      message_id: baseResult.message_id,
      event_id: baseResult.event_id,
      recipients: baseResult.recipients,
      ...envelope
    };
  }
  insert(args) {
    const tx = this.db.transaction(() => {
      const needReply = args.input.need_reply !== false ? 1 : 0;
      const event_id2 = this.events.append({
        from_team: args.fromTeam,
        to_team: args.toTeam,
        event_type: "message_sent",
        actor_agent_id: args.from,
        payload: {
          recipients: [args.toAgentId],
          subject: args.input.subject ?? null,
          need_reply: needReply === 1
        }
      });
      const sent_at2 = (/* @__PURE__ */ new Date()).toISOString();
      const id = randomUUID2();
      this.db.prepare(
        `INSERT INTO messages (id, event_id, from_team, to_team, from_agent_id, to_agent_id, to_role, subject, body, need_reply, sent_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        id,
        event_id2,
        args.fromTeam,
        args.toTeam,
        args.from,
        args.toAgentId,
        null,
        args.input.subject ?? null,
        args.input.body,
        needReply,
        sent_at2
      );
      return { message_id: id, event_id: event_id2, sent_at: sent_at2 };
    });
    const { message_id, event_id, sent_at } = tx();
    return { message_id, event_id, recipients: [args.toAgentId], sent_at };
  }
};

// src/mcp/broadcast.ts
import { randomUUID as randomUUID3 } from "node:crypto";
var BroadcastService = class {
  constructor(db, agents, deps = {}) {
    this.db = db;
    this.agents = agents;
    this.deps = deps;
  }
  db;
  agents;
  deps;
  async broadcast(input) {
    const fromRow = this.agents.findById(input.from);
    if (!fromRow) return { error: "unknown_recipient" };
    const rawRows = this.db.prepare(
      `SELECT
         agent_id,
         tmux_pane_id,
         delivery_kind,
         delivery_payload,
         last_seen_at
       FROM agents
       WHERE team=? AND role != '__channel_proxy__' AND agent_id != ?`
    ).all(fromRow.team, input.from);
    const ttlMs = REACHABLE_MS_DEFAULT;
    const now = Date.now();
    const reachable = [];
    const skipped = [];
    for (const row of rawRows) {
      const ageMs = now - new Date(row.last_seen_at).getTime();
      if (Number.isFinite(ageMs) && ageMs <= ttlMs) {
        reachable.push(row);
      } else {
        skipped.push(row.agent_id);
      }
    }
    const rows = reachable.map((row) => ({
      agent_id: row.agent_id,
      tmux_pane_id: row.tmux_pane_id,
      delivery: parseDeliveryRow(row)
    }));
    if (rows.length === 0) return { error: "unknown_recipient" };
    const recipients = rows.map((r) => r.agent_id);
    const baseId = randomUUID3();
    const inserted = this.insertBroadcast(fromRow.team, input.from, recipients, input.body, input.subject, baseId);
    try {
      const fs = await import("node:fs/promises");
      for (const row of rows) {
        if (row.delivery.kind === "claude-job" && row.delivery.job_dir) {
          const wakePath = `${row.delivery.job_dir}/.xats-wake`;
          await fs.writeFile(wakePath, (/* @__PURE__ */ new Date()).toISOString()).catch(() => {
          });
        }
      }
    } catch {
    }
    if (input.auto_poke === false) {
      recordInitialDeliveryStatuses(this.db, {
        messageId: inserted.message_id,
        recipients,
        delivered: /* @__PURE__ */ new Set(),
        skipped: [],
        autoPokeDisabled: true
      });
      return { ...inserted, recipients, poked: false, retry_scheduled: false };
    }
    const envelope = await runFanoutWithRetry({
      db: this.db,
      team: fromRow.team,
      fromAgentId: input.from,
      recipients: rows,
      body: input.body,
      deps: this.deps,
      messageId: inserted.message_id,
      sentAt: inserted.sent_at
    });
    return {
      message_id: inserted.message_id,
      event_id: inserted.event_id,
      recipients,
      skipped,
      ...envelope
    };
  }
  insertBroadcast(team, from, recipients, body, subject, baseId) {
    const tx = this.db.transaction(() => {
      const event_id = Number(this.db.prepare(
        `INSERT INTO events (from_team, to_team, event_type, actor_agent_id, payload, created_at) VALUES (?,?,?,?,?,?)`
      ).run(
        team,
        team,
        "message_sent",
        from,
        JSON.stringify({ to_role: "*broadcast*", recipients, subject: subject ?? null }),
        (/* @__PURE__ */ new Date()).toISOString()
      ).lastInsertRowid);
      const sent_at = (/* @__PURE__ */ new Date()).toISOString();
      const insert = this.db.prepare(
        `INSERT INTO messages (id, event_id, from_team, to_team, from_agent_id, to_agent_id, to_role, subject, body, need_reply, sent_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      );
      for (let i = 0; i < recipients.length; i++) {
        const id = i === 0 ? baseId : `${baseId}-${i}`;
        insert.run(id, event_id, team, team, from, recipients[i], "*broadcast*", subject ?? null, body, 0, sent_at);
      }
      return { message_id: baseId, event_id, sent_at };
    });
    return tx();
  }
};

// src/mcp/broadcast-to-role.ts
import { randomUUID as randomUUID4 } from "node:crypto";
var BroadcastToRoleService = class {
  constructor(db, agents, events, deps = {}) {
    this.db = db;
    this.agents = agents;
    this.events = events;
    this.deps = deps;
  }
  db;
  agents;
  events;
  deps;
  async broadcast(input) {
    const fromRow = this.agents.findById(input.from);
    if (!fromRow) return { error: "unknown_recipient" };
    const rawRows = this.db.prepare(
      `SELECT
         agent_id,
         tmux_pane_id,
         delivery_kind,
         delivery_payload,
         last_seen_at
       FROM agents
       WHERE team=? AND role=? AND agent_id != ?`
    ).all(fromRow.team, input.to_role, input.from);
    const ttlMs = REACHABLE_MS_DEFAULT;
    const now = Date.now();
    const reachable = [];
    const skipped = [];
    for (const row of rawRows) {
      const ageMs = now - new Date(row.last_seen_at).getTime();
      if (Number.isFinite(ageMs) && ageMs <= ttlMs) {
        reachable.push(row);
      } else {
        skipped.push(row.agent_id);
      }
    }
    const rows = reachable.map((row) => ({
      agent_id: row.agent_id,
      tmux_pane_id: row.tmux_pane_id,
      delivery: parseDeliveryRow(row)
    }));
    if (rows.length === 0) return { error: "unknown_recipient" };
    const recipients = rows.map((r) => r.agent_id);
    const baseId = randomUUID4();
    const inserted = this.insert(fromRow.team, input, recipients, baseId);
    try {
      const fs = await import("node:fs/promises");
      for (const row of rows) {
        if (row.delivery.kind === "claude-job" && row.delivery.job_dir) {
          const wakePath = `${row.delivery.job_dir}/.xats-wake`;
          await fs.writeFile(wakePath, (/* @__PURE__ */ new Date()).toISOString()).catch(() => {
          });
        }
      }
    } catch {
    }
    if (input.auto_poke === false) {
      recordInitialDeliveryStatuses(this.db, {
        messageId: inserted.message_id,
        recipients,
        delivered: /* @__PURE__ */ new Set(),
        skipped: [],
        autoPokeDisabled: true
      });
      return {
        message_id: inserted.message_id,
        event_id: inserted.event_id,
        recipients,
        poked: false,
        retry_scheduled: false
      };
    }
    const envelope = await runFanoutWithRetry({
      db: this.db,
      team: fromRow.team,
      fromAgentId: input.from,
      recipients: rows,
      body: input.body,
      deps: this.deps,
      messageId: inserted.message_id,
      sentAt: inserted.sent_at
    });
    return {
      message_id: inserted.message_id,
      event_id: inserted.event_id,
      recipients,
      skipped,
      ...envelope
    };
  }
  insert(team, input, recipients, baseId) {
    const tx = this.db.transaction(() => {
      const event_id = this.events.append({
        from_team: team,
        to_team: team,
        event_type: "message_sent",
        actor_agent_id: input.from,
        payload: { to_role: input.to_role, recipients, subject: input.subject ?? null }
      });
      const sent_at = (/* @__PURE__ */ new Date()).toISOString();
      const stmt = this.db.prepare(
        `INSERT INTO messages (id, event_id, from_team, to_team, from_agent_id, to_agent_id, to_role, subject, body, need_reply, sent_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      );
      for (let i = 0; i < recipients.length; i++) {
        const id = i === 0 ? baseId : `${baseId}-${i}`;
        stmt.run(id, event_id, team, team, input.from, recipients[i], input.to_role, input.subject ?? null, input.body, 0, sent_at);
      }
      return { message_id: baseId, event_id, sent_at };
    });
    return tx();
  }
};

// src/mcp/get-inbox.ts
var GetInboxService = class {
  constructor(db, agents) {
    this.db = db;
    this.agents = agents;
  }
  db;
  agents;
  get(args) {
    const caller = this.agents.findById(args.caller);
    if (!caller) return { messages: [], has_more: false, last_event_id: args.since_event_id ?? 0 };
    const callerTeam = caller.team;
    const callerRoleRow = this.db.prepare("SELECT role, last_processed_event_id FROM agents WHERE agent_id=?").get(args.caller);
    const callerRole = callerRoleRow?.role;
    const storedCursor = callerRoleRow?.last_processed_event_id ?? 0;
    const limit = Math.min(args.limit ?? 50, 200);
    const implicit = args.since_event_id === void 0;
    const effectiveSince = implicit ? storedCursor : args.since_event_id;
    const tx = this.db.transaction(() => {
      const rows = this.db.prepare(
        `SELECT m.id, m.event_id, m.from_team, m.to_team, m.from_agent_id, m.to_agent_id, m.to_role, m.subject, m.body, m.need_reply, m.sent_at,
                a.role as from_role,
                a.name as from_name,
                a.device as from_device
           FROM messages m
           LEFT JOIN agents a ON a.agent_id = m.from_agent_id
          WHERE m.to_team = ?
            AND m.event_id > ?
            AND ( m.to_agent_id = ? OR (m.to_role IS NOT NULL AND m.to_role = ?) )
          ORDER BY m.event_id ASC
          LIMIT ?`
      ).all(callerTeam, effectiveSince, args.caller, callerRole ?? "__none__", limit + 1);
      const has_more = rows.length > limit;
      const trimmed = (has_more ? rows.slice(0, limit) : rows).map((row) => ({
        ...row,
        need_reply: row.need_reply === 1
      }));
      const last_event_id = trimmed.length > 0 ? trimmed[trimmed.length - 1].event_id : effectiveSince;
      if (implicit && last_event_id > storedCursor) {
        this.db.prepare(
          `UPDATE agents
              SET last_processed_event_id = ?
            WHERE agent_id = ? AND last_processed_event_id < ?`
        ).run(last_event_id, args.caller, last_event_id);
      }
      return { messages: trimmed, has_more, last_event_id };
    });
    return tx();
  }
};

// src/mcp/poke.ts
import { randomBytes } from "node:crypto";

// src/daemon/channel-wake-send.ts
var META_KEY_RE = /^[A-Za-z0-9_]+$/;
function sanitizeMeta(meta) {
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    if (META_KEY_RE.test(k)) out[k] = v;
  }
  return out;
}
function sendChannelWake(fanout, channel_session_id, input) {
  if (!fanout.has(channel_session_id)) return { ok: false, reason: "no_subscriber" };
  const payload = {
    jsonrpc: "2.0",
    method: "notifications/channel_wake",
    params: {
      content: input.content,
      meta: sanitizeMeta(input.meta)
    }
  };
  fanout.send(channel_session_id, payload);
  return { ok: true };
}

// src/mcp/codex-appserver-rpc.ts
function defaultWebSocketFactory(args) {
  const ctor = globalThis.WebSocket;
  return new ctor(
    args.url,
    args.headers === void 0 ? void 0 : { headers: args.headers }
  );
}
function describeError(error) {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "string" && error.length > 0) return error;
  if (error && typeof error === "object") {
    const record = error;
    const message = record.message;
    if (typeof message === "string" && message.length > 0) return message;
    const reason = record.reason;
    if (typeof reason === "string" && reason.length > 0) return reason;
  }
  return String(error);
}
function closeDetail(event) {
  const code = typeof event.code === "number" ? event.code : "unknown";
  const reason = typeof event.reason === "string" && event.reason.length > 0 ? event.reason : "socket_closed";
  return `close ${code}: ${reason}`;
}
function decodeMessageData(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(data));
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
  }
  return String(data);
}
function safeClose(ws) {
  try {
    ws.close();
  } catch {
    return;
  }
}
function resolveAuthToken(authTokenRef, env) {
  if (authTokenRef === void 0) return { ok: void 0 };
  const token = env[authTokenRef]?.trim();
  if (!token) {
    return {
      error: "missing_auth_token",
      detail: { ref: authTokenRef }
    };
  }
  return { ok: token };
}
var JsonRpcSocketClient = class {
  constructor(ws) {
    this.ws = ws;
    this.openState = {
      kind: "pending",
      promise: new Promise((resolve, reject) => {
        const onOpen = () => {
          cleanup();
          this.openState = { kind: "open" };
          resolve();
        };
        const onError = (event) => {
          cleanup();
          const detail = event;
          const error = detail.error ?? detail.message ?? "websocket_error";
          this.openState = { kind: "failed", error };
          reject(error);
        };
        const onClose = (event) => {
          cleanup();
          const closeEvent = event;
          const error = closeDetail(closeEvent);
          this.openState = { kind: "failed", error };
          reject(error);
        };
        const cleanup = () => {
          this.ws.removeEventListener?.("open", onOpen);
          this.ws.removeEventListener?.("error", onError);
          this.ws.removeEventListener?.("close", onClose);
        };
        this.ws.addEventListener("open", onOpen);
        this.ws.addEventListener("error", onError);
        this.ws.addEventListener("close", onClose);
      })
    };
    this.ws.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(decodeMessageData(event.data));
      } catch {
        return;
      }
      if (typeof message.id !== "number") return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      pending.resolve(message);
    });
    this.ws.addEventListener("error", (event) => {
      if (this.openState.kind !== "open") return;
      const detail = event;
      const error = detail.error ?? detail.message ?? "websocket_error";
      this.rejectAll(error);
    });
    this.ws.addEventListener("close", (event) => {
      if (this.openState.kind !== "open") return;
      this.rejectAll(closeDetail(event));
    });
  }
  ws;
  nextId = 1;
  pending = /* @__PURE__ */ new Map();
  openState;
  async waitForOpen() {
    if (this.openState.kind === "open") return;
    if (this.openState.kind === "failed") throw this.openState.error;
    await this.openState.promise;
  }
  request(method, params) {
    const id = this.nextId++;
    const request = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify(request));
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  notify(method, params) {
    const notification = {
      jsonrpc: "2.0",
      method,
      ...params === void 0 ? {} : { params }
    };
    this.ws.send(JSON.stringify(notification));
  }
  rejectAll(error) {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      entry.reject(error);
    }
  }
};

// src/mcp/codex-appserver-dispatch.ts
async function requestStep(client, method, params) {
  try {
    const response = await client.request(method, params);
    if (response.error) {
      const mappedError = method === "initialize" ? "codex_initialize_failed" : method === "thread/resume" ? "codex_resume_failed" : "codex_turn_start_failed";
      return { error: mappedError, detail: response.error };
    }
    return { ok: response };
  } catch (error) {
    const mappedError = method === "initialize" ? "codex_initialize_failed" : method === "thread/resume" ? "codex_resume_failed" : "codex_turn_start_failed";
    return { error: mappedError, detail: describeError(error) };
  }
}
async function dispatchCodexAppserverPoke(input, deps = {}) {
  const authToken = resolveAuthToken(
    input.delivery.auth_token_ref,
    deps.env ?? process.env
  );
  if ("error" in authToken) return authToken;
  const headers = authToken.ok === void 0 ? void 0 : { Authorization: `Bearer ${authToken.ok}` };
  let ws;
  try {
    ws = (deps.webSocketFactory ?? defaultWebSocketFactory)({
      url: input.delivery.ws_url,
      headers
    });
  } catch (error) {
    return {
      error: "codex_connect_failed",
      detail: describeError(error),
      transport_used: "codex-appserver"
    };
  }
  const client = new JsonRpcSocketClient(ws);
  try {
    await client.waitForOpen();
    const init = await requestStep(client, "initialize", {
      clientInfo: {
        name: "cross-agent-teams-mcp",
        title: null,
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: null
      }
    });
    if ("error" in init) {
      return {
        error: init.error,
        detail: init.detail,
        transport_used: "codex-appserver"
      };
    }
    client.notify("initialized");
    const resume = await requestStep(client, "thread/resume", {
      threadId: input.delivery.thread_id,
      persistExtendedHistory: false
    });
    if ("error" in resume) {
      return {
        error: resume.error,
        detail: resume.detail,
        transport_used: "codex-appserver"
      };
    }
    const turnStart = await requestStep(client, "turn/start", {
      threadId: input.delivery.thread_id,
      input: [{ type: "text", text: input.content, text_elements: [] }]
    });
    if ("error" in turnStart) {
      return {
        error: turnStart.error,
        detail: turnStart.detail,
        transport_used: "codex-appserver"
      };
    }
    return {
      ok: true,
      transport_used: "codex-appserver",
      thread_id: input.delivery.thread_id
    };
  } catch (error) {
    return {
      error: "codex_connect_failed",
      detail: describeError(error),
      transport_used: "codex-appserver"
    };
  } finally {
    safeClose(ws);
  }
}

// src/mcp/opencode-server-dispatch.ts
var MAX_BODY_PREVIEW_BYTES = 4 * 1024;
function truncateBody(body) {
  if (body.length <= MAX_BODY_PREVIEW_BYTES) return body;
  return body.slice(0, MAX_BODY_PREVIEW_BYTES);
}
async function dispatchOpencodeServerPoke(input, deps = {}) {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const authToken = resolveAuthToken(input.delivery.auth_token_ref, env);
  if ("error" in authToken) return authToken;
  const url = `${input.delivery.base_url.replace(/\/+$/, "")}/session/${encodeURIComponent(input.delivery.session_id)}/prompt_async`;
  const headers = { "Content-Type": "application/json" };
  if (authToken.ok !== void 0) {
    headers["Authorization"] = `Bearer ${authToken.ok}`;
  }
  const body = JSON.stringify({
    parts: [{ type: "text", text: input.content }],
    noReply: false
  });
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers,
      body
    });
  } catch (error) {
    return {
      error: "opencode_connect_failed",
      detail: describeError(error),
      transport_used: "opencode-server"
    };
  }
  if (!response.ok) {
    let bodyText = "";
    try {
      bodyText = await response.text();
    } catch {
      bodyText = "";
    }
    return {
      error: "opencode_inject_failed",
      detail: {
        status: response.status,
        body: truncateBody(bodyText)
      },
      transport_used: "opencode-server"
    };
  }
  return {
    ok: true,
    transport_used: "opencode-server",
    session_id: input.delivery.session_id
  };
}

// src/mcp/transport-dispatch.ts
async function dispatchPoke(deps, target, input) {
  const agentType = resolveAgentType(target);
  if (agentType === "claude-code") return dispatchClaude(deps, target, input);
  if (agentType === "codex") return dispatchCodex(deps, target, input);
  if (agentType === "opencode") return dispatchOpencode(deps, target, input);
  return dispatchUnknown(deps, target, input);
}
function resolveAgentType(target) {
  if (target.agent_type) return target.agent_type;
  if (target.delivery.kind === "claude-channel") return "claude-code";
  if (target.delivery.kind === "codex-appserver") return "codex";
  if (target.delivery.kind === "opencode-server") return "opencode";
  return null;
}
async function dispatchTmux(deps, paneId, content, skipGuard) {
  const tmuxResult = await deps.tmuxPoke({ pane_id: paneId, content, skipGuard });
  if ("ok" in tmuxResult && tmuxResult.ok) {
    return {
      ok: true,
      transport_used: "tmux-poke",
      pane_id: paneId,
      pane_tail_before: tmuxResult.pane_tail_before,
      pane_tail_after: tmuxResult.pane_tail_after
    };
  }
  return {
    ...tmuxResult,
    transport_used: "tmux-poke"
  };
}
async function dispatchClaude(deps, target, input) {
  const paneId = target.tmux_pane_id;
  const channelSubscribed = target.delivery.kind === "claude-channel" && (deps.channelWakeFanout?.has(target.delivery.channel_session_id) ?? false);
  if (target.delivery.kind === "claude-channel" && channelSubscribed && deps.channelWakeFanout) {
    const result = sendChannelWake(
      deps.channelWakeFanout,
      target.delivery.channel_session_id,
      input
    );
    if (result.ok) {
      return {
        ok: true,
        transport_used: "claude-channel",
        channel_session_id: target.delivery.channel_session_id
      };
    }
  }
  if (paneId) return dispatchTmux(deps, paneId, input.content, input.skipGuard);
  return {
    error: "no_transport_available",
    detail: {
      channel_subscribed: channelSubscribed,
      tmux_pane_set: false
    }
  };
}
async function dispatchCodex(deps, target, input) {
  const paneId = target.tmux_pane_id;
  if (target.delivery.kind === "codex-appserver") {
    const result = await (deps.codexAppserverDispatch ?? dispatchCodexAppserverPoke)({
      delivery: target.delivery,
      content: input.content
    });
    if ("ok" in result && result.ok) return result;
    if (paneId) return dispatchTmux(deps, paneId, input.content, input.skipGuard);
    return result;
  }
  if (paneId) return dispatchTmux(deps, paneId, input.content, input.skipGuard);
  return {
    error: "no_transport_available",
    detail: {
      codex_bound: false,
      tmux_pane_set: false
    }
  };
}
async function dispatchOpencode(deps, target, input) {
  if (target.delivery.kind === "opencode-server") {
    const result = await (deps.opencodeServerDispatch ?? dispatchOpencodeServerPoke)({
      delivery: target.delivery,
      content: input.content
    });
    return result;
  }
  const paneId = target.tmux_pane_id;
  if (paneId) return dispatchTmux(deps, paneId, input.content, input.skipGuard);
  return {
    error: "no_transport_available",
    detail: {
      opencode_bound: false,
      tmux_pane_set: false
    }
  };
}
async function dispatchUnknown(deps, target, input) {
  const paneId = target.tmux_pane_id;
  if (paneId) return dispatchTmux(deps, paneId, input.content, input.skipGuard);
  return {
    error: "no_transport_available",
    detail: {
      channel_subscribed: false,
      tmux_pane_set: false
    }
  };
}

// src/mcp/poke.ts
var PROMPT_MAX_BYTES = 8192;
var PASTE_SETTLE_MS = 400;
var TAIL_LINES = 8;
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function errorMessage(cause) {
  if (cause && typeof cause === "object") {
    const err = cause;
    if (err.stderr) {
      const s = typeof err.stderr === "string" ? err.stderr : err.stderr.toString("utf8");
      if (s.length > 0) return s;
    }
    if (err.message) return err.message;
  }
  return String(cause);
}
function classifyTmuxError(err) {
  const msg = errorMessage(err.cause);
  const lower = msg.toLowerCase();
  if (lower.includes("can't find pane") || lower.includes("pane not found") || lower.includes("no such pane")) {
    return { error: "pane_dead", detail: msg };
  }
  return { error: "tmux_cmd_failed", detail: { stage: err.stage, stderr: msg } };
}
async function runStage(stage, fn) {
  try {
    return await fn();
  } catch (cause) {
    throw { stage, cause };
  }
}
async function tmuxPokeImpl(args) {
  if (!await isTmuxAvailable()) {
    return { error: "tmux_unavailable", detail: "tmux binary not available on PATH" };
  }
  const bufName = `poke-${randomBytes(3).toString("hex")}`;
  try {
    if (!args.skipGuard) {
      const guard = await runStage("capture_before", () => runQuietGuard(args.pane_id));
      if (guard === "fail") return { error: "guard_failed" };
    }
    const pane_tail_before = await runStage("capture_before", () => capturePaneTail(args.pane_id, TAIL_LINES));
    await runStage("load_buffer", () => loadBuffer(bufName, args.content));
    await runStage("paste_buffer", () => pasteBuffer(bufName, args.pane_id));
    await delay(PASTE_SETTLE_MS);
    await runStage("send_keys", () => sendEnter(args.pane_id));
    await delay(PASTE_SETTLE_MS);
    const pane_tail_after = await runStage("capture_after", () => capturePaneTail(args.pane_id, TAIL_LINES));
    return { ok: true, pane_tail_before, pane_tail_after };
  } catch (e) {
    return classifyTmuxError(e);
  }
}
async function poke(deps, input) {
  if (!deps.callerAgentId) return { error: "unknown_agent" };
  const promptLen = Buffer.byteLength(input.prompt, "utf8");
  if (promptLen > PROMPT_MAX_BYTES) {
    return { error: "prompt_too_long", detail: { max: PROMPT_MAX_BYTES, got: promptLen } };
  }
  const target = deps.db.prepare(
    `SELECT
         agent_id,
         agent_type,
         team,
         tmux_pane_id,
         delivery_kind,
         delivery_payload
       FROM agents
       WHERE agent_id = ?`
  ).get(input.target_agent_id);
  if (!target) return { error: "unknown_target" };
  if (target.agent_id === deps.callerAgentId) return { error: "self_poke_denied" };
  const callerRow = deps.db.prepare(`SELECT team FROM agents WHERE agent_id = ?`).get(deps.callerAgentId);
  if (!callerRow) return { error: "unknown_agent" };
  if (callerRow.team !== target.team && !deps.allowCrossTeam) {
    return { error: "cross_team_denied" };
  }
  const fanout = deps.channelWakeFanout;
  const delivery = parseDeliveryRow(target);
  if (!fanout) {
    if (delivery.kind === "codex-appserver" || delivery.kind === "opencode-server") {
      return dispatchPoke(
        { tmuxPoke: tmuxPokeImpl },
        { agent_type: target.agent_type, delivery, tmux_pane_id: target.tmux_pane_id },
        { content: input.prompt, meta: {}, skipGuard: input.skipGuard }
      );
    }
    if (!target.tmux_pane_id) return { error: "tmux_pane_not_set" };
    const tr = await tmuxPokeImpl({
      pane_id: target.tmux_pane_id,
      content: input.prompt,
      skipGuard: input.skipGuard
    });
    if ("ok" in tr && tr.ok) {
      return {
        ok: true,
        transport_used: "tmux-poke",
        pane_id: target.tmux_pane_id,
        pane_tail_before: tr.pane_tail_before,
        pane_tail_after: tr.pane_tail_after
      };
    }
    return { ...tr, transport_used: "tmux-poke" };
  }
  return dispatchPoke(
    { channelWakeFanout: fanout, tmuxPoke: tmuxPokeImpl },
    { agent_type: target.agent_type, delivery, tmux_pane_id: target.tmux_pane_id },
    { content: input.prompt, meta: {}, skipGuard: input.skipGuard }
  );
}

// src/daemon/errors.ts
var STORAGE_CODES = /* @__PURE__ */ new Set(["SQLITE_FULL", "SQLITE_BUSY", "SQLITE_IOERR", "SQLITE_LOCKED", "SQLITE_READONLY"]);
function isStorageError(err) {
  if (!err || typeof err !== "object") return false;
  const anyErr = err;
  if (anyErr.name === "SqliteError") return true;
  if (anyErr.code && STORAGE_CODES.has(anyErr.code)) return true;
  return false;
}
async function wrapStorage(fn) {
  try {
    return await fn();
  } catch (err) {
    if (isStorageError(err)) return { error: "storage_unavailable" };
    throw err;
  }
}

// src/mcp/subscribe-channel-wake.ts
var CHANNEL_PROXY_ROLE = "__channel_proxy__";
var SubscribeChannelWakeService = class {
  constructor(db, fanout) {
    this.db = db;
    this.fanout = fanout;
  }
  db;
  fanout;
  subscribe(input) {
    const csid = input.channel_session_id?.trim();
    if (!csid) return { error: "invalid_channel_session_id" };
    const row = this.db.prepare(`SELECT role FROM agents WHERE agent_id=?`).get(input.callerAgentId);
    if (!row) return { error: "unknown_agent" };
    if (row.role !== CHANNEL_PROXY_ROLE) return { error: "forbidden_role" };
    this.fanout.attach(csid, input.sink, input.sessionId);
    return { ok: true };
  }
};

// src/mcp/bind-channel.ts
var BindChannelService = class {
  constructor(db, fanout) {
    this.fanout = fanout;
    this.repo = new AgentsRepo(db);
  }
  fanout;
  repo;
  bind(input) {
    const csid = input.channel_session_id?.trim();
    if (!csid) return { error: "invalid_channel_session_id" };
    const caller = this.repo.getById(input.callerAgentId);
    if (!caller) return { error: "unknown_agent" };
    if (caller.role === CHANNEL_PROXY_ROLE) return { error: "forbidden_role" };
    if (!this.fanout.has(csid)) return { error: "unknown_channel_session" };
    this.repo.setAgentType(input.callerAgentId, "claude-code");
    this.repo.setDelivery(input.callerAgentId, {
      kind: "claude-channel",
      channel_session_id: csid
    });
    return { ok: true };
  }
};

// src/mcp/auto-bind-channel.ts
var LIVE_WINDOW_MS = 5 * 60 * 1e3;
var AutoBindChannelService = class {
  constructor(db, fanout) {
    this.db = db;
    this.fanout = fanout;
  }
  db;
  fanout;
  lookup(input) {
    return this.findLiveProxyCsid(input);
  }
  run(input) {
    const callerDevice = input.device !== void 0 ? { device: input.device } : this.db.prepare(
      `SELECT device FROM agents WHERE agent_id = ?`
    ).get(input.callerAgentId);
    const device = callerDevice?.device;
    if (!device) return { ok: false, reason: "no_proxy_row" };
    const found = this.findLiveProxyCsid({ ui_pid: input.ui_pid, device });
    if (!found.ok) return found;
    const csid = found.channel_session_id;
    if (!this.fanout.has(csid)) return { ok: false, reason: "sink_not_live" };
    this.db.prepare(
      `UPDATE agents
         SET delivery_kind = 'claude-channel',
             delivery_payload = json_object('channel_session_id', ?)
         WHERE agent_id = ?`
    ).run(csid, input.callerAgentId);
    return { ok: true, channel_session_id: csid };
  }
  findLiveProxyCsid(input) {
    const cutoff = new Date(Date.now() - LIVE_WINDOW_MS).toISOString();
    const row = this.db.prepare(
      `SELECT delivery_payload
         FROM agents
         WHERE role = ?
           AND device = ?
           AND claude_ui_pid = ?
           AND last_seen_at > ?
         ORDER BY last_seen_at DESC
         LIMIT 1`
    ).get(CHANNEL_PROXY_ROLE, input.device, input.ui_pid, cutoff);
    if (!row) return { ok: false, reason: "no_proxy_row" };
    const csid = extractCsid(row.delivery_payload);
    if (!csid) return { ok: false, reason: "proxy_payload_corrupt" };
    return { ok: true, channel_session_id: csid };
  }
};
function extractCsid(payload) {
  if (payload === null) return null;
  try {
    const parsed = JSON.parse(payload);
    const csid = parsed.channel_session_id;
    if (typeof csid !== "string" || csid.length === 0) return null;
    return csid;
  } catch {
    return null;
  }
}

// src/daemon/runtime-identity.ts
import { execFile as execFile2 } from "node:child_process";
import { promisify as promisify2 } from "node:util";
var TMUX_LIST_TIMEOUT_MS = 3e3;
var PS_LIST_TIMEOUT_MS = 3e3;
function normalizeTty(raw) {
  const value = raw?.trim();
  if (!value) return void 0;
  const normalized = value.replace(/^\/dev\//, "");
  if (!normalized || normalized === "?") return void 0;
  return normalized;
}
function commandPattern(args) {
  if (args.agent === "custom") {
    const raw = args.process_pattern?.trim();
    if (!raw) return null;
    return new RegExp(raw, "i");
  }
  if (args.agent === "codex") {
    return /(^|[\s/])(codex|codex-aarch64-a)([\s]|$)/i;
  }
  if (args.agent === "claude-code") {
    return /(^|[\s/])claude([\s]|$)/i;
  }
  return /(^|[\s/])opencode([\s]|$)/i;
}
async function listPanes(execLike) {
  const exec = promisify2(execLike);
  const { stdout } = await exec(
    "tmux",
    ["list-panes", "-a", "-F", "#{pane_id}	#{pane_tty}"],
    { timeout: TMUX_LIST_TIMEOUT_MS }
  );
  return stdout.split("\n").map((line) => line.trimEnd()).filter(Boolean).map((line) => {
    const [pane_id, pane_tty] = line.split("	");
    return {
      pane_id,
      tty: normalizeTty(pane_tty) ?? ""
    };
  });
}
async function readPidInfo(execLike, pid) {
  const exec = promisify2(execLike);
  try {
    const { stdout } = await exec(
      "ps",
      ["-p", String(pid), "-o", "tty=,command="],
      { timeout: PS_LIST_TIMEOUT_MS }
    );
    const line = stdout.split("\n").map((value) => value.trim()).find(Boolean);
    if (!line) return { found: false };
    const match = line.match(/^(\S+)\s+(.*)$/);
    if (!match) return { found: false };
    return {
      found: true,
      tty: normalizeTty(match[1]),
      command: match[2]?.trim()
    };
  } catch {
    return { found: false };
  }
}
async function ttyProcesses(execLike, tty) {
  const exec = promisify2(execLike);
  const { stdout } = await exec(
    "ps",
    ["-t", tty, "-o", "pid=,ppid=,stat=,command="],
    { timeout: PS_LIST_TIMEOUT_MS }
  );
  return stdout.split("\n").map((line) => line.trimEnd()).filter(Boolean);
}
function matchAgentProcess(agent, lines, pattern) {
  return lines.some((line) => {
    if (isHelperProcess(agent, line)) return false;
    return pattern.test(line);
  });
}
function isHelperProcess(agent, command) {
  if (agent !== "codex") return false;
  return /codex\s+app-server/i.test(command) || /Codex Computer Use\.app/i.test(command) || /SkyComputerUseClient/i.test(command);
}
async function bindRuntimeIdentity(input, deps = {}) {
  const execLike = deps.execFile ?? execFile2;
  const pattern = commandPattern(input);
  if (!pattern) return { error: "invalid_process_pattern" };
  let panes;
  try {
    panes = await listPanes(execLike);
  } catch (error) {
    return {
      error: "tmux_unavailable",
      detail: error instanceof Error ? error.message : String(error)
    };
  }
  if (input.ui_pid !== void 0) {
    if (!Number.isInteger(input.ui_pid) || input.ui_pid <= 0) {
      return { error: "invalid_ui_pid" };
    }
    const pidInfo = await readPidInfo(execLike, input.ui_pid);
    if (!pidInfo.found) return { error: "pid_not_found" };
    if (!pidInfo.command || isHelperProcess(input.agent, pidInfo.command) || !pattern.test(pidInfo.command)) {
      return { error: "agent_process_mismatch" };
    }
    if (!pidInfo.tty) return { error: "pid_has_no_tty" };
    const candidates = panes.filter((pane2) => pane2.tty === pidInfo.tty);
    if (candidates.length === 0) return { error: "tmux_pane_not_found" };
    if (candidates.length > 1) {
      return {
        error: "ambiguous_tty_match",
        candidates: candidates.map((candidate2) => ({
          pane_id: candidate2.pane_id,
          tty: candidate2.tty
        }))
      };
    }
    const candidate = candidates[0];
    const explicitPane = input.tmux_pane_id?.trim();
    if (explicitPane && explicitPane !== candidate.pane_id) {
      return {
        error: "pid_pane_tty_mismatch",
        detail: {
          pid_tty: pidInfo.tty,
          pane_tty: candidate.tty
        }
      };
    }
    return {
      ok: true,
      tmux_pane_id: candidate.pane_id,
      verification_mode: "verified_pid_tty_pane",
      tty: pidInfo.tty,
      ui_pid: input.ui_pid
    };
  }
  const tty = normalizeTty(input.ui_tty);
  const paneId = input.tmux_pane_id?.trim();
  if (!tty || !paneId) return { error: "invalid_runtime_identity" };
  const pane = panes.find((candidate) => candidate.pane_id === paneId);
  if (!pane) return { error: "tmux_pane_not_found" };
  if (pane.tty !== tty) {
    return {
      error: "pid_pane_tty_mismatch",
      detail: {
        pid_tty: tty,
        pane_tty: pane.tty
      }
    };
  }
  const processes = await ttyProcesses(execLike, tty);
  if (!matchAgentProcess(input.agent, processes, pattern)) {
    return { error: "tty_maps_to_no_agent_process" };
  }
  return {
    ok: true,
    tmux_pane_id: paneId,
    verification_mode: "verified_tty_pane",
    tty
  };
}

// src/mcp/bind-runtime-identity.ts
var BindRuntimeIdentityService = class {
  repo;
  constructor(db) {
    this.repo = new AgentsRepo(db);
  }
  async bind(input) {
    const caller = this.repo.getById(input.callerAgentId);
    if (!caller) return { error: "unknown_agent" };
    const result = await bindRuntimeIdentity(input);
    if (!("ok" in result) || !result.ok) return result;
    this.repo.setRuntimeBinding(input.callerAgentId, {
      tmux_pane_id: result.tmux_pane_id,
      runtime_ui_pid: result.ui_pid ?? null,
      runtime_tty: result.tty,
      runtime_verification_mode: result.verification_mode
    });
    return result;
  }
};

// src/mcp/register-codex-self.ts
var DEFAULT_CODEX_WS_URL = "ws://127.0.0.1:8799";
async function requestStep2(client, method, params, errorCode) {
  try {
    const response = await client.request(method, params);
    if (response.error) return { error: errorCode, detail: response.error };
    return { ok: response };
  } catch (error) {
    return { error: errorCode, detail: describeError(error) };
  }
}
function resolveWsUrl(input, env) {
  const explicit = input.ws_url?.trim();
  if (explicit) return explicit;
  const fromEnv = env.CROSS_AGENT_TEAMS_CODEX_WS_URL?.trim();
  if (fromEnv) return fromEnv;
  return DEFAULT_CODEX_WS_URL;
}
function extractThreadIds(response) {
  const result = response.result;
  if (!result || !Array.isArray(result.data)) return [];
  return result.data.filter((value) => typeof value === "string");
}
function trimToUndefined(value) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : void 0;
}
var RegisterCodexSelfService = class {
  constructor(registerSvc, deps = {}) {
    this.registerSvc = registerSvc;
    this.deps = deps;
  }
  registerSvc;
  deps;
  async register(input) {
    const env = this.deps.env ?? process.env;
    const wsUrl = resolveWsUrl(input, env);
    const token = resolveAuthToken(input.auth_token_ref, env);
    if ("error" in token) return token;
    const headers = token.ok === void 0 ? void 0 : { Authorization: `Bearer ${token.ok}` };
    let ws;
    try {
      ws = (this.deps.webSocketFactory ?? defaultWebSocketFactory)({
        url: wsUrl,
        headers
      });
    } catch (error) {
      return {
        error: "unsupported_client",
        detail: {
          expected: "codex",
          reason: "codex_appserver_unreachable",
          ws_url: wsUrl,
          cause: describeError(error)
        }
      };
    }
    const client = new JsonRpcSocketClient(ws);
    try {
      await client.waitForOpen();
      const init = await requestStep2(
        client,
        "initialize",
        {
          clientInfo: {
            name: "cross-agent-teams-mcp",
            title: null,
            version: "0.1.0"
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: null
          }
        },
        "codex_initialize_failed"
      );
      if ("error" in init) {
        return {
          error: "unsupported_client",
          detail: {
            expected: "codex",
            reason: "codex_protocol_unavailable",
            ws_url: wsUrl,
            cause: init.detail
          }
        };
      }
      client.notify("initialized");
      const explicitThreadId = trimToUndefined(input.thread_id);
      let threadId = explicitThreadId;
      if (!threadId) {
        const list = await requestStep2(
          client,
          "thread/loaded/list",
          { cursor: null, limit: 20 },
          "codex_loaded_list_failed"
        );
        if ("error" in list) return list;
        const threadIds = extractThreadIds(list.ok);
        if (threadIds.length === 0) {
          return {
            error: "no_loaded_threads",
            detail: { ws_url: wsUrl }
          };
        }
        const liveThreadIds = [];
        const failures = [];
        for (const candidateThreadId of threadIds) {
          const resume2 = await requestStep2(
            client,
            "thread/resume",
            {
              threadId: candidateThreadId,
              persistExtendedHistory: false
            },
            "codex_resume_failed"
          );
          if ("error" in resume2) {
            failures.push({ thread_id: candidateThreadId, detail: resume2.detail });
            continue;
          }
          liveThreadIds.push(candidateThreadId);
        }
        if (liveThreadIds.length === 0) {
          return {
            error: "codex_resume_failed",
            detail: failures
          };
        }
        return {
          error: "thread_id_required",
          detail: {
            ws_url: wsUrl,
            thread_ids: liveThreadIds
          }
        };
      }
      const resume = await requestStep2(
        client,
        "thread/resume",
        {
          threadId,
          persistExtendedHistory: false
        },
        "codex_resume_failed"
      );
      if ("error" in resume) {
        return {
          error: "codex_resume_failed",
          detail: { thread_id: threadId, cause: resume.detail }
        };
      }
      const tmuxPaneId = trimToUndefined(input.tmux_pane_id);
      const result = this.registerSvc.register({
        connection_id: input.connection_id,
        agent_type: "codex",
        model: input.model ?? "codex",
        device: input.device,
        name: input.name,
        role: input.role,
        team: input.team,
        project_dir: input.project_dir,
        tmux_pane_id: tmuxPaneId,
        delivery: {
          kind: "codex-appserver",
          thread_id: threadId,
          ws_url: wsUrl,
          ...input.auth_token_ref === void 0 ? {} : { auth_token_ref: input.auth_token_ref }
        }
      });
      if ("error" in result) return result;
      return {
        ...result,
        thread_id: threadId,
        ws_url: wsUrl
      };
    } catch (error) {
      return {
        error: "unsupported_client",
        detail: {
          expected: "codex",
          reason: "codex_appserver_unreachable",
          ws_url: wsUrl,
          cause: describeError(error)
        }
      };
    } finally {
      safeClose(ws);
    }
  }
};

// src/mcp/register-opencode-self.ts
function trimToUndefined2(value) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : void 0;
}
function updatedOf(entry) {
  if (!entry) return void 0;
  if (typeof entry.time_updated === "number") return entry.time_updated;
  const nested = entry.time?.updated;
  if (typeof nested === "number") return nested;
  return void 0;
}
function normalizeBaseUrl(baseUrl) {
  return baseUrl.replace(/\/+$/, "");
}
var RegisterOpencodeSelfService = class {
  constructor(registerSvc, deps = {}) {
    this.registerSvc = registerSvc;
    this.deps = deps;
  }
  registerSvc;
  deps;
  async register(input) {
    const fetchImpl = this.deps.fetch ?? globalThis.fetch;
    const baseUrl = normalizeBaseUrl(input.base_url);
    let healthOk = false;
    let healthError = "";
    try {
      const healthRes = await fetchImpl(`${baseUrl}/global/health`, { method: "GET" });
      if (healthRes.ok) {
        healthOk = true;
      } else {
        healthError = `health check HTTP ${healthRes.status}`;
      }
    } catch (error) {
      healthError = describeError(error);
    }
    if (!healthOk) {
      return {
        error: "opencode_unreachable",
        detail: { base_url: input.base_url, cause: healthError }
      };
    }
    let sessionId = trimToUndefined2(input.session_id);
    if (!sessionId) {
      let sessions = [];
      try {
        const listRes = await fetchImpl(`${baseUrl}/session`, { method: "GET" });
        if (listRes.ok) {
          const body = await listRes.json();
          if (Array.isArray(body)) {
            sessions = body;
          } else if (body && typeof body === "object") {
            const maybeArr = body.data;
            if (Array.isArray(maybeArr)) {
              sessions = maybeArr;
            }
          }
        }
      } catch (error) {
        return {
          error: "opencode_unreachable",
          detail: { base_url: input.base_url, cause: describeError(error) }
        };
      }
      const candidates = sessions.filter(
        (entry) => typeof entry?.id === "string" && updatedOf(entry) !== void 0
      ).sort((a, b) => (updatedOf(b) ?? 0) - (updatedOf(a) ?? 0));
      if (candidates.length === 0) {
        return {
          error: "no_active_session",
          detail: { base_url: input.base_url }
        };
      }
      sessionId = candidates[0].id;
    }
    const result = this.registerSvc.register({
      connection_id: input.connection_id,
      agent_type: "opencode",
      model: input.model,
      device: input.device,
      name: input.name,
      role: input.role,
      team: input.team,
      project_dir: input.project_dir,
      delivery: {
        kind: "opencode-server",
        session_id: sessionId,
        base_url: input.base_url,
        ...input.auth_token_ref === void 0 ? {} : { auth_token_ref: input.auth_token_ref }
      }
    });
    if ("error" in result) return result;
    return {
      ...result,
      session_id: sessionId,
      base_url: input.base_url
    };
  }
};

// src/mcp/reconnect.ts
function toCandidate(row) {
  return {
    agent_id: row.agent_id,
    device: row.device,
    team: row.team,
    name: row.name,
    role: row.role,
    last_seen_at: row.last_seen_at
  };
}
function resolveReconnect(repo, ui_pid, localDevice) {
  const rows = repo.findByRuntimeUiPid(ui_pid, localDevice);
  if (rows.length === 0) {
    return {
      kind: "need_register",
      reason: `No local agent is registered for ui_pid ${ui_pid}. There is no prior identity to reconnect; call register_agent to register a new identity.`
    };
  }
  if (rows.length === 1) {
    return { kind: "single", match: toCandidate(rows[0]) };
  }
  return { kind: "ambiguous", candidates: rows.map(toCandidate) };
}

// src/mcp/unregister-self.ts
var UnregisterSelfService = class {
  constructor(db, agents) {
    this.db = db;
    this.agents = agents;
  }
  db;
  agents;
  unregister(args) {
    const caller = this.agents.findById(args.caller);
    if (!caller) return { error: "unknown_agent" };
    let removed = false;
    const tx = this.db.transaction(() => {
      removed = this.agents.deleteById(caller.agent_id);
    });
    tx();
    if (!removed) return { error: "unknown_agent" };
    return {
      ok: true,
      team: caller.team,
      name: caller.name,
      agent_id: caller.agent_id
    };
  }
};

// src/mcp/agent-public-row.ts
function projectDelivery(delivery) {
  if (delivery.kind === "claude-channel") {
    return {
      kind: "claude-channel",
      channel_session_id: delivery.channel_session_id
    };
  }
  return { kind: delivery.kind };
}
function toPublicAgentRow(row) {
  return {
    agent_id: row.agent_id,
    agent_type: row.agent_type,
    agent_type_name: row.agent_type_name,
    device: row.device,
    team: row.team,
    role: row.role,
    name: row.name,
    model: row.model,
    tmux_pane_id: row.tmux_pane_id,
    delivery: projectDelivery(row.delivery),
    channel_session_id: row.delivery.kind === "claude-channel" ? row.delivery.channel_session_id : null,
    last_seen_at: row.last_seen_at,
    online: row.online
  };
}

// src/mcp/list-agents.ts
function listAgentsForTeam(db, team, ttlMs) {
  const agents = new AgentsRepo(db);
  return {
    agents: agents.list({
      team,
      excludeRoles: ["__channel_proxy__"],
      ttlMs: ttlMs ?? REACHABLE_MS_DEFAULT
    }).map(toPublicAgentRow)
  };
}

// src/daemon/tmux-pane-detect.ts
import { execFile as execFile4 } from "node:child_process";
import { normalize, sep } from "node:path";
import { promisify as promisify4 } from "node:util";

// src/daemon/tmux-pane-list.ts
import { execFile as execFile3 } from "node:child_process";
import { promisify as promisify3 } from "node:util";
var TMUX_LIST_TIMEOUT_MS2 = 3e3;
function normalizeTty2(raw) {
  const value = raw?.trim();
  if (!value) return void 0;
  return value.replace(/^\/dev\//, "");
}
function parsePaneRows(stdout) {
  return stdout.split("\n").map((line) => line.trimEnd()).filter(Boolean).map((line) => {
    const [
      pane_id,
      session_name,
      window_index,
      pane_index,
      pane_active,
      pane_tty,
      pane_current_path,
      pane_current_command,
      pane_title
    ] = line.split("	");
    return {
      pane_id,
      session_name,
      window_index: Number(window_index),
      pane_index: Number(pane_index),
      active: pane_active === "1",
      tty: normalizeTty2(pane_tty) ?? "",
      current_path: pane_current_path ?? "",
      current_command: pane_current_command ?? "",
      title: pane_title ?? ""
    };
  });
}
async function listTmuxPaneRows(execLike = execFile3) {
  const exec = promisify3(execLike);
  const { stdout } = await exec(
    "tmux",
    [
      "list-panes",
      "-a",
      "-F",
      "#{pane_id}	#{session_name}	#{window_index}	#{pane_index}	#{pane_active}	#{pane_tty}	#{pane_current_path}	#{pane_current_command}	#{pane_title}"
    ],
    { timeout: TMUX_LIST_TIMEOUT_MS2 }
  );
  return parsePaneRows(stdout);
}

// src/daemon/tmux-pane-detect.ts
var PS_LIST_TIMEOUT_MS2 = 3e3;
function normalizeTty3(raw) {
  const value = raw?.trim();
  if (!value) return void 0;
  return value.replace(/^\/dev\//, "");
}
function normalizePath(raw) {
  const value = raw?.trim();
  if (!value) return void 0;
  return normalize(value);
}
function pathRelated(candidatePath, inputPath) {
  const candidate = normalize(candidatePath);
  const input = normalize(inputPath);
  if (candidate === input) return "exact";
  if (candidate.startsWith(`${input}${sep}`)) return "descendant";
  if (input.startsWith(`${candidate}${sep}`)) return "ancestor";
  return "none";
}
function commandPattern2(args) {
  if (args.agent === "custom") {
    const raw = args.process_pattern?.trim();
    if (!raw) throw new Error("process_pattern is required when agent=custom");
    return new RegExp(raw, "i");
  }
  if (args.agent === "codex") {
    return /(^|[\s/])(codex|codex-aarch64-a)([\s]|$)/i;
  }
  if (args.agent === "claude-code") {
    return /(^|[\s/])claude([\s]|$)/i;
  }
  return /(^|[\s/])opencode([\s]|$)/i;
}
function commandHintScore(agent, command) {
  if (agent === "codex" && /codex/i.test(command)) return 6;
  if (agent === "opencode" && /opencode/i.test(command)) return 6;
  if (agent === "claude-code" && /^(\d+\.)+\d+$/.test(command)) return 4;
  return 0;
}
function isHelperProcess2(agent, command) {
  if (agent !== "codex") return false;
  return /codex\s+app-server/i.test(command) || /Codex Computer Use\.app/i.test(command) || /SkyComputerUseClient/i.test(command);
}
async function ttyProcesses2(execLike, tty) {
  const exec = promisify4(execLike);
  const { stdout } = await exec(
    "ps",
    ["-t", tty, "-o", "pid=,ppid=,stat=,command="],
    { timeout: PS_LIST_TIMEOUT_MS2 }
  );
  return stdout.split("\n").map((line) => line.trimEnd()).filter(Boolean);
}
function collectCandidates(panes, ttyMap, input) {
  const ttyFilter = normalizeTty3(input.tty);
  const cwdFilter = normalizePath(input.cwd);
  const titleFilter = input.title_contains?.trim().toLowerCase();
  const pattern = commandPattern2(input);
  const candidates = [];
  for (const pane of panes) {
    if (ttyFilter && pane.tty !== ttyFilter) continue;
    if (cwdFilter) {
      const relation = pathRelated(pane.current_path, cwdFilter);
      if (relation === "none") continue;
    }
    if (titleFilter && !pane.title.toLowerCase().includes(titleFilter)) continue;
    const matched_processes = (ttyMap.get(pane.tty) ?? []).filter((line) => {
      if (isHelperProcess2(input.agent, line)) return false;
      return pattern.test(line);
    });
    if (matched_processes.length === 0) continue;
    let score = matched_processes.length * 10;
    if (pane.active) score += 3;
    score += commandHintScore(input.agent, pane.current_command);
    if (ttyFilter) score += 100;
    if (cwdFilter) {
      const relation = pathRelated(pane.current_path, cwdFilter);
      if (relation === "exact") score += 60;
      else if (relation === "descendant") score += 45;
      else if (relation === "ancestor") score += 30;
    }
    if (titleFilter) score += 15;
    candidates.push({
      pane_id: pane.pane_id,
      session_name: pane.session_name,
      window_index: pane.window_index,
      pane_index: pane.pane_index,
      active: pane.active,
      tty: pane.tty,
      current_path: pane.current_path,
      current_command: pane.current_command,
      title: pane.title,
      matched_processes,
      score
    });
  }
  return candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.pane_id < b.pane_id) return -1;
    if (a.pane_id > b.pane_id) return 1;
    return 0;
  });
}
async function detectTmuxPane(input, deps = {}) {
  const execLike = deps.execFile ?? execFile4;
  let panes;
  try {
    panes = await listTmuxPaneRows(execLike);
  } catch (error) {
    return {
      error: "tmux_unavailable",
      detail: error instanceof Error ? error.message : String(error)
    };
  }
  const ttyMap = /* @__PURE__ */ new Map();
  for (const pane of panes) {
    if (!pane.tty || ttyMap.has(pane.tty)) continue;
    try {
      ttyMap.set(pane.tty, await ttyProcesses2(execLike, pane.tty));
    } catch {
      ttyMap.set(pane.tty, []);
    }
  }
  let candidates;
  try {
    candidates = collectCandidates(panes, ttyMap, input);
  } catch (error) {
    return {
      error: "not_found",
      candidates: []
    };
  }
  if (candidates.length === 0) return { error: "not_found", candidates: [] };
  const topScore = candidates[0].score;
  const top = candidates.filter((candidate) => candidate.score === topScore);
  if (top.length > 1) {
    return {
      error: "ambiguous_match",
      candidates
    };
  }
  return {
    ok: true,
    pane: candidates[0],
    candidates
  };
}

// src/mcp/codex-pane-pre-register-repo.ts
var CodexPanePreRegRepo = class {
  constructor(db) {
    this.db = db;
  }
  db;
  upsert(input) {
    this.db.prepare(
      `INSERT INTO codex_pane_pre_registrations (pane_id, xats_agent_id, expires_at)
         VALUES (?, ?, ?)
         ON CONFLICT(pane_id) DO UPDATE SET
           xats_agent_id = excluded.xats_agent_id,
           expires_at = excluded.expires_at`
    ).run(input.pane_id, input.xats_agent_id, input.expires_at);
  }
  listUnexpired(now) {
    return this.db.prepare(
      `SELECT pane_id, xats_agent_id, expires_at
         FROM codex_pane_pre_registrations
         WHERE expires_at > ?`
    ).all(now);
  }
  takeByPaneId(pane_id) {
    const row = this.db.prepare(
      `DELETE FROM codex_pane_pre_registrations
         WHERE pane_id = ?
         RETURNING pane_id, xats_agent_id, expires_at`
    ).get(pane_id);
    return row;
  }
  deleteExpired(now) {
    const res = this.db.prepare(`DELETE FROM codex_pane_pre_registrations WHERE expires_at <= ?`).run(now);
    return res.changes;
  }
};

// src/mcp/pre-register-codex-pane.ts
import { z as z2 } from "zod";
var preRegisterCodexPaneInputSchema = z2.object({
  pane_id: z2.string().min(1).refine((v) => v.startsWith("%"), {
    message: 'pane_id must be a tmux pane id starting with "%"'
  }),
  xats_agent_id: z2.string().min(1),
  ttl_seconds: z2.number().int().positive().optional()
}).strict();
var DEFAULT_TTL_SECONDS = 120;
var MIN_TTL_SECONDS = 1;
var MAX_TTL_SECONDS = 600;
function clampTtl(ttl) {
  const raw = ttl ?? DEFAULT_TTL_SECONDS;
  if (raw < MIN_TTL_SECONDS) return MIN_TTL_SECONDS;
  if (raw > MAX_TTL_SECONDS) return MAX_TTL_SECONDS;
  return raw;
}
var PreRegisterCodexPaneService = class {
  constructor(repo, now = () => /* @__PURE__ */ new Date()) {
    this.repo = repo;
    this.now = now;
  }
  repo;
  now;
  register(args) {
    const parsed = preRegisterCodexPaneInputSchema.safeParse(args);
    if (!parsed.success) {
      return {
        error: "invalid_arguments",
        detail: parsed.error.issues.map((issue) => {
          const path = issue.path.join(".");
          return path ? `${path}: ${issue.message}` : issue.message;
        }).join("; ")
      };
    }
    const now = this.now();
    const ttl = clampTtl(parsed.data.ttl_seconds);
    const expires_at = new Date(now.getTime() + ttl * 1e3).toISOString();
    this.repo.deleteExpired(now.toISOString());
    this.repo.upsert({
      pane_id: parsed.data.pane_id,
      xats_agent_id: parsed.data.xats_agent_id,
      expires_at
    });
    return { ok: true, expires_at };
  }
};

// src/mcp/auto-bind-codex-pane.ts
import { execFile as execFile5 } from "node:child_process";
import { promisify as promisify5 } from "node:util";
var TMUX_LIST_TIMEOUT_MS3 = 3e3;
var PS_LIST_TIMEOUT_MS3 = 3e3;
function normalizeTty4(raw) {
  const value = raw?.trim();
  if (!value) return void 0;
  const normalized = value.replace(/^\/dev\//, "");
  if (!normalized || normalized === "?") return void 0;
  return normalized;
}
async function defaultListPanes() {
  const exec = promisify5(execFile5);
  const { stdout } = await exec(
    "tmux",
    ["list-panes", "-a", "-F", "#{pane_id}	#{pane_tty}"],
    { timeout: TMUX_LIST_TIMEOUT_MS3 }
  );
  return stdout.split("\n").map((line) => line.trimEnd()).filter(Boolean).map((line) => {
    const [pane_id, pane_tty] = line.split("	");
    return {
      pane_id,
      tty: normalizeTty4(pane_tty) ?? ""
    };
  });
}
async function defaultTtyProcesses(tty) {
  const exec = promisify5(execFile5);
  const { stdout } = await exec(
    "ps",
    ["-t", tty, "-o", "pid=,ppid=,stat=,command="],
    { timeout: PS_LIST_TIMEOUT_MS3 }
  );
  return stdout.split("\n").map((line) => line.trimEnd()).filter(Boolean);
}
function parsePid(line) {
  const match = line.trim().match(/^(\d+)\s/);
  if (!match) return void 0;
  const pid = Number(match[1]);
  if (!Number.isInteger(pid) || pid <= 0) return void 0;
  return pid;
}
function isCodexRemoteProcess(line) {
  if (!/codex/i.test(line)) return false;
  if (/codex\s+app-server/i.test(line)) return false;
  return /codex(?:-aarch64-a)?\s+.*--remote/i.test(line) || /codex(?:-aarch64-a)?\s+--remote/i.test(line);
}
function argvContainsUuid(line, uuid) {
  return line.includes(`xats.agent_id="${uuid}"`);
}
var __testOverrides = {};
async function autoBindCodexPane(input, deps = {}) {
  const listPanes2 = deps.listPanes ?? __testOverrides.listPanes ?? defaultListPanes;
  const ttyProcesses3 = deps.ttyProcesses ?? __testOverrides.ttyProcesses ?? defaultTtyProcesses;
  const now = deps.now ?? __testOverrides.now ?? (() => /* @__PURE__ */ new Date());
  try {
    const nowIso = now().toISOString();
    input.repo.deleteExpired(nowIso);
    const pending = input.repo.listUnexpired(nowIso);
    if (pending.length === 0) return false;
    let panes;
    try {
      panes = await listPanes2();
    } catch {
      return false;
    }
    const paneIndex = /* @__PURE__ */ new Map();
    for (const pane of panes) {
      if (pane.pane_id) paneIndex.set(pane.pane_id, pane);
    }
    const ttyProcessCache = /* @__PURE__ */ new Map();
    const candidates = [];
    for (const row of pending) {
      const pane = paneIndex.get(row.pane_id);
      if (!pane || !pane.tty) continue;
      let procs = ttyProcessCache.get(pane.tty);
      if (procs === void 0) {
        try {
          procs = await ttyProcesses3(pane.tty);
        } catch {
          procs = [];
        }
        ttyProcessCache.set(pane.tty, procs);
      }
      const matching = procs.filter(
        (line) => isCodexRemoteProcess(line) && argvContainsUuid(line, row.xats_agent_id)
      );
      if (matching.length !== 1) continue;
      const pid = parsePid(matching[0]);
      if (pid === void 0) continue;
      candidates.push({ row, pane_id: pane.pane_id, ui_pid: pid });
    }
    if (candidates.length !== 1) return false;
    const chosen = candidates[0];
    const bindResult = await input.bindRuntimeIdentitySvc.bind({
      callerAgentId: input.callerAgentId,
      agent: "codex",
      ui_pid: chosen.ui_pid
    });
    if (!("ok" in bindResult) || !bindResult.ok) return false;
    input.repo.takeByPaneId(chosen.pane_id);
    return true;
  } catch {
    return false;
  }
}

// src/mcp/tools.ts
function toText(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}
var deliverySchema = z3.object({
  kind: z3.string()
}).passthrough();
var agentTypeSchema = z3.enum(["codex", "claude-code", "opencode", "custom"]);
var detectTmuxPaneSchema = z3.object({
  agent: z3.enum(["codex", "claude-code", "opencode", "custom"]),
  cwd: z3.string().optional(),
  tty: z3.string().optional(),
  title_contains: z3.string().optional(),
  process_pattern: z3.string().optional()
});
var detectTmuxPaneArgsSchema = detectTmuxPaneSchema.superRefine((value, ctx) => {
  if (value.agent === "custom" && (!value.process_pattern || value.process_pattern.trim().length === 0)) {
    ctx.addIssue({
      code: z3.ZodIssueCode.custom,
      path: ["process_pattern"],
      message: "process_pattern is required when agent=custom"
    });
  }
});
var bindRuntimeIdentitySchema = z3.object({
  agent: z3.enum(["codex", "claude-code", "opencode", "custom"]),
  ui_pid: z3.number().int().positive().optional(),
  ui_tty: z3.string().optional(),
  tmux_pane_id: z3.string().min(1).optional(),
  process_pattern: z3.string().optional()
});
var bindRuntimeIdentityArgsSchema = bindRuntimeIdentitySchema.superRefine((value, ctx) => {
  if (value.agent === "custom" && (!value.process_pattern || value.process_pattern.trim().length === 0)) {
    ctx.addIssue({
      code: z3.ZodIssueCode.custom,
      path: ["process_pattern"],
      message: "process_pattern is required when agent=custom"
    });
  }
  const hasPid = value.ui_pid !== void 0;
  const hasTtyPair = value.ui_tty !== void 0 && value.ui_tty.trim().length > 0 && value.tmux_pane_id !== void 0 && value.tmux_pane_id.trim().length > 0;
  if (!hasPid && !hasTtyPair) {
    ctx.addIssue({
      code: z3.ZodIssueCode.custom,
      message: "provide ui_pid, or ui_tty together with tmux_pane_id"
    });
  }
});
var SEND_MESSAGE_DESC = [
  "Private 1\u21921 message to another agent by name.  By default auto-poke=true with quiet-guard (auto_poke:false opts out), and need_reply=true.",
  "Set need_reply:false for FYI/no-response-needed messages; recipients see need_reply in get_inbox.",
  "to_agent_name is the target's `name` within its team; bare names resolve on the caller's device, and `name:device` targets a specific device.  For UUID-based sends use send_message_by_id.",
  "If the user refers to a recipient in the shorthand `name(team)` (e.g. `skills-creator(default)`), split it into `to_agent_name`=`skills-creator` and `to_team`=`default`. The daemon does NOT parse `name(team)`, so the literal string fails to resolve (unknown_recipient). This is distinct from the `name:device` suffix, which the daemon DOES parse.",
  'REPLY RULE: when replying to a message returned by get_inbox, treat its `from_device` as authoritative \u2014 if it differs from your own device, you MUST send to `from_name + ":" + from_device` (bare `from_name` would resolve on YOUR device and miss the actual sender). Same-device replies can use the bare name. The safe fallback for unknown device is send_message_by_id({to_agent_id: from_agent_id, ...}).',
  "For multi-recipient use broadcast (same-team) or broadcast_to_role (same-team, by role).",
  "\u9664\u975E\u7528\u6237\u660E\u786E\u6307\u5B9A to_team, \u4E0D\u8981\u8DE8 team \u6C9F\u901A (explicitly set to_team only when user asks).",
  "Reports poked, poke_skip_reasons (no_pane, guard_failed, tmux_unavailable, self); on guard_failed daemon retries at 30s/180s/600s (retry_scheduled, retry_delays_s); stops early on poked.",
  "Auto-poke injects only a SHORT wake-up hint (\u65B0\u90AE\u4EF6 from <sender>, \u8BF7\u8C03 get_inbox \u67E5\u770B), NOT the body \u2014 read bodies via get_inbox.",
  "Delivery is NOT filtered by online/idle; direct and fan-out deliveries write mailbox rows for offline targets. The list_agents `online` flag reflects process liveness.",
  'DO NOT pre-verify the recipient via list_agents before calling send_message \u2014 this rule applies to BOTH same-team and cross-team sends (list_agents is caller-team scoped and CANNOT see cross-team agents, so a cross-team pre-check always falsely reports "missing"; for same-team sends the pre-check is pure waste).',
  'On miss send_message returns unknown_recipient cleanly with no side effects, so the correct pattern is "try send, then handle unknown_recipient" \u2014 never "list_agents first, then send".'
].join(" ");
var SEND_MESSAGE_BY_ID_DESC = [
  "Private 1\u21921 message to another agent by agent_id (UUID).  Use this when you already hold the target's agent_id; prefer send_message (by name) otherwise.",
  "Same-team only: the recipient must belong to the caller's team.  For cross-team sends use send_message with to_team.",
  "By default auto-poke=true with quiet-guard (auto_poke:false opts out), and need_reply=true.  Set need_reply:false for FYI/no-response-needed messages.",
  "Reports poked, poke_skip_reasons (no_pane, guard_failed, tmux_unavailable, self); on guard_failed daemon retries at 30s/180s/600s (retry_scheduled, retry_delays_s); stops early on poked.",
  "Auto-poke injects only a SHORT wake-up hint (\u65B0\u90AE\u4EF6 from <sender>, \u8BF7\u8C03 get_inbox \u67E5\u770B), NOT the body \u2014 read bodies via get_inbox.",
  "Delivery is NOT filtered by online/idle \u2014 offline targets still receive the mailbox row."
].join(" ");
var BROADCAST_DESC = [
  "Same-team broadcast to every other agent in the caller team across all devices; delivers to every team member except the sender.",
  "Auto-poke default true (quiet-guard + 30s/180s/600s retry; reports poked, poke_skip_reasons, retry_scheduled, retry_delays_s).  auto_poke:false opts out.",
  "For role filter use broadcast_to_role.  For cross-team 1\u21921 use send_message({to_team}).",
  "Auto-poke injects only a SHORT wake-up hint (\u65B0\u90AE\u4EF6 from <sender>, \u8BF7\u8C03 get_inbox \u67E5\u770B) \u2014 never the body.  Read via get_inbox.",
  "Delivery is NOT filtered by online/idle; offline targets still receive mailbox rows. The list_agents `online` flag reflects process liveness."
].join(" ");
var BROADCAST_TO_ROLE_DESC = [
  "Same-team broadcast filtered by role across all devices; delivers to every matching team member.  Strictly same-team \u2014 no cross-team variant.",
  "For cross-team private 1\u21921 use send_message({to_team}).",
  "Auto-poke default true with quiet-guard + 30s/180s/600s retry (auto_poke:false opts out); injects only a SHORT wake-up hint, not the message body.  Recipients read via get_inbox.",
  "Returns unknown_recipient when no same-team agent matches to_role."
].join(" ");
var RECONNECT_DESC = [
  "Recover this session's prior xats identity when you no longer remember your own (team, name) \u2014 for example after a context clear, where the Claude UI process ($PPID) is unchanged but the MCP/channel session is fresh and bind_channel returns unknown_agent. Prefer this over the bind_channel\u2192register_agent fallback for re-establishing on a fresh session: it re-establishes the identity AND rebinds the channel in one call.",
  "Route by whether you still remember your (team, name): if you DO remember it after a restart + resume (you closed Claude Code and resumed the conversation, so $PPID has CHANGED but the context survived), call register_agent with that remembered (team, name) and the current $PPID instead of reconnect \u2014 reconnect would reverse-look-up the changed $PPID, find no match, and return need_register. Use reconnect only when you do NOT remember your (team, name).",
  'Invoke this when the user asks to "reconnect xats", "re-register xats", "\u91CD\u8FDE xats", or "\u91CD\u65B0\u6CE8\u518C xats".',
  "`ui_pid` is the Claude UI process id \u2014 pass `$PPID` from a Bash tool call inside Claude Code (the same value register_agent takes as `ui_pid`).",
  "The daemon reverse-looks-up the most recent local claude-code agent row whose runtime_ui_pid matches `ui_pid`, then re-establishes that identity (cross-session takeover + channel/pane auto-bind) reusing the existing agent_id.",
  "On a single match: returns { ok, agent_id, name, team, channel_session_id, last_seen_at }.",
  "On zero matches: returns { need_register, reason } \u2014 reconnect does NOT auto-register; call register_agent to create a new identity.",
  "On multiple matches (e.g. the same UI process previously registered under two names): returns { ambiguous, candidates } ordered by last_seen_at descending \u2014 surface them so the user can pick, then register_agent with the chosen name.",
  "Each candidate/match carries last_seen_at; if it looks stale the matched ui_pid may have been reused by an unrelated process \u2014 surface it to the user before trusting the recovered identity.",
  "Scope is the daemon's configured local device label for claude-code only; codex (thread_id-based) reconnect is out of scope."
].join(" ");
function suppressTmuxHint(args) {
  return args.delivery?.kind !== void 0 && args.delivery.kind !== "none";
}
function defaultClaudeSelfModel(clientInfo) {
  const raw = `${clientInfo?.name ?? ""} ${clientInfo?.version ?? ""}`.trim();
  if (/claude/i.test(raw)) return raw;
  return "claude-code";
}
function buildAutoPokeHint(row, fromAgentId) {
  const dn = row?.name;
  const sender = typeof dn === "string" && dn.length > 0 ? `${dn} (${fromAgentId})` : fromAgentId.slice(0, 8);
  return `\u65B0\u90AE\u4EF6 from ${sender}, \u8BF7\u8C03 get_inbox \u67E5\u770B`;
}
function createAutoPokeImpl(db, _agents, channelWakeFanout) {
  return async (args) => {
    const row = db.prepare("SELECT name FROM agents WHERE agent_id=?").get(args.fromAgentId);
    const hint = buildAutoPokeHint(row, args.fromAgentId);
    const res = await poke(
      { db, callerAgentId: args.fromAgentId, allowCrossTeam: true, channelWakeFanout },
      { target_agent_id: args.targetAgentId, prompt: hint, skipGuard: args.skipGuard }
    );
    if ("ok" in res && res.ok) return { ok: true };
    const err = res.error;
    if (err === "tmux_unavailable") return { ok: false, reason: "tmux_unavailable" };
    if (err === "tmux_pane_not_set") return { ok: false, reason: "no_pane" };
    if (err === "no_transport_available") return { ok: false, reason: "no_pane" };
    if (err === "self_poke_denied") return { ok: false, reason: "self" };
    return { ok: false, reason: "guard_failed" };
  };
}
function inferRuntimeAgentKind(args, clientInfo) {
  if (args.agent_type === "custom") return void 0;
  if (args.agent_type) return args.agent_type;
  if (args.delivery?.kind === "codex-appserver") return "codex";
  const raw = `${clientInfo?.name ?? ""} ${clientInfo?.version ?? ""} ${args.model ?? ""}`.toLowerCase();
  if (raw.includes("codex")) return "codex";
  if (raw.includes("gpt-")) return "codex";
  if (raw.includes("claude")) return "claude-code";
  if (raw.includes("opus") || raw.includes("sonnet")) return "claude-code";
  if (raw.includes("opencode")) return "opencode";
  return void 0;
}
function registerBusinessTools(server, db, getCallerAgentId, fanout, onRegisterSuccess, getSessionId, channelWakeFanout, getTransport, getSessionClientInfo, getSessionOriginInfo, context, onUnregisterSuccess, injectedRegisterSvc) {
  const agents = new AgentsRepo(db);
  const events = new EventsOutbox(db);
  const registerSvc = injectedRegisterSvc ?? new RegisterAgentService(db, {
    localDevice: context?.localDevice,
    getSessionOrigin: () => getSessionOriginInfo?.()
  });
  const bindRuntimeIdentitySvc = new BindRuntimeIdentityService(db);
  const registerCodexSelfSvc = new RegisterCodexSelfService(registerSvc);
  const registerOpencodeSelfSvc = new RegisterOpencodeSelfService(registerSvc);
  const unregisterSelfSvc = new UnregisterSelfService(db, agents);
  const autoPokeImpl = createAutoPokeImpl(db, agents, channelWakeFanout);
  const sendSvc = new SendMessageService(db, agents, events, { poke: autoPokeImpl });
  const broadcastSvc = new BroadcastService(db, agents, { poke: autoPokeImpl });
  const broadcastToRoleSvc = new BroadcastToRoleService(db, agents, events, { poke: autoPokeImpl });
  const inboxSvc = new GetInboxService(db, agents);
  const deliveryStatusSvc = new GetDeliveryStatusService(db);
  const codexPanePreRegRepo = new CodexPanePreRegRepo(db);
  const preRegisterCodexPaneSvc = new PreRegisterCodexPaneService(codexPanePreRegRepo);
  function caller() {
    return getCallerAgentId();
  }
  async function run(fn) {
    const out = await wrapStorage(() => fn());
    touchIfRegistered();
    return toText(out);
  }
  function touchIfRegistered() {
    const c = caller();
    if (!c) return;
    try {
      if (agents.findById(c)) agents.touch(c);
    } catch {
    }
  }
  function requireAgent() {
    const c = caller();
    if (!c) return { error: "unknown_agent" };
    const row = agents.findById(c);
    if (!row) return { error: "unknown_agent" };
    return c;
  }
  async function autoBindRuntimeIdentity(args, callerAgentId) {
    const inferredAgent = inferRuntimeAgentKind(args, getSessionClientInfo?.());
    if (!inferredAgent) return false;
    if (args.ui_pid !== void 0) {
      const boundByPid = await bindRuntimeIdentitySvc.bind({
        callerAgentId,
        agent: inferredAgent,
        ui_pid: args.ui_pid
      });
      return "ok" in boundByPid && boundByPid.ok;
    }
    if (inferredAgent === "codex") {
      const auto = await autoBindCodexPane({
        callerAgentId,
        repo: codexPanePreRegRepo,
        bindRuntimeIdentitySvc
      });
      if (auto) return true;
    }
    const detected = await detectTmuxPane({ agent: inferredAgent });
    if (!("ok" in detected) || !detected.ok) return false;
    const bound = await bindRuntimeIdentitySvc.bind({
      callerAgentId,
      agent: inferredAgent,
      ui_tty: detected.pane.tty,
      tmux_pane_id: detected.pane.pane_id
    });
    return "ok" in bound && bound.ok;
  }
  async function preflightUiPidClient(args) {
    if (args.ui_pid === void 0) return void 0;
    const inferredAgent = inferRuntimeAgentKind(args, getSessionClientInfo?.());
    if (!inferredAgent) return void 0;
    const validated = await bindRuntimeIdentity({
      agent: inferredAgent,
      ui_pid: args.ui_pid
    });
    if (!("error" in validated) || validated.error !== "agent_process_mismatch") {
      return void 0;
    }
    return {
      error: "ui_pid_client_mismatch",
      detail: `ui_pid ${args.ui_pid} does not belong to agent_type="${inferredAgent}". Pass the runtime kind for the process behind ui_pid; for example, use agent_type="opencode" when ui_pid points at an opencode process.`
    };
  }
  const registerAgentInputSchema = z3.object({
    model: z3.string().optional(),
    name: z3.string().min(1).refine((v) => v.trim().length > 0, { message: "name must not be empty" }),
    device: z3.string().nullish(),
    role: z3.string().optional(),
    team: z3.string().optional(),
    project_dir: z3.string().min(1).optional(),
    agent_type: agentTypeSchema,
    agent_type_name: z3.string().min(1).optional(),
    ui_pid: z3.number().int().positive().optional().describe(
      "STRONGLY RECOMMENDED. Visible agent UI process pid (e.g. Claude Code CLI pid \u2014 `$PPID` from a Bash tool call inside Claude Code). Enables one-shot pid \u2192 tty \u2192 pane binding at registration; without it, tmux-based cross-agent poke delivery typically stays off."
    ),
    channel_session_id: z3.string().min(1).optional(),
    thread_id: z3.string().min(1).refine((v) => v.trim().length > 0, { message: "thread_id must not be empty" }).optional(),
    ws_url: z3.string().optional(),
    auth_token_ref: z3.string().min(1).optional(),
    base_url: z3.string().min(1).refine((v) => v.trim().length > 0, { message: "base_url must not be empty" }).optional(),
    session_id: z3.string().min(1).refine((v) => v.trim().length > 0, { message: "session_id must not be empty" }).optional(),
    claude_ui_pid: z3.number().int().positive().optional().describe(
      "Internal field for the cross-agent-teams-mcp channel proxy.  Stores the proxy's parent Claude Code UI pid (`process.ppid`) so that Claude Code hosts registering in the same lineage can auto-bind their claude-channel delivery.  Only valid when role='__channel_proxy__'; rejected otherwise."
    ),
    delivery: deliverySchema.optional()
  }).strict(
    "Unrecognized key in register_agent input. Note: the fields `client` and `client_name` were renamed to `agent_type` and `agent_type_name` in 0.5.0."
  );
  const registerAgentArgsSchema = registerAgentInputSchema.superRefine((value, ctx) => {
    const hasCodexOnlyFields = value.thread_id !== void 0 || value.ws_url !== void 0;
    if (hasCodexOnlyFields && value.agent_type !== "codex") {
      ctx.addIssue({
        code: z3.ZodIssueCode.custom,
        path: ["agent_type"],
        message: "agent_type=codex is required when thread_id or ws_url is provided"
      });
    }
    if (value.auth_token_ref !== void 0 && value.agent_type !== "codex" && value.agent_type !== "opencode") {
      ctx.addIssue({
        code: z3.ZodIssueCode.custom,
        path: ["agent_type"],
        message: "agent_type=codex or agent_type=opencode is required when auth_token_ref is provided"
      });
    }
    if (value.channel_session_id !== void 0 && value.agent_type !== "claude-code") {
      ctx.addIssue({
        code: z3.ZodIssueCode.custom,
        path: ["agent_type"],
        message: "agent_type=claude-code is required when channel_session_id is provided"
      });
    }
    if (value.agent_type_name !== void 0 && value.agent_type !== "custom") {
      ctx.addIssue({
        code: z3.ZodIssueCode.custom,
        path: ["agent_type_name"],
        message: "agent_type_name is only allowed when agent_type=custom"
      });
    }
    if (value.claude_ui_pid !== void 0 && value.role !== "__channel_proxy__") {
      ctx.addIssue({
        code: z3.ZodIssueCode.custom,
        path: ["claude_ui_pid"],
        message: "claude_ui_pid is only allowed when role='__channel_proxy__'"
      });
    }
    if (value.agent_type === "codex" && value.delivery === void 0 && (value.thread_id === void 0 || value.thread_id === "")) {
      ctx.addIssue({
        code: z3.ZodIssueCode.custom,
        path: ["thread_id"],
        message: 'thread_id is required when agent_type="codex". If you are a launcher pre-registering a codex pane, use pre_register_codex_pane instead.'
      });
    }
    if (value.agent_type === "opencode") {
      if (value.base_url === void 0 || value.base_url.trim().length === 0) {
        ctx.addIssue({
          code: z3.ZodIssueCode.custom,
          path: ["base_url"],
          message: 'base_url is required when agent_type="opencode". Read it from $OPENCODE_XATS_BASE_URL (set by the free-xats-opencode launcher).'
        });
      } else {
        let parsedUrl = null;
        try {
          parsedUrl = new URL(value.base_url);
        } catch {
        }
        if (!parsedUrl || parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
          ctx.addIssue({
            code: z3.ZodIssueCode.custom,
            path: ["base_url"],
            message: 'base_url must be a parseable http:// or https:// URL when agent_type="opencode".'
          });
        }
      }
      if (value.session_id !== void 0 && value.session_id.trim().length > 0) {
        if (!value.session_id.startsWith("ses")) {
          ctx.addIssue({
            code: z3.ZodIssueCode.custom,
            path: ["session_id"],
            message: 'session_id must start with "ses" when supplied for agent_type="opencode".'
          });
        }
      }
    }
    if (value.base_url !== void 0 && value.agent_type !== "opencode") {
      ctx.addIssue({
        code: z3.ZodIssueCode.custom,
        path: ["agent_type"],
        message: "agent_type=opencode is required when base_url is provided"
      });
    }
    if (value.session_id !== void 0 && value.agent_type !== "opencode") {
      ctx.addIssue({
        code: z3.ZodIssueCode.custom,
        path: ["agent_type"],
        message: "agent_type=opencode is required when session_id is provided"
      });
    }
  });
  async function executeRegister(args) {
    let nativeDeliveryBound = suppressTmuxHint(args);
    let autoBoundChannelCsid;
    const bindChannelSvc = channelWakeFanout ? new BindChannelService(db, channelWakeFanout) : void 0;
    const autoBindChannelSvc = channelWakeFanout ? new AutoBindChannelService(db, channelWakeFanout) : void 0;
    if (args.agent_type === "claude-code" && args.model === void 0) {
      args.model = defaultClaudeSelfModel(getSessionClientInfo?.());
    }
    if (args.agent_type === "codex" && args.ws_url === void 0) {
      args.ws_url = "";
    }
    if (args.agent_type === "codex" && args.model === void 0) {
      args.model = "gpt";
    }
    const connectionId = getSessionId?.() ?? caller();
    if (!connectionId) return { error: "unknown_agent" };
    const uiPidClientError = await preflightUiPidClient(args);
    if (uiPidClientError) return uiPidClientError;
    if (args.agent_type === "opencode" && args.base_url !== void 0) {
      const opencodeRes = await registerOpencodeSelfSvc.register({
        connection_id: connectionId,
        name: args.name,
        device: args.device,
        model: args.model,
        role: args.role,
        team: args.team,
        project_dir: args.project_dir,
        base_url: args.base_url,
        session_id: args.session_id,
        auth_token_ref: args.auth_token_ref
      });
      if ("agent_id" in opencodeRes) {
        if (onRegisterSuccess) {
          try {
            onRegisterSuccess(opencodeRes.agent_id, opencodeRes.team);
          } catch {
          }
        } else if (fanout) {
          try {
            fanout.rebind(opencodeRes.agent_id, opencodeRes.team);
          } catch {
          }
        }
      }
      return opencodeRes;
    }
    if (args.agent_type === "claude-code" && args.channel_session_id !== void 0 && args.ui_pid !== void 0 && autoBindChannelSvc) {
      const effectiveDevice = resolveEffectiveDevice({
        requestedDevice: args.device ?? void 0,
        originInfo: getSessionOriginInfo?.(),
        localDevice: context?.localDevice ?? "local"
      });
      if ("error" in effectiveDevice) return effectiveDevice;
      const proxyLookup = autoBindChannelSvc.lookup({
        ui_pid: args.ui_pid,
        device: effectiveDevice.ok
      });
      if (proxyLookup.ok && proxyLookup.channel_session_id !== args.channel_session_id) {
        return {
          error: "channel_session_id_ui_pid_mismatch",
          detail: {
            ui_pid_matched_csid: proxyLookup.channel_session_id,
            supplied_csid: args.channel_session_id
          }
        };
      }
    }
    const hasCodexTransportFields = args.thread_id !== void 0 || args.ws_url !== void 0 || args.auth_token_ref !== void 0;
    const res = args.agent_type === "codex" && args.delivery === void 0 && hasCodexTransportFields ? await registerCodexSelfSvc.register({
      connection_id: connectionId,
      device: args.device,
      name: args.name,
      model: args.model,
      role: args.role,
      team: args.team,
      project_dir: args.project_dir,
      thread_id: args.thread_id,
      ws_url: args.ws_url,
      auth_token_ref: args.auth_token_ref
    }) : registerSvc.register({
      connection_id: connectionId,
      agent_type: args.agent_type,
      agent_type_name: args.agent_type_name,
      model: args.model,
      device: args.device,
      name: args.name,
      role: args.role,
      team: args.team,
      project_dir: args.project_dir,
      delivery: args.delivery,
      claude_ui_pid: args.claude_ui_pid,
      runtime_ui_pid: args.agent_type === "claude-code" ? args.ui_pid : void 0
    });
    if ("thread_id" in res && "agent_id" in res) {
      nativeDeliveryBound = true;
    }
    if ("agent_id" in res) {
      if (onRegisterSuccess) {
        try {
          onRegisterSuccess(res.agent_id, res.team);
        } catch {
        }
      } else if (fanout) {
        try {
          fanout.rebind(res.agent_id, res.team);
        } catch {
        }
      }
      if (args.agent_type === "claude-code" && args.channel_session_id !== void 0) {
        const channelBind = bindChannelSvc ? bindChannelSvc.bind({
          callerAgentId: res.agent_id,
          channel_session_id: args.channel_session_id
        }) : { error: "unknown_channel_session" };
        if ("ok" in channelBind && channelBind.ok) {
          nativeDeliveryBound = true;
        } else {
          return channelBind;
        }
      }
      if (args.agent_type === "claude-code" && args.channel_session_id === void 0 && args.ui_pid !== void 0 && autoBindChannelSvc) {
        const callerRow = agents.findById(res.agent_id);
        const autoBind = autoBindChannelSvc.run({
          callerAgentId: res.agent_id,
          ui_pid: args.ui_pid,
          device: callerRow?.device
        });
        if (autoBind.ok) {
          autoBoundChannelCsid = autoBind.channel_session_id;
          nativeDeliveryBound = true;
        }
      }
      const autoBound = await autoBindRuntimeIdentity(args, res.agent_id);
      const envelope = autoBoundChannelCsid !== void 0 ? { ...res, channel_session_id: autoBoundChannelCsid } : res;
      if (autoBound) return envelope;
      if (!nativeDeliveryBound) {
        return {
          ...envelope,
          hint: "No usable tmux_pane_id is bound yet \u2014 automatic runtime binding did not converge for this session, so cross-agent poke delivery via tmux is still off. Call `bind_runtime_identity(...)` to bind explicitly, or use `detect_tmux_pane(...)` for debugging. Claude Code users who loaded the cross-agent-teams-mcp channel plugin can also route pokes via channel_session_id \u2014 that path does not require tmux binding."
        };
      }
      return envelope;
    }
    return res;
  }
  function releaseRegisteredState(agentId) {
    const connectionId = getSessionId?.();
    if (connectionId) registerSvc.releaseConnection(agentId, connectionId);
    if (onUnregisterSuccess) {
      try {
        onUnregisterSuccess(agentId);
      } catch {
      }
      return;
    }
    if (fanout) {
      try {
        fanout.detach(agentId);
      } catch {
      }
    }
  }
  server.registerTool(
    "pre_register_codex_pane",
    {
      title: "Pre-register codex tmux pane",
      description: [
        "Pre-register a pending tmux-pane claim so the launcher can claim a tmux pane before starting codex.",
        'The launcher should call this with `$TMUX_PANE` and a freshly generated UUID, then `exec codex --remote ... -c xats.agent_id="\\"<uuid>\\""`.',
        'When the codex agent later calls `register_agent({agent_type:"codex"})` without `ui_pid`, the daemon uses the pending row to resolve the correct UI pid and auto-bind the pane.',
        "Callable without a prior `register_agent` \u2014 launchers have no agent identity yet.",
        "TTL defaults to 120 seconds and is capped at 600; pending rows are garbage-collected opportunistically."
      ].join(" "),
      inputSchema: preRegisterCodexPaneInputSchema
    },
    async (args) => run(async () => preRegisterCodexPaneSvc.register(args))
  );
  server.registerTool(
    "detect_tmux_pane",
    {
      title: "Detect tmux pane",
      description: [
        "Detect the tmux pane that is actually hosting a coding agent UI, even when the shell calling tools lives in a different pane.",
        "The detector scans tmux panes globally, maps each pane to its tty, then inspects real tty processes instead of trusting `$TMUX_PANE` or tmux focus state alone.",
        "Use `agent` to pick a built-in matcher for Codex, Claude Code, or opencode.",
        "Optional `cwd`, `tty`, and `title_contains` narrow the search and make cross-directory multi-agent sessions much more reliable.",
        "Returns either a single best pane, or an ambiguity/not-found result with candidates for debugging."
      ].join(" "),
      inputSchema: detectTmuxPaneSchema
    },
    async (args) => run(async () => {
      const parsed = detectTmuxPaneArgsSchema.safeParse(args);
      if (!parsed.success) {
        return {
          error: "invalid_arguments",
          detail: parsed.error.issues.map((issue) => issue.message).join("; ")
        };
      }
      return detectTmuxPane({
        agent: parsed.data.agent,
        cwd: parsed.data.cwd,
        tty: parsed.data.tty,
        title_contains: parsed.data.title_contains,
        process_pattern: parsed.data.process_pattern
      });
    })
  );
  server.registerTool(
    "register_agent",
    {
      title: "Register agent",
      description: [
        "Register this session as an agent in a team. This is the unified registration entry point.",
        "DETECTION (run these probes BEFORE choosing `agent_type=`, in order; first match wins):",
        '1. `printenv OPENCODE_XATS_BASE_URL` non-empty \u2192 `agent_type="opencode"`; pass that value as `base_url`. Do NOT pass `session_id` \u2014 the daemon auto-resolves it as the most recently updated session on that base_url. The env var is set ONLY by the `free-xats-opencode` launcher, so its presence is itself the runtime assertion that the caller is opencode.',
        '2. `printenv CODEX_THREAD_ID` non-empty \u2192 `agent_type="codex"`; pass that value as `thread_id` (REQUIRED for codex per the schema). Do NOT pass `ui_pid` (the launcher\'s `pre_register_codex_pane` flow handles tmux pane binding; supplying `ui_pid` from codex disables that auto-bind path).',
        '3. `printenv CLAUDECODE` non-empty OR `printenv CLAUDE_CODE_ENTRYPOINT` non-empty \u2192 `agent_type="claude-code"`; pass `$PPID` as `ui_pid` to enable channel auto-bind.',
        '4. None of the above \u2192 `agent_type="custom"` with `agent_type_name="<the harness you are running under, e.g. cursor, opencode, ...>"` (`agent_type_name` is required when `agent_type="custom"`). Detect the harness name from your runtime environment if you can \u2014 e.g. `printenv CURSOR_TRACE_ID` non-empty means cursor \u2014 but do NOT guess from system-wide signals like "binary X exists on PATH": such probes detect what the user has installed, not what runtime you are inside, and pick the wrong agent type. When unsure, prefer `agent_type_name="unknown"` over a wrong guess.',
        "Calling this tool again with the same `(device, team, name)` identity reuses the existing `agent_id` and refreshes `tmux_pane_id` and `model`; no duplicate row is created.",
        'Use `agent_type="custom"` for unsupported agent harnesses; provide `agent_type_name` for observability.',
        'opencode sessions: pass `agent_type="opencode"` and `base_url` (from `$OPENCODE_XATS_BASE_URL`, set by the `free-xats-opencode` launcher). Omit `session_id` \u2014 the daemon auto-resolves it via `<base_url>/session` (most recently updated). `auth_token_ref` is optional; set only when `OPENCODE_SERVER_PASSWORD` is configured on the opencode server. The schema REQUIRES `base_url` (parseable `http://` or `https://` URL) when `agent_type="opencode"`; missing/malformed `base_url` is rejected before any HTTP probe runs.',
        "Claude Code sessions: pass `agent_type=\"claude-code\"` and PREFERRED: pass only `ui_pid` (from `$PPID`) so the daemon auto-binds channel delivery \u2014 do not pass `channel_session_id` explicitly. When BOTH `ui_pid` AND `channel_session_id` are supplied, the daemon runs a consistency check against the caller `ui_pid`'s live channel proxy; if the proxy's csid does not match the supplied `channel_session_id`, the call is rejected with `channel_session_id_ui_pid_mismatch` before any agent row is written. To re-establish a prior identity on a fresh/resumed session where you no longer remember your (team, name) (changed csid, unchanged $PPID), prefer `reconnect({ ui_pid })` over the bind_channel\u2192register fallback; `bind_channel` only rebinds a session already bound to your agent. If instead you still remember your (team, name) after a restart + resume (changed $PPID), call register_agent directly with that remembered (team, name) and the current $PPID rather than reconnect.",
        'Codex sessions: pass `agent_type="codex"` and `thread_id` (from `$CODEX_THREAD_ID`) to register Codex app-server delivery. The schema REQUIRES `thread_id` when `agent_type="codex"`; missing or empty `thread_id` is rejected before any handshake runs. Launcher pre-reg callers without `thread_id` should use `pre_register_codex_pane` instead. `ws_url` defaults to `ws://127.0.0.1:8799` (env override `CROSS_AGENT_TEAMS_CODEX_WS_URL`); `model` defaults to `gpt` when omitted. For `agent_type="claude-code"` callers, `model` defaults to a Claude-specific value derived from MCP session client info when omitted.',
        "`model` is OPTIONAL for any agent_type: omit it when you do not have an authoritative model identifier; the daemon stores NULL in that case. Pass an explicit `model` only when you have a stable identifier you would like surfaced via `list_agents`.",
        'Requests such as "register to xats" or "register to cross-agent-teams" refer to this MCP service, not to the `team` field; do not set `team` to `xats` or `cross-agent-teams` from those phrases.',
        'Do not treat the bare word "register" as a request for this tool unless the current conversation is already about cross-agent-teams registration.',
        "If the user writes an identity in the shorthand `name(team)` (e.g. `skills-creator(default)` means name=`skills-creator`, team=`default`), split it into the separate `name` and `team` arguments. The daemon does NOT parse `name(team)`; passing the literal string as `name` registers a malformed identity (the parentheses are not rejected).",
        "When the end user has not explicitly specified `team`, callers should pass `project_dir` as the current working directory so the daemon derives a project-scoped default team from its basename; if omitted, it falls back to `default`.",
        'REPORTING RULE: on success the response carries the actual `team` the daemon assigned. When summarizing the registration to the user, surface that returned `team` value verbatim; NEVER derive or paraphrase the team from `project_dir`, cwd, or your own pre-call assumption. Failing to read the response masks the daemon\'s `default` fallback (e.g. when `project_dir` was forgotten) and produces misleading "team: X (from cwd basename)" reports that break later cross-team send_message diagnostics.',
        '`agent_type` must describe the runtime behind `ui_pid`, not merely the current MCP caller. For example, if `ui_pid` points at an external editor process, pass `agent_type="custom"` with `agent_type_name=<editor>` even when the registration request is issued from a different harness.',
        "STRONGLY RECOMMENDED: pass `ui_pid` unless it is truly unobtainable (codex and opencode callers excepted). Without it, automatic runtime binding usually fails to converge and tmux-based cross-agent poke delivery stays off until a separate `bind_runtime_identity(...)` call. From Claude Code, `$PPID` inside a Bash tool call is the `claude` CLI pid. With `ui_pid` the daemon binds via verified pid \u2192 tty \u2192 pane evidence in one shot.",
        "After registration, the daemon best-effort attempts runtime binding for recognized local clients so tmux-based poke delivery can come up without a second tool call.",
        "If automatic runtime binding does not converge, call `bind_runtime_identity(...)` explicitly so the daemon can verify and persist your pane binding.",
        "`detect_tmux_pane(...)` remains available as a debugging aid for ambiguous or missing matches, but it does not write registry state by itself.",
        "When registration still has no usable `tmux_pane_id`, tmux-based poke delivery stays unavailable until automatic or explicit runtime binding succeeds."
      ].join(" "),
      inputSchema: registerAgentInputSchema
    },
    async (args) => {
      return run(async () => executeRegister(registerAgentArgsSchema.parse(args)));
    }
  );
  const reconnectInputSchema = z3.object({
    ui_pid: z3.number().int().positive().describe(
      "The Claude UI process id (`$PPID` from a Bash tool call inside Claude Code). The daemon reverse-looks-up the prior local claude-code identity registered under this runtime_ui_pid."
    )
  }).strict();
  async function executeReconnect(ui_pid) {
    const resolution = resolveReconnect(agents, ui_pid, context?.localDevice ?? "local");
    if (resolution.kind === "need_register") {
      return { need_register: true, reason: resolution.reason };
    }
    if (resolution.kind === "ambiguous") {
      return {
        ambiguous: true,
        candidates: resolution.candidates.map((c) => ({
          agent_id: c.agent_id,
          name: c.name,
          team: c.team,
          device: c.device,
          role: c.role,
          last_seen_at: c.last_seen_at
        }))
      };
    }
    const match = resolution.match;
    const res = await executeRegister({
      agent_type: "claude-code",
      name: match.name,
      team: match.team,
      device: match.device,
      role: match.role,
      ui_pid
    });
    if (typeof res !== "object" || res === null || !("agent_id" in res)) {
      return res;
    }
    const envelope = res;
    return {
      ok: true,
      agent_id: envelope.agent_id,
      name: match.name,
      team: envelope.team,
      channel_session_id: envelope.channel_session_id ?? null,
      last_seen_at: match.last_seen_at
    };
  }
  server.registerTool(
    "reconnect",
    {
      title: "Reconnect to xats by ui_pid",
      description: RECONNECT_DESC,
      inputSchema: reconnectInputSchema
    },
    async (args) => {
      return run(async () => executeReconnect(reconnectInputSchema.parse(args).ui_pid));
    }
  );
  server.registerTool(
    "unregister_self",
    {
      title: "Unregister current agent",
      description: [
        "Remove the caller session's current agent registration.",
        "This tool only unregisters the currently bound agent identity; it does not delete other agents.",
        "On success it deletes the agent row and immediately releases the current MCP session back to an unregistered state."
      ].join(" "),
      inputSchema: z3.object({}).strict()
    },
    async () => {
      const who = requireAgent();
      if (typeof who !== "string") return toText(who);
      const result = await wrapStorage(() => unregisterSelfSvc.unregister({ caller: who }));
      if (typeof result === "object" && result !== null && "ok" in result && result.ok === true && "agent_id" in result && typeof result.agent_id === "string") {
        releaseRegisteredState(result.agent_id);
        return toText(result);
      }
      touchIfRegistered();
      return toText(result);
    }
  );
  server.registerTool(
    "list_agents",
    {
      title: "List agents",
      description: [
        "List agents in the caller's team across all devices. Scope is caller-team only: this tool CANNOT see cross-team agents and MUST NOT be used to verify whether a cross-team recipient exists.",
        'DO NOT call list_agents as a pre-flight / pre-verify / pre-check step before send_message \u2014 neither for same-team nor for cross-team sends. For cross-team targets the pre-check will always falsely report "missing" because list_agents is caller-team scoped; for same-team targets the pre-check is pure waste.',
        'The canonical miss signal is the unknown_recipient error returned by send_message itself. The correct pattern is "try send, then handle unknown_recipient" \u2014 never "list_agents first, then send".'
      ].join(" "),
      inputSchema: {}
    },
    async () => {
      const who = requireAgent();
      if (typeof who !== "string") return toText(who);
      const row = agents.findById(who);
      return run(() => listAgentsForTeam(db, row.team));
    }
  );
  server.registerTool(
    "send_message",
    {
      title: "Send message",
      description: SEND_MESSAGE_DESC,
      inputSchema: z3.object({
        to_agent_name: z3.string().min(1),
        to_team: z3.string().min(1).optional(),
        subject: z3.string().optional(),
        body: z3.string().min(1),
        auto_poke: z3.boolean().optional(),
        need_reply: z3.boolean().optional()
      }).strict()
    },
    async (args) => {
      const who = requireAgent();
      if (typeof who !== "string") return toText(who);
      return run(() => sendSvc.send({ from: who, ...args }));
    }
  );
  server.registerTool(
    "send_message_by_id",
    {
      title: "Send message by id",
      description: SEND_MESSAGE_BY_ID_DESC,
      inputSchema: z3.object({
        to_agent_id: z3.string().min(1),
        subject: z3.string().optional(),
        body: z3.string().min(1),
        auto_poke: z3.boolean().optional(),
        need_reply: z3.boolean().optional()
      }).strict()
    },
    async (args) => {
      const who = requireAgent();
      if (typeof who !== "string") return toText(who);
      return run(() => sendSvc.send({ from: who, ...args }));
    }
  );
  server.registerTool(
    "broadcast",
    {
      title: "Broadcast message",
      description: BROADCAST_DESC,
      inputSchema: {
        subject: z3.string().optional(),
        body: z3.string(),
        auto_poke: z3.boolean().optional()
      }
    },
    async (args) => {
      const who = requireAgent();
      if (typeof who !== "string") return toText(who);
      return run(() => broadcastSvc.broadcast({ from: who, ...args }));
    }
  );
  server.registerTool(
    "broadcast_to_role",
    {
      title: "Broadcast to role",
      description: BROADCAST_TO_ROLE_DESC,
      inputSchema: z3.object({
        to_role: z3.string().min(1),
        subject: z3.string().optional(),
        body: z3.string().min(1),
        auto_poke: z3.boolean().optional()
      }).strict()
    },
    async (args) => {
      const who = requireAgent();
      if (typeof who !== "string") return toText(who);
      return run(() => broadcastToRoleSvc.broadcast({ from: who, ...args }));
    }
  );
  server.registerTool(
    "get_inbox",
    {
      title: "Get inbox",
      description: [
        "Return messages addressed to the caller (by agent_id or matching role) within the caller team.",
        "Default behaviour (since_event_id omitted): the daemon reads the caller's server-side cursor (`agents.last_processed_event_id`), returns mail past it, and ADVANCES the cursor to the highest returned event_id in the same transaction. Subsequent default calls return only newer mail.",
        "Pagination via `limit` advances the cursor only to the last RETURNED event_id; the next default call resumes from there.",
        "Explicit `since_event_id` (any number, including 0) is read-only inspection: the daemon uses the supplied value as the lower bound and does NOT advance the stored cursor \u2014 useful for re-reading history or debugging without disturbing live read position.",
        'REPLY GUIDANCE: every returned message carries `from_agent_id`, `from_name`, and `from_device` for the sender. When replying via `send_message`, construct `to_agent_name` as `from_name + ":" + from_device` whenever `from_device !== <your own device>` \u2014 otherwise the daemon resolves the bare name on YOUR device, misses the cross-device sender, and returns `unknown_recipient`. Bare `from_name` is correct only when `from_device === <your own device>`. `send_message_by_id({to_agent_id: from_agent_id, ...})` always works regardless of device and is the safe fallback when device is unknown.',
        "Retention: messages older than 30 days are deleted by the cleanup routine regardless of read state. Agents that go offline for more than 30 days forfeit any unread mail in that window."
      ].join(" "),
      inputSchema: {
        since_event_id: z3.number().int().optional(),
        limit: z3.number().int().optional()
      }
    },
    async (args) => {
      const who = requireAgent();
      if (typeof who !== "string") return toText(who);
      return run(() => inboxSvc.get({ caller: who, ...args }));
    }
  );
  server.registerTool(
    "get_delivery_status",
    {
      title: "Get delivery status",
      description: [
        "Return wake-hint delivery status for a message sent by caller.",
        "Status describes auto-poke delivery only; mailbox persistence is already complete.",
        "Only the original sender can read a message delivery status."
      ].join(" "),
      inputSchema: {
        message_id: z3.string()
      }
    },
    async (args) => {
      const who = requireAgent();
      if (typeof who !== "string") return toText(who);
      return run(() => deliveryStatusSvc.get({ caller: who, ...args }));
    }
  );
  if (channelWakeFanout) {
    const bindSvc = new BindChannelService(db, channelWakeFanout);
    server.registerTool(
      "bind_channel",
      {
        title: "Bind channel_session_id to caller",
        description: [
          "Low-level rebind tool for Claude channel delivery.",
          "Bind the caller session's agent row to a channel_session_id produced by the cross-agent-teams-mcp channel proxy.",
          'Most callers should prefer `register_agent({ agent_type: "claude-code", channel_session_id, ... })` on the unified registration path.',
          "Call this when you need to rebind an already-registered row after the proxy announces a new csid AND your current MCP session is already bound to your agent.",
          "On a fresh or resumed MCP session (e.g. after a context clear or resume) the daemon has not yet associated this session with your agent, so bind_channel returns unknown_agent \u2014 use reconnect({ ui_pid: $PPID }) instead, which recovers your identity by process id and rebinds the channel in one step.",
          "Rejects proxy callers (role=__channel_proxy__).",
          "Rejects unknown csid (no live proxy sink attached)."
        ].join(" "),
        inputSchema: {
          channel_session_id: z3.string().min(1)
        }
      },
      async (args) => {
        const who = requireAgent();
        if (typeof who !== "string") return toText(who);
        return run(() => bindSvc.bind({
          callerAgentId: who,
          channel_session_id: args.channel_session_id
        }));
      }
    );
  }
  server.registerTool(
    "bind_runtime_identity",
    {
      title: "Bind runtime identity to caller",
      description: [
        "Bind the caller session's agent row to a verified tmux runtime identity.",
        "Pass `agent` to choose the built-in process matcher (`codex`, `claude-code`, `opencode`), or use `custom` together with `process_pattern`.",
        "Prefer passing `ui_pid` for the visible agent UI process; the daemon verifies pid \u2192 tty \u2192 pane before persisting `tmux_pane_id`.",
        "If `ui_pid` is unavailable, pass `ui_tty` together with `tmux_pane_id` for a weaker but still verified binding path.",
        "This tool writes registry state; `detect_tmux_pane` is for debugging only."
      ].join(" "),
      inputSchema: bindRuntimeIdentitySchema
    },
    async (args) => {
      const parsed = bindRuntimeIdentityArgsSchema.safeParse(args);
      if (!parsed.success) {
        return toText({
          error: "invalid_arguments",
          detail: parsed.error.issues.map((issue) => issue.message).join("; ")
        });
      }
      const who = requireAgent();
      if (typeof who !== "string") return toText(who);
      return run(() => bindRuntimeIdentitySvc.bind({
        callerAgentId: who,
        agent: parsed.data.agent,
        ui_pid: parsed.data.ui_pid,
        ui_tty: parsed.data.ui_tty,
        tmux_pane_id: parsed.data.tmux_pane_id,
        process_pattern: parsed.data.process_pattern
      }));
    }
  );
  if (channelWakeFanout) {
    const subscribeSvc = new SubscribeChannelWakeService(db, channelWakeFanout);
    server.registerTool(
      "subscribe_channel_wake",
      {
        title: "Subscribe channel wake",
        description: [
          "Internal tool reserved for the cross-agent-teams-mcp channel proxy.",
          "Attaches the caller's MCP session notification sink to a channel_session_id so the",
          "daemon can emit notifications/channel_wake to it.  Requires role=__channel_proxy__."
        ].join(" "),
        inputSchema: { channel_session_id: z3.string().min(1) }
      },
      async (args) => {
        const who = requireAgent();
        if (typeof who !== "string") return toText(who);
        const sid = getSessionId?.();
        if (!sid) return toText({ error: "unknown_session" });
        const sink = (payload) => {
          const t = getTransport?.();
          if (!t) return;
          try {
            void Promise.resolve(t.send(payload)).catch(() => {
            });
          } catch {
          }
        };
        return run(() => subscribeSvc.subscribe({
          callerAgentId: who,
          channel_session_id: args.channel_session_id,
          sessionId: sid,
          sink
        }));
      }
    );
  }
}

// src/mcp/transport.ts
function mountMcp(app, db, fanout, channelWakeFanout, opts = {}) {
  const sessions = /* @__PURE__ */ new Map();
  const log = opts.log ?? (() => {
  });
  const context = opts.context ?? { localDevice: "local" };
  function closeSessionByConnectionId(connectionId) {
    const s = sessions.get(connectionId);
    if (!s) return false;
    try {
      void s.transport.close();
    } catch {
    }
    return true;
  }
  const registerSvc = new RegisterAgentService(db, {
    closeSessionByConnectionId,
    log,
    localDevice: context.localDevice,
    getSessionOrigin: (connectionId) => sessions.get(connectionId)?.originInfo
  });
  const sessionOwners = /* @__PURE__ */ new Map();
  function normalizeGcOptions(opts2) {
    if (typeof opts2 === "number") {
      return { idleMs: opts2, maxAgeMs: opts2, maxSessions: Number.POSITIVE_INFINITY };
    }
    const idleMs = opts2?.idleMs ?? 3e5;
    return {
      idleMs,
      // Accepted for backward-compat but inert: reapOrphanSessions no longer
      // reaps by max-age (subsumed by the idle rule once active sessions are
      // exempt). Retained so existing ORPHAN_GC_MAX_AGE_MS / orphanGcMaxAgeMs
      // config does not error.
      maxAgeMs: opts2?.maxAgeMs ?? idleMs,
      maxSessions: opts2?.maxSessions ?? Number.POSITIVE_INFINITY
    };
  }
  function closeOrphanSession(session, now, reason) {
    const ageS = Math.floor((now - session.createdAt) / 1e3);
    const idleS = Math.floor((now - session.lastActivityAt) / 1e3);
    try {
      log(`mcp orphan session reap: sid=${session.sessionId} age_s=${ageS} idle_s=${idleS} reason=${reason}`);
    } catch {
    }
    try {
      void session.transport.close();
    } catch {
    }
  }
  function enforceOrphanSessionLimit(now, maxSessions, candidates) {
    if (!Number.isFinite(maxSessions)) return;
    const orphans = (candidates ?? Array.from(sessions.values())).filter((session) => session.agentIdHolder.current === void 0).sort((a, b) => a.createdAt - b.createdAt);
    if (orphans.length <= maxSessions) return;
    for (const session of orphans.slice(0, orphans.length - maxSessions)) {
      closeOrphanSession(session, now, "max_sessions");
    }
  }
  function createSession() {
    const server = new McpServer(
      { name: "cross-agent-teams-mcp", version: "0.1.0" },
      {
        instructions: 'xats \u662F cross-agent-teams \u7684\u7F29\u5199. \u5F53\u7528\u6237\u6216\u5176\u4ED6 agent \u63D0\u5230 xats \u65F6, \u6307\u7684\u662F\u672C MCP server (cross-agent-teams-mcp) \u53CA\u5176\u8DE8 agent \u534F\u4F5C\u5DE5\u5177 (register_agent, send_message, broadcast \u7B49). \u7528\u6237\u8BF4"\u6CE8\u518C\u5230 xats"\u6216"\u6CE8\u518C\u5230 cross-agent-teams"\u65F6, \u8868\u793A\u6CE8\u518C\u5230\u672C MCP \u670D\u52A1, xats \u548C cross-agent-teams \u4E0D\u662F team \u540D, \u4E0D\u8981\u628A\u5B83\u4EEC\u4F20\u7ED9 team. \u4E0D\u8981\u628A\u5355\u72EC\u7684\u5E38\u7528\u8BCD"\u6CE8\u518C"\u9ED8\u8BA4\u52AB\u6301\u4E3A\u672C\u5DE5\u5177; \u53EA\u6709\u5F53\u524D\u4E0A\u4E0B\u6587\u5DF2\u7ECF\u5728\u8BA8\u8BBA cross-agent-teams \u6CE8\u518C\u65F6\u624D\u53EF\u7EED\u63A5. \u6CE8\u518C\u65F6 (register_agent) \u5982\u679C\u7528\u6237\u672A\u663E\u5F0F\u6307\u5B9A team, \u9ED8\u8BA4\u4F20 project_dir=\u5F53\u524D\u5DE5\u4F5C\u76EE\u5F55 (cwd), daemon \u4F1A\u7528\u5B83\u7684 basename \u4F5C\u4E3A team \u9ED8\u8BA4\u503C; \u90FD\u4E0D\u4F20\u65F6\u56DE\u843D default. register_agent is the single registration entry point; pass `agent_type` explicitly. For `agent_type="opencode"`: read `$OPENCODE_XATS_BASE_URL` (exported by the `free-xats-opencode` launcher) and pass that value as `base_url`; omit `session_id` (daemon auto-resolves it as the most recently updated session on that base_url). For `agent_type="codex"`: read `$CODEX_THREAD_ID` (codex 0.124.0+ exports it) and pass it as `thread_id` (REQUIRED). Do NOT pass `ui_pid` from codex \u2014 the launcher\'s `pre_register_codex_pane` flow handles tmux pane binding automatically; supplying `ui_pid` manually disables that auto-bind path. For `agent_type="claude-code"`: pass `$PPID` as `ui_pid` so channel delivery auto-binds. For ANY other harness (cursor, an editor extension, an unknown caller, etc.): use `agent_type="custom"` together with `agent_type_name=<your harness name>`. Do NOT guess from system-wide signals like "binary X is on PATH" \u2014 those reflect what the user has installed, not what runtime you are inside. `model` is OPTIONAL for any agent_type; omit it when you do not have an authoritative model identifier. Anti-pattern: DO NOT call list_agents to pre-verify / pre-check a recipient before send_message. list_agents is scoped to the caller\'s team and CANNOT see cross-team agents, so using it as a pre-flight check before a cross-team send_message will always falsely report the target as missing; for same-team sends the pre-check is wasted work. On miss, send_message itself returns unknown_recipient cleanly with no side effects \u2014 the correct pattern is "try send_message, then handle unknown_recipient", never "list_agents first, then send_message".'
      }
    );
    const agentIdHolder = { current: void 0 };
    server.registerTool("echo", { title: "Echo", description: "Return the input", inputSchema: echoSchema }, echoHandler);
    let sessionIdForCaller;
    const getCallerAgentId = () => agentIdHolder.current ?? sessionIdForCaller;
    const sink = {
      sendHeartbeat() {
        void transport.send({
          jsonrpc: "2.0",
          method: "notifications/heartbeat",
          params: {}
        }).catch(() => {
        });
      },
      close() {
      }
    };
    const onRegisterSuccess = (agent_id, team) => {
      try {
        fanout.detach(agent_id);
      } catch {
      }
      if (agentIdHolder.current && agentIdHolder.current !== agent_id) {
        try {
          fanout.detach(agentIdHolder.current);
        } catch {
        }
      }
      fanout.attach(agent_id, team, sink);
      agentIdHolder.current = agent_id;
    };
    const onUnregisterSuccess = (agent_id) => {
      try {
        fanout.detach(agent_id);
      } catch {
      }
      if (sessionIdForCaller && channelWakeFanout) {
        try {
          channelWakeFanout.detachBySession(sessionIdForCaller);
        } catch {
        }
      }
      if (agentIdHolder.current === agent_id) agentIdHolder.current = void 0;
    };
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID5(),
      onsessioninitialized: (sid) => {
        sessionIdForCaller = sid;
        const now2 = Date.now();
        sessions.set(sid, {
          transport,
          server,
          sessionId: sid,
          agentIdHolder,
          createdAt: now2,
          lastActivityAt: now2,
          clientInfo: void 0,
          originInfo: { origin: "local", remote_addr: null }
        });
        log(`mcp session created: sid=${sid} sessions=${sessions.size}`);
        if (opts.orphanSessionLimit !== void 0) {
          enforceOrphanSessionLimit(now2, opts.orphanSessionLimit);
        }
      }
    });
    transport.onclose = () => {
      if (agentIdHolder.current) {
        try {
          fanout.detach(agentIdHolder.current);
        } catch {
        }
      }
      if (transport.sessionId && channelWakeFanout) {
        try {
          channelWakeFanout.detachBySession(transport.sessionId);
        } catch {
        }
      }
      if (transport.sessionId) {
        if (agentIdHolder.current) {
          try {
            registerSvc.releaseConnection(agentIdHolder.current, transport.sessionId);
          } catch {
          }
        }
        log(`mcp session closed: sid=${transport.sessionId} had_agent=${agentIdHolder.current ?? "none"} sessions=${sessions.size - 1}`);
        sessions.delete(transport.sessionId);
        sessionOwners.delete(transport.sessionId);
      }
    };
    registerBusinessTools(
      server,
      db,
      getCallerAgentId,
      fanout,
      onRegisterSuccess,
      () => sessionIdForCaller,
      channelWakeFanout,
      () => transport,
      () => {
        const sid = sessionIdForCaller;
        if (!sid) return void 0;
        return sessions.get(sid)?.clientInfo;
      },
      () => {
        const sid = sessionIdForCaller;
        if (!sid) return void 0;
        return sessions.get(sid)?.originInfo;
      },
      context,
      onUnregisterSuccess,
      registerSvc
    );
    server.connect(transport);
    const now = Date.now();
    return {
      transport,
      server,
      sessionId: "",
      agentIdHolder,
      createdAt: now,
      lastActivityAt: now,
      originInfo: { origin: "local", remote_addr: null }
    };
  }
  function authHashFor(req) {
    const raw = req.headers["authorization"];
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    return createHash("sha256").update(trimmed).digest("hex");
  }
  app.post("/mcp", async (req, reply) => {
    const sid = req.headers["mcp-session-id"];
    const body = req.body;
    const isInit = body?.method === "initialize";
    let session = sid ? sessions.get(sid) : void 0;
    const originInfo = req.xatsPeer ?? { origin: "local", remote_addr: null };
    if (!session && !isInit) {
      log(`mcp unknown_session: route=POST method=${body?.method ?? "unknown"} name=${body?.params?.name ?? "none"} sid=${sid ?? "none"} sessions=${sessions.size}`);
      return sendControlPlaneReject(reply, 404);
    }
    if (session && body?.method === "tools/call" && body.params?.name === "register_agent") {
      const authHash = authHashFor(req);
      if (authHash !== null) {
        const owner = sessionOwners.get(session.sessionId);
        if (owner && owner !== authHash) {
          return sendControlPlaneReject(reply, 409);
        }
        if (!owner) sessionOwners.set(session.sessionId, authHash);
      }
    }
    if (session && body?.method === "tools/call") {
      const claimed = body.params?.arguments?.from_agent_id;
      if (typeof claimed === "string") {
        const current = session.agentIdHolder.current;
        if (current === void 0 || claimed !== current) {
          return sendControlPlaneReject(reply, 403);
        }
      }
    }
    if (!session) {
      session = createSession();
    }
    if (session) {
      session.originInfo = originInfo;
      session.lastActivityAt = Date.now();
    }
    if (body?.method === "initialize") {
      const params = body.params;
      const clientInfo = params?.clientInfo;
      session.clientInfo = {
        name: typeof clientInfo?.name === "string" ? clientInfo.name : void 0,
        version: typeof clientInfo?.version === "string" ? clientInfo.version : void 0
      };
    }
    await session.transport.handleRequest(req.raw, reply.raw, body);
    if (isInit && session.transport.sessionId) {
      const initialized = sessions.get(session.transport.sessionId);
      if (initialized) {
        initialized.originInfo = originInfo;
      }
    }
    return reply;
  });
  app.get("/mcp", async (req, reply) => {
    const sid = req.headers["mcp-session-id"];
    const session = sid ? sessions.get(sid) : void 0;
    if (!session) {
      log(`mcp unknown_session: route=GET sid=${sid ?? "none"} sessions=${sessions.size}`);
      return sendControlPlaneReject(reply, 404);
    }
    session.lastActivityAt = Date.now();
    await session.transport.handleRequest(req.raw, reply.raw);
    return reply;
  });
  app.delete("/mcp", async (req, reply) => {
    const sid = req.headers["mcp-session-id"];
    const session = sid ? sessions.get(sid) : void 0;
    if (!session) {
      log(`mcp unknown_session: route=DELETE sid=${sid ?? "none"} sessions=${sessions.size}`);
      return sendControlPlaneReject(reply, 404);
    }
    session.lastActivityAt = Date.now();
    await session.transport.handleRequest(req.raw, reply.raw);
    return reply;
  });
  function reapOrphanSessions(now, opts2) {
    const gc = normalizeGcOptions(opts2);
    const survivors = [];
    for (const session of sessions.values()) {
      if (session.agentIdHolder.current !== void 0) continue;
      const idleMs = now - session.lastActivityAt;
      if (idleMs >= gc.idleMs) {
        closeOrphanSession(session, now, "idle");
        continue;
      }
      survivors.push(session);
    }
    enforceOrphanSessionLimit(now, gc.maxSessions, survivors);
  }
  function sessionMetrics() {
    let registered = 0;
    let orphan = 0;
    for (const session of sessions.values()) {
      if (session.agentIdHolder.current === void 0) orphan += 1;
      else registered += 1;
    }
    return {
      total: sessions.size,
      registered,
      orphan,
      fanout: fanout.peek().length
    };
  }
  return { reapOrphanSessions, sessionMetrics };
}

// src/daemon/rest-api.ts
import { z as z4 } from "zod";
var identitySchema = z4.object({
  team: z4.string().min(1),
  name: z4.string().min(1)
}).strict();
var sendBodySchema = z4.object({
  from: identitySchema,
  to: z4.union([
    z4.object({ agent_id: z4.string().min(1) }).strict(),
    z4.object({ name: z4.string().min(1), team: z4.string().min(1).optional() }).strict()
  ]),
  subject: z4.string().optional(),
  body: z4.string().min(1),
  need_reply: z4.boolean().optional(),
  auto_poke: z4.boolean().optional()
}).strict();
function isErrorResult(value) {
  return typeof value === "object" && value !== null && "error" in value && typeof value.error === "string";
}
function sendErrorStatus(error) {
  if (error === "unknown_recipient") return 404;
  if (error === "storage_unavailable") return 503;
  return 400;
}
function peerOrigin(req) {
  return req.xatsPeer?.origin;
}
async function restLoopbackGate(req, reply) {
  if (!req.url.startsWith("/api/")) return;
  if (peerOrigin(req) !== "local") {
    await reply.code(403).send({ error: "remote_forbidden" });
  }
}
function recipientFields(to) {
  if ("agent_id" in to) return { to_agent_id: to.agent_id };
  return { to_agent_name: to.name, to_team: to.team };
}
async function handleSend(ctx, req, reply) {
  const parsed = sendBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({
      error: "invalid_request",
      detail: parsed.error.issues.map((i) => i.message).join("; ")
    });
  }
  const data = parsed.data;
  const fromRow = ctx.agents.findByIdentity({
    device: ctx.localDevice,
    team: data.from.team,
    name: data.from.name
  });
  if (!fromRow) return reply.code(404).send({ error: "unknown_sender" });
  const input = {
    from: fromRow.agent_id,
    subject: data.subject,
    body: data.body,
    need_reply: data.need_reply,
    auto_poke: data.auto_poke,
    ...recipientFields(data.to)
  };
  const result = await wrapStorage(() => ctx.sendSvc.send(input));
  if (isErrorResult(result)) {
    return reply.code(sendErrorStatus(result.error)).send({ error: result.error });
  }
  return reply.send(result);
}
async function handleInbox(ctx, req, reply) {
  const query = req.query;
  const team = typeof query.team === "string" ? query.team : void 0;
  const name = typeof query.name === "string" ? query.name : void 0;
  if (!team || !name) {
    return reply.code(400).send({ error: "invalid_request", detail: "team and name are required" });
  }
  let since_event_id;
  if (query.since_event_id !== void 0) {
    const n = Number(query.since_event_id);
    if (!Number.isInteger(n)) {
      return reply.code(400).send({ error: "invalid_request", detail: "since_event_id must be an integer" });
    }
    since_event_id = n;
  }
  const owner = ctx.agents.findByIdentity({ device: ctx.localDevice, team, name });
  if (!owner) return reply.code(404).send({ error: "unknown_owner" });
  const result = await wrapStorage(() => ctx.inboxSvc.get({ caller: owner.agent_id, since_event_id }));
  if (isErrorResult(result)) {
    return reply.code(503).send({ error: result.error });
  }
  return reply.send(result);
}
async function handleAgents(ctx, req, reply) {
  const query = req.query;
  const team = typeof query.team === "string" ? query.team : void 0;
  if (!team) {
    return reply.code(400).send({ error: "invalid_request", detail: "team is required" });
  }
  const result = await wrapStorage(() => listAgentsForTeam(ctx.db, team));
  if (isErrorResult(result)) {
    return reply.code(503).send({ error: result.error });
  }
  return reply.send(result);
}
var registerBodySchema = z4.object({
  name: z4.string().min(1),
  team: z4.string().optional(),
  role: z4.string().optional(),
  device: z4.string().nullish(),
  agent_type: z4.string().optional(),
  agent_type_name: z4.string().optional(),
  model: z4.string().optional(),
  delivery: z4.unknown().optional()
}).strict();
var deregisterBodySchema = z4.object({
  agent_id: z4.string().min(1)
}).strict();
var heartbeatBodySchema = z4.object({
  agent_id: z4.string().min(1)
}).strict();
var identityQuerySchema = z4.object({
  agent_id: z4.string().min(1)
}).strict();
function agentTypeFromString(s) {
  const known = ["opencode", "claude-code", "codex", "custom"];
  if (s && known.includes(s)) return s;
  return void 0;
}
async function handleRegister(ctx, req, reply) {
  const parsed = registerBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({
      error: "invalid_request",
      detail: parsed.error.issues.map((i) => i.message).join("; ")
    });
  }
  const data = parsed.data;
  const validName = validateNameLabel(data.name);
  if ("error" in validName) return reply.code(400).send({ error: validName.error });
  if (data.team !== void 0) {
    const validTeam = validateTeamLabel(data.team);
    if ("error" in validTeam) return reply.code(400).send({ error: validTeam.error });
  }
  const deviceResult = resolveEffectiveDevice({
    requestedDevice: data.device ?? void 0,
    localDevice: ctx.localDevice
  });
  if ("error" in deviceResult) return reply.code(400).send({ error: deviceResult.error });
  let delivery;
  if (data.delivery !== void 0) {
    const validated = validateDeliveryForWrite(data.delivery);
    if ("error" in validated) return reply.code(400).send({ error: validated.error, reason: validated.reason });
    delivery = validated.ok;
  }
  const input = {
    name: data.name,
    team: data.team,
    role: data.role,
    device: deviceResult.ok,
    agent_type: agentTypeFromString(data.agent_type),
    agent_type_name: data.agent_type_name,
    model: data.model,
    delivery
  };
  const result = ctx.agents.register(input);
  return reply.send(result);
}
async function handleDeregister(ctx, req, reply) {
  const parsed = deregisterBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({
      error: "invalid_request",
      detail: parsed.error.issues.map((i) => i.message).join("; ")
    });
  }
  const data = parsed.data;
  const deleted = ctx.agents.deleteById(data.agent_id);
  if (!deleted) return reply.code(404).send({ error: "unknown_agent" });
  return reply.send({ ok: true });
}
async function handleHeartbeat(ctx, req, reply) {
  const parsed = heartbeatBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({
      error: "invalid_request",
      detail: parsed.error.issues.map((i) => i.message).join("; ")
    });
  }
  const { agent_id } = parsed.data;
  const row = ctx.agents.getById(agent_id);
  if (!row) return reply.code(404).send({ error: "unknown_agent" });
  ctx.agents.touch(agent_id);
  return reply.send({ ok: true });
}
async function handleWhoami(ctx, req, reply) {
  const parsed = identityQuerySchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({
      error: "invalid_request",
      detail: parsed.error.issues.map((i) => i.message).join("; ")
    });
  }
  const { agent_id } = parsed.data;
  const row = ctx.agents.getById(agent_id);
  if (!row) return reply.code(404).send({ error: "unknown_agent" });
  return reply.send({
    agent_id: row.agent_id,
    name: row.name,
    team: row.team,
    role: row.role,
    device: row.device,
    agent_type: row.agent_type,
    agent_type_name: row.agent_type_name,
    model: row.model,
    delivery_kind: row.delivery_kind,
    registered_at: row.registered_at,
    last_seen_at: row.last_seen_at
  });
}
function mountRestApi(app, db, deps = {}) {
  const agents = new AgentsRepo(db);
  const events = new EventsOutbox(db);
  const localDevice = deps.context?.localDevice ?? "local";
  const autoPokeImpl = createAutoPokeImpl(db, agents, deps.channelWakeFanout);
  const sendSvc = new SendMessageService(db, agents, events, { poke: autoPokeImpl });
  const inboxSvc = new GetInboxService(db, agents);
  const ctx = { db, localDevice, agents, sendSvc, inboxSvc };
  app.addHook("onRequest", restLoopbackGate);
  app.post("/api/send", (req, reply) => handleSend(ctx, req, reply));
  app.get("/api/inbox", (req, reply) => handleInbox(ctx, req, reply));
  app.get("/api/agents", (req, reply) => handleAgents(ctx, req, reply));
  app.post("/api/register", (req, reply) => handleRegister(ctx, req, reply));
  app.post("/api/deregister", (req, reply) => handleDeregister(ctx, req, reply));
  app.post("/api/heartbeat", (req, reply) => handleHeartbeat(ctx, req, reply));
  app.post("/api/whoami", (req, reply) => handleWhoami(ctx, req, reply));
}

// src/daemon/cleanup.ts
function runCleanup(db, opts = {}) {
  const now = opts.now ?? /* @__PURE__ */ new Date();
  const maxAgeDays = opts.maxAgeDays ?? 30;
  const ageCutoff = new Date(now.getTime() - maxAgeDays * 86400 * 1e3).toISOString();
  const deleteStatus = db.prepare(
    `DELETE FROM message_delivery_status
      WHERE message_id IN (SELECT id FROM messages WHERE sent_at < ?)`
  );
  const deleteMessages = db.prepare(`DELETE FROM messages WHERE sent_at < ?`);
  const deleteEvents = db.prepare(`DELETE FROM events WHERE created_at < ?`);
  const deleteStaleProxies = db.prepare(
    `DELETE FROM agents
      WHERE role = '__channel_proxy__'
        AND last_seen_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM agents host
          WHERE host.delivery_kind = 'claude-channel'
            AND host.role <> '__channel_proxy__'
            AND json_extract(host.delivery_payload, '$.channel_session_id')
                = json_extract(agents.delivery_payload, '$.channel_session_id')
        )`
  );
  const tx = db.transaction(() => {
    const s = deleteStatus.run(ageCutoff);
    const m = deleteMessages.run(ageCutoff);
    const e = deleteEvents.run(ageCutoff);
    const p = deleteStaleProxies.run(ageCutoff);
    return Number(s.changes) + Number(m.changes) + Number(e.changes) + Number(p.changes);
  });
  return { deleted: tx() };
}

// src/daemon/sse-fanout.ts
var DEFAULT_HEARTBEAT_INTERVAL_MS = 3e4;
function resolveHeartbeatIntervalMs(opt) {
  if (typeof opt === "number" && opt > 0) return opt;
  const n = Number(process.env.HEARTBEAT_INTERVAL_MS);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_HEARTBEAT_INTERVAL_MS;
}
var SseFanout = class {
  sessions = /* @__PURE__ */ new Map();
  heartbeatTimer;
  heartbeatIntervalMs;
  constructor(opts = {}) {
    this.heartbeatIntervalMs = resolveHeartbeatIntervalMs(opts.heartbeatIntervalMs);
  }
  attach(agent_id, team, sink) {
    const prior = this.sessions.get(agent_id);
    if (prior && prior.sink !== sink) {
      try {
        prior.sink.close();
      } catch {
      }
    }
    const wasEmpty = this.sessions.size === 0;
    this.sessions.set(agent_id, { agent_id, team, sink });
    if (wasEmpty) this.startHeartbeat();
  }
  rebind(agent_id, team) {
    const s = this.sessions.get(agent_id);
    if (!s) return;
    this.sessions.set(agent_id, { agent_id, team, sink: s.sink });
  }
  detach(agent_id) {
    const s = this.sessions.get(agent_id);
    if (s) {
      try {
        s.sink.close();
      } catch {
      }
      this.sessions.delete(agent_id);
    }
    if (this.sessions.size === 0) this.stopHeartbeat();
  }
  stopAll() {
    this.stopHeartbeat();
    for (const s of this.sessions.values()) {
      try {
        s.sink.close();
      } catch {
      }
    }
    this.sessions.clear();
  }
  peek() {
    return Array.from(this.sessions.values()).map((s) => ({ agent_id: s.agent_id, team: s.team }));
  }
  startHeartbeat() {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      for (const s of this.sessions.values()) {
        try {
          s.sink.sendHeartbeat();
        } catch {
        }
      }
    }, this.heartbeatIntervalMs);
    if (typeof this.heartbeatTimer.unref === "function") this.heartbeatTimer.unref();
  }
  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = void 0;
    }
  }
};

// src/daemon/channel-wake-fanout.ts
var ChannelWakeFanout = class {
  entries = /* @__PURE__ */ new Map();
  attach(channel_session_id, sink, sessionId) {
    this.entries.set(channel_session_id, { sessionId, sink });
  }
  detach(channel_session_id) {
    this.entries.delete(channel_session_id);
  }
  detachBySession(sessionId) {
    for (const [csid, entry] of this.entries) {
      if (entry.sessionId === sessionId) this.entries.delete(csid);
    }
  }
  send(channel_session_id, payload) {
    const entry = this.entries.get(channel_session_id);
    if (!entry) return false;
    try {
      entry.sink(payload);
    } catch {
    }
    return true;
  }
  has(channel_session_id) {
    return this.entries.has(channel_session_id);
  }
};

// src/daemon/local-device.ts
import { hostname } from "node:os";
function resolveLocalDeviceLabel(explicit) {
  const raw = explicit ?? hostname();
  if (raw.includes(":")) {
    throw new Error("invalid_device_label");
  }
  const normalized = raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  if (normalized.length === 0) {
    if (explicit !== void 0) {
      throw new Error("invalid_device_label");
    }
    return "local";
  }
  if (normalized.length > 64) {
    throw new Error("invalid_device_label");
  }
  return normalized;
}

// src/daemon/network-origin.ts
function isLoopbackAddress(address) {
  if (!address) return true;
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}
function classifyPeerAddress(address) {
  if (isLoopbackAddress(address)) {
    return { origin: "local", remote_addr: null };
  }
  return { origin: "remote", remote_addr: address ?? null };
}
function isLoopbackHost(host) {
  return host === "localhost" || isLoopbackAddress(host);
}
function bindHostCoversIpv4Loopback(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "0.0.0.0";
}

// src/daemon/server.ts
var DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 12e4;
var DEFAULT_ORPHAN_GC_INTERVAL_MS = 6e4;
var DEFAULT_ORPHAN_GC_IDLE_MS = 3e5;
var DEFAULT_ORPHAN_GC_MAX_AGE_MS = 3e5;
var DEFAULT_ORPHAN_GC_MAX_SESSIONS = 500;
function parsePositiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
async function buildServer(opts) {
  const keepAliveTimeout = parsePositiveInt(process.env.KEEP_ALIVE_TIMEOUT_MS, DEFAULT_KEEP_ALIVE_TIMEOUT_MS);
  const app = Fastify({ logger: false, keepAliveTimeout });
  app.server.headersTimeout = keepAliveTimeout + 1e3;
  const db = openDb(opts.dbPath);
  const context = {
    localDevice: opts.localDevice ?? resolveLocalDeviceLabel()
  };
  applySchema(db, { localDevice: context.localDevice });
  const startedAt = Date.now();
  const version = "0.1.0";
  const fanout = opts.fanout ?? new SseFanout();
  const channelWakeFanout = opts.channelWakeFanout ?? new ChannelWakeFanout();
  app.addHook("onRequest", makeAuthHook(opts.token));
  app.addHook("onRequest", async (req) => {
    ;
    req.xatsPeer = classifyPeerAddress(req.raw.socket.remoteAddress);
  });
  const orphanGcMaxSessions = opts.orphanGcMaxSessions ?? parsePositiveInt(process.env.ORPHAN_GC_MAX_SESSIONS, DEFAULT_ORPHAN_GC_MAX_SESSIONS);
  const mcp = mountMcp(app, db, fanout, channelWakeFanout, {
    context,
    log: opts.mcpLog,
    orphanSessionLimit: orphanGcMaxSessions
  });
  mountRestApi(app, db, { channelWakeFanout, context });
  app.get("/health", async () => ({
    ok: true,
    version,
    uptime_seconds: Math.floor((Date.now() - startedAt) / 1e3),
    mcp_sessions: mcp.sessionMetrics()
  }));
  const cleanupIntervalMs = opts.cleanupIntervalMs ?? Number(process.env.CLEANUP_INTERVAL_MS ?? 60 * 60 * 1e3);
  const interval = setInterval(() => {
    try {
      runCleanup(db);
    } catch {
    }
  }, cleanupIntervalMs);
  if (typeof interval.unref === "function") interval.unref();
  const orphanGcIntervalMs = opts.orphanGcIntervalMs ?? parsePositiveInt(process.env.ORPHAN_GC_INTERVAL_MS, DEFAULT_ORPHAN_GC_INTERVAL_MS);
  const orphanGcIdleMs = opts.orphanGcIdleMs ?? parsePositiveInt(process.env.ORPHAN_GC_IDLE_MS, DEFAULT_ORPHAN_GC_IDLE_MS);
  const orphanGcMaxAgeMs = opts.orphanGcMaxAgeMs ?? parsePositiveInt(process.env.ORPHAN_GC_MAX_AGE_MS, DEFAULT_ORPHAN_GC_MAX_AGE_MS);
  const orphanGcInterval = setInterval(() => {
    try {
      mcp.reapOrphanSessions(Date.now(), {
        idleMs: orphanGcIdleMs,
        maxAgeMs: orphanGcMaxAgeMs,
        maxSessions: orphanGcMaxSessions
      });
    } catch {
    }
  }, orphanGcIntervalMs);
  if (typeof orphanGcInterval.unref === "function") orphanGcInterval.unref();
  const agentTtlMs = parsePositiveInt(process.env.AGENT_TTL_MS, 18e4);
  const agentReapIntervalMs = parsePositiveInt(process.env.AGENT_REAP_INTERVAL_MS, 6e4);
  const agentsRepo = new AgentsRepo(db);
  const agentReaper = setInterval(() => {
    try {
      const cutoff = new Date(Date.now() - agentTtlMs).toISOString();
      const count = agentsRepo.deleteOlderThan(cutoff);
      if (count > 0) {
        console.log(`[reaper] removed ${count} stale agent(s) older than ${agentTtlMs}ms`);
      }
    } catch {
    }
  }, agentReapIntervalMs);
  if (typeof agentReaper.unref === "function") agentReaper.unref();
  app.addHook("onClose", async () => {
    clearInterval(interval);
    clearInterval(orphanGcInterval);
    clearInterval(agentReaper);
    clearAllRetries();
    fanout.stopAll();
    db.close();
  });
  return app;
}
async function startServer(opts) {
  const app = await buildServer(opts);
  const host = opts.host ?? "127.0.0.1";
  const companionRef = { server: void 0 };
  app.addHook("onClose", async () => {
    const server = companionRef.server;
    if (!server) return;
    await new Promise((resolve) => {
      server.close(() => resolve());
    });
  });
  await app.listen({ port: opts.port, host });
  const addr = app.server.address();
  const port = addr && typeof addr === "object" ? addr.port : opts.port;
  const companionEnabled = opts.loopbackCompanion !== false;
  if (companionEnabled && !bindHostCoversIpv4Loopback(host)) {
    const handler = app.server.listeners("request")[0];
    if (!handler) {
      await app.close();
      throw new Error("loopback_companion_no_handler: Fastify did not expose a request handler");
    }
    const companion = createHttpServer(handler);
    try {
      await new Promise((resolve, reject) => {
        const onErr = (err) => reject(err);
        companion.once("error", onErr);
        companion.listen(port, "127.0.0.1", () => {
          companion.removeListener("error", onErr);
          resolve();
        });
      });
    } catch (err) {
      try {
        companion.close();
      } catch {
      }
      await app.close();
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`loopback_companion_bind_failed: ${detail}`);
    }
    companionRef.server = companion;
  }
  return { app, port, host, loopbackCompanion: companionRef.server };
}

// src/daemon/pid.ts
import { existsSync, mkdirSync as mkdirSync2, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname as dirname2 } from "node:path";
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const err = e;
    if (err.code === "EPERM") return true;
    return false;
  }
}
function acquirePidFile(path, port) {
  mkdirSync2(dirname2(path), { recursive: true });
  if (existsSync(path)) {
    try {
      const prev = JSON.parse(readFileSync(path, "utf8"));
      if (isAlive(prev.pid) && prev.pid !== process.pid) {
        return { ok: false, reason: "already_running", pid: prev.pid, port: prev.port };
      }
    } catch {
    }
  }
  writeFileSync(path, JSON.stringify({ pid: process.pid, port }));
  return { ok: true };
}
function releasePidFile(path) {
  if (existsSync(path)) rmSync(path, { force: true });
}

// src/daemon/shutdown.ts
var DEFAULT_GRACE_MS = 5e3;
function resolveGraceMs(explicit) {
  if (typeof explicit === "number" && Number.isFinite(explicit)) {
    return explicit < 0 ? 0 : Math.floor(explicit);
  }
  const raw = process.env.XATS_SHUTDOWN_GRACE_MS;
  if (raw === void 0 || raw === "") return DEFAULT_GRACE_MS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_GRACE_MS;
  return n < 0 ? 0 : Math.floor(n);
}
function wireShutdown(app, pidPath, opts = {}) {
  const graceMs = resolveGraceMs(opts.graceMs);
  const exit = opts.exit ?? ((code) => {
    process.exit(code);
  });
  const extraForceClose = opts.extraForceClose;
  let shuttingDown = false;
  const handler = (_signal) => {
    if (shuttingDown) {
      releasePidFile(pidPath);
      exit(0);
      return;
    }
    shuttingDown = true;
    void runDrain(app, pidPath, graceMs, exit, extraForceClose);
  };
  process.on("SIGTERM", handler);
  process.on("SIGINT", handler);
}
function forceCloseAll(app, extra) {
  try {
    app.server.closeAllConnections();
  } catch {
  }
  if (extra) {
    try {
      extra();
    } catch {
    }
  }
}
async function runDrain(app, pidPath, graceMs, exit, extraForceClose) {
  if (graceMs <= 0) {
    forceCloseAll(app, extraForceClose);
    try {
      await app.close();
    } catch {
    }
    releasePidFile(pidPath);
    exit(0);
    return;
  }
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve("timeout"), graceMs);
    if (typeof timer.unref === "function") timer.unref();
  });
  const closed = app.close().then(() => "closed").catch(() => "closed");
  const winner = await Promise.race([closed, deadline]);
  if (winner === "timeout") {
    forceCloseAll(app, extraForceClose);
    try {
      await app.close();
    } catch {
    }
  }
  if (timer) clearTimeout(timer);
  releasePidFile(pidPath);
  exit(0);
}

// src/daemon/port.ts
import { createServer } from "node:net";
function tryBind(port, host) {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}
async function selectPort(candidates, host = "127.0.0.1") {
  for (const p of candidates) {
    if (await tryBind(p, host)) return p;
  }
  throw new Error(`ports ${candidates[0]}-${candidates[candidates.length - 1]} unavailable`);
}

// src/cli.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
function parseArg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
function defaultHome() {
  return process.env.CROSS_AGENT_TEAMS_MCP_HOME ?? join(homedir(), ".cross-agent-teams-mcp");
}
function parseDaemonCliArgs(argv = process.argv, env = process.env) {
  const originalArgv = process.argv;
  try {
    process.argv = [...argv];
    const home = env.CROSS_AGENT_TEAMS_MCP_HOME ?? defaultHome();
    const tokenExplicit = parseArg("--token");
    const token = tokenExplicit ?? env.CROSS_AGENT_TEAMS_MCP_TOKEN;
    const host = parseArg("--host", "127.0.0.1") ?? "127.0.0.1";
    const localDevice = resolveLocalDeviceLabel(parseArg("--device"));
    const requestedPort = Number(parseArg("--port", "9100"));
    const loopbackCompanion = !process.argv.includes("--no-loopback-companion");
    return {
      pidPath: parseArg("--pid-file", join(home, "daemon.pid")),
      dbPath: parseArg("--db", join(home, "data.db")),
      token,
      requestedPort,
      host,
      localDevice,
      loopbackCompanion
    };
  } finally {
    process.argv = originalArgv;
  }
}
async function runDaemon() {
  const args = parseDaemonCliArgs();
  if (!isLoopbackHost(args.host) && (!args.token || args.token.trim().length === 0)) {
    console.error("token_required_for_non_loopback_bind");
    process.exit(1);
  }
  const requested = args.requestedPort;
  const port = requested === 0 ? 0 : await selectPort([requested, requested + 1, requested + 2]);
  const r = acquirePidFile(args.pidPath, port || requested);
  if (!r.ok) {
    console.error("daemon already running pid=" + r.pid);
    process.exit(1);
  }
  const started = await startServer({
    dbPath: args.dbPath,
    token: args.token,
    port,
    host: args.host,
    localDevice: args.localDevice,
    loopbackCompanion: args.loopbackCompanion
  });
  const companion = started.loopbackCompanion;
  wireShutdown(started.app, args.pidPath, {
    extraForceClose: companion ? () => {
      try {
        companion.closeAllConnections();
      } catch {
      }
    } : void 0
  });
  const companionSuffix = companion ? ` (+ 127.0.0.1:${started.port} loopback companion)` : "";
  console.log(`listening on ${started.host}:${started.port}${companionSuffix} device=${args.localDevice}`);
}
function resolveDaemonPort(explicit) {
  if (explicit !== void 0) {
    const n = Number(explicit);
    if (Number.isInteger(n) && n > 0) return n;
    return void 0;
  }
  const pidPath = parseArg("--pid-file", join(defaultHome(), "daemon.pid"));
  if (!existsSync2(pidPath)) return void 0;
  try {
    const parsed = JSON.parse(readFileSync2(pidPath, "utf8"));
    if (typeof parsed.port === "number" && parsed.port > 0) return parsed.port;
  } catch {
  }
  return void 0;
}
async function runPreRegisterCodexPane() {
  const pane = parseArg("--pane");
  const agentId = parseArg("--agent-id");
  const ttlRaw = parseArg("--ttl");
  const tokenExplicit = parseArg("--token");
  const portExplicit = parseArg("--port");
  if (!pane || !agentId) {
    console.error("usage: cross-agent-teams-mcp pre-register-codex-pane --pane <pane_id> --agent-id <uuid> [--ttl <seconds>] [--port <n>] [--token <t>]");
    process.exit(2);
  }
  const port = resolveDaemonPort(portExplicit);
  if (!port) {
    console.error('{"ok":false,"error":"daemon_port_unresolved","detail":"pass --port or start the daemon so the pid file is present"}');
    process.exit(1);
  }
  const token = tokenExplicit ?? process.env.CROSS_AGENT_TEAMS_MCP_TOKEN;
  const host = process.env.CROSS_AGENT_TEAMS_MCP_HOST ?? "127.0.0.1";
  const base = new URL(`http://${host}:${port}/mcp`);
  const requestInit = token ? { headers: { Authorization: `Bearer ${token}` } } : void 0;
  const transport = new StreamableHTTPClientTransport(base, {
    requestInit
  });
  const client = new Client({ name: "cross-agent-teams-mcp-cli", version: "0.1.0" });
  try {
    await client.connect(transport);
    const args = {
      pane_id: pane,
      xats_agent_id: agentId
    };
    if (ttlRaw !== void 0) {
      const ttl = Number(ttlRaw);
      if (!Number.isInteger(ttl) || ttl <= 0) {
        console.error('{"ok":false,"error":"invalid_ttl"}');
        process.exit(2);
      }
      args.ttl_seconds = ttl;
    }
    const resp = await client.callTool({
      name: "pre_register_codex_pane",
      arguments: args
    });
    const content = resp.content;
    const text = content?.[0]?.text ?? "";
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
    const obj = parsed ?? {};
    if (obj.ok === true) {
      console.log(JSON.stringify(obj));
      process.exit(0);
    }
    console.error(JSON.stringify(obj));
    process.exit(1);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ ok: false, error: "cli_failed", detail: msg }));
    process.exit(1);
  } finally {
    try {
      await transport.close();
    } catch {
    }
    try {
      await client.close();
    } catch {
    }
  }
}
async function main() {
  const cmd = process.argv[2];
  if (cmd === "daemon") {
    await runDaemon();
    return;
  }
  if (cmd === "pre-register-codex-pane") {
    await runPreRegisterCodexPane();
    return;
  }
  console.error("usage: cross-agent-teams-mcp <daemon|pre-register-codex-pane> [options]");
  process.exit(2);
}
function isEntry() {
  if (process.argv[1] === void 0) return false;
  return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
}
if (isEntry()) {
  main().catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
  });
}
export {
  parseDaemonCliArgs
};

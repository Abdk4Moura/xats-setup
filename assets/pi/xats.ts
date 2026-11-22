import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { Box, Text } from "@earendil-works/pi-tui";

function resolveBaseUrl(): string {
  if (process.env.XATS_BASE_URL) return process.env.XATS_BASE_URL;
  try {
    const p = fs.readFileSync(path.join(os.homedir(), ".xats", "port"), "utf8").trim();
    const n = parseInt(p, 10);
    if (Number.isInteger(n) && n > 0 && n < 65536) return `http://127.0.0.1:${n}`;
  } catch { /* no port file */ }
  return "http://127.0.0.1:9100";
}
const baseUrl = resolveBaseUrl();
const team = process.env.XATS_TEAM ?? "default";
const role = process.env.XATS_ROLE ?? "worker";
function resolveLabel(): string | undefined {
  if (process.env.XATS_LABEL) return process.env.XATS_LABEL;
  try {
    const p = path.join(os.homedir(), ".xats", "label");
    const v = fs.readFileSync(p, "utf8").trim();
    if (v) return v;
  } catch { /* no persisted label */ }
  return undefined;
}
const label = resolveLabel();
// The label is a box-level PREFIX only. Uniqueness comes from the session
// suffix below: two Pi sessions on one box must never share one identity.
const baseName = `pi-${os.hostname()}${label ? `-${label}` : ""}`;
const NAMES_FILE = path.join(os.homedir(), ".xats", "names.json");
const BINDING_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const BINDING_CAP = 200;

type NameMode = "prefer" | "exact";
type Binding = { name: string; at: number };

/** Structured payload behind the themed inbox card (rendered by the xats-inbox renderer). */
type InboxNotice = {
  count: number;
  messages: Array<{ from: string; subject?: string; body: string; needReply: boolean }>;
};

/** Collapse a body to one tidy line for the collapsed card. */
function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1).trimEnd() + "…";
}

let name = baseName;
let nameMode: NameMode = "prefer";
let sessionKey: string | null = null;
let agentId: string | null = null;
// Explicit inbox cursor. The daemon advances its own cursor when a read omits
// since_event_id, so a read whose delivery then fails loses the message forever.
// We pass our own cursor and only advance it after a message is handed over.
let lastEventId = 0;
let cursorSeeded = false;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let inboxTimer: ReturnType<typeof setInterval> | undefined;
let pollingInbox = false;
// Delivery lease: the daemon blocks /wait for us, so mail arrives as an event
// instead of a timer tick. Falls back to polling only if unsupported.
let lease: { token: string; generation: number; expiresAt: number } | null = null;
let leaseRejected = false;
let delivering = false;
let deliveryStopped = false;
let streamAbort: AbortController | undefined;
let streamUnsupported = false;
let deliveredEvent = 0;

async function request(path: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
    signal: AbortSignal.timeout(5_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error: any = new Error(`${response.status}: ${JSON.stringify(data)}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data as any;
}

function readBindings(): Record<string, Binding> {
  try {
    const all = JSON.parse(fs.readFileSync(NAMES_FILE, "utf8"));
    const sessions = all?.sessions;
    return sessions && typeof sessions === "object" ? sessions : {};
  } catch { return {}; }
}
function readBinding(key: string): string | undefined {
  const hit = readBindings()[key];
  return hit && typeof hit.name === "string" && hit.name ? hit.name : undefined;
}
function writeBinding(key: string, value: string): void {
  try {
    const sessions = readBindings();
    sessions[key] = { name: value, at: Date.now() };
    const now = Date.now();
    let entries = Object.entries(sessions).filter(([, v]) => now - (v?.at ?? 0) < BINDING_RETENTION_MS);
    if (entries.length > BINDING_CAP) {
      entries = entries.sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0)).slice(0, BINDING_CAP);
    }
    fs.mkdirSync(path.dirname(NAMES_FILE), { recursive: true });
    fs.writeFileSync(NAMES_FILE, JSON.stringify({ version: 1, sessions: Object.fromEntries(entries) }, null, 2));
  } catch { /* best-effort: identity still works without a binding */ }
}
function sessionShort(sid: string): string | undefined {
  const cleaned = sid.trim();
  // Pi session ids are time-prefixed (ULID-like): three sessions started in the
  // same bucket share their LEADING characters, so slicing the head would hand
  // them the same suffix. Hash the whole id for a uniformly spread, stable one.
  return cleaned ? createHash("sha256").update(cleaned).digest("hex").slice(0, 8) : undefined;
}
// Precedence: XATS_NAME (exact) > session binding (exact) > base-session (prefer).
function resolveIdentity(ctx: any): void {
  const sid = String(ctx?.sessionManager?.getSessionId?.() ?? "").trim();
  sessionKey = sid || null;
  const explicit = process.env.XATS_NAME?.trim();
  if (explicit) { name = explicit; nameMode = "exact"; return; }
  const bound = sid ? readBinding(sid) : undefined;
  if (bound) { name = bound; nameMode = "exact"; return; }
  const short = (sid && sessionShort(sid)) || randomUUID().slice(0, 8);
  name = `${baseName}-${short}`;
  nameMode = "prefer";
}

async function register() {
  const data = await request("/api/register", {
    method: "POST",
    body: JSON.stringify({
      name,
      team,
      role,
      agent_type: "custom",
      agent_type_name: "pi",
      session_key: sessionKey ?? undefined,
      name_mode: nameMode,
      // Ask for the delivery lease so mail wakes this session instead of
      // being discovered by a three-second inbox scan.
      local_delivery: Boolean(sessionKey),
    }),
  });
  agentId = data.agent_id;
  if (data.local_delivery?.token) {
    lease = {
      token: String(data.local_delivery.token),
      generation: Number(data.local_delivery.generation),
      expiresAt: Date.parse(String(data.local_delivery.expiresAt)),
    };
    leaseRejected = false;
  }
  // In prefer mode the daemon may disambiguate (name-2). Adopt whatever it
  // assigned so peers and this session agree on the return address.
  if (typeof data.name === "string" && data.name) name = data.name;
  return agentId;
}

async function keepAlive() {
  try {
    if (!agentId) return await register();
    await request("/api/heartbeat", { method: "POST", body: JSON.stringify({ agent_id: agentId }) });
    return agentId;
  } catch {
    // A daemon restart or TTL reaping invalidates the old id. Re-register with
    // the stable name so peers can continue addressing this Pi session.
    try { return await register(); } catch { return null; }
  }
}

export default function (pi: ExtensionAPI) {
  const leaseHeaders = () => (lease ? { "X-Xats-Delivery-Token": lease.token } : {});
  let delivered: { attempt_id: string; event_id: number; generation: number } | null = null;

  async function longRequest(path: string, init: RequestInit, ms: number) {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init.headers },
      signal: AbortSignal.timeout(ms),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error: any = new Error(`${response.status}: ${JSON.stringify(data)}`);
      error.status = response.status;
      throw error;
    }
    return data as any;
  }

  async function ackStage(attemptId: string, stage: string, generation?: number) {
    if (!lease) return false;
    try {
      await request("/api/local-delivery/ack", {
        method: "POST",
        headers: leaseHeaders(),
        body: JSON.stringify({ attempt_id: attemptId, stage,
          ...(generation !== undefined && stage === "inbox-consumed" ? {} : {}) }),
      });
      return true;
    } catch {
      // A lost ack repeats the same attempt; nothing here may resubmit a turn.
      return false;
    }
  }

  async function ensureLease(): Promise<boolean> {
    if (lease && lease.expiresAt - Date.now() > 15_000) return true;
    if (lease) {
      try {
        const data = await request("/api/local-delivery/renew", { method: "POST", headers: leaseHeaders() });
        lease.expiresAt = Date.parse(String(data.expiresAt));
        if (Number.isInteger(data.generation)) lease.generation = Number(data.generation);
        return true;
      } catch (error: any) {
        if (error?.status === 401 || error?.status === 409) lease = null;
        else return true; // transient: keep owning and retry the wait
      }
    }
    if (!agentId) return false;
    try {
      // Re-registering reissues the lease for this same durable identity.
      await request("/api/register", {
        method: "POST",
        body: JSON.stringify({ name, team, role, agent_type: "custom", agent_type_name: "pi",
          session_key: sessionKey ?? undefined, name_mode: nameMode, local_delivery: Boolean(sessionKey) }),
      }).then((data: any) => {
        if (data?.local_delivery?.token) {
          lease = { token: String(data.local_delivery.token), generation: Number(data.local_delivery.generation),
            expiresAt: Date.parse(String(data.local_delivery.expiresAt)) };
        } else lease = null;
      });
    } catch { /* keep trying */ }
    return Boolean(lease);
  }

  async function deliveredSince(eventId: number): Promise<boolean> {
    try {
      const data = await request(`/api/cursor?agent_id=${encodeURIComponent(agentId ?? "")}`);
      return (Number(data.last_processed_event_id) || 0) >= eventId;
    } catch { return false; }
  }

  async function handleHint(hint: any): Promise<void> {
    if (!lease || hint.generation !== lease.generation) throw Object.assign(new Error("stale generation"), { status: 409 });
    const event = Number(hint.event_id);
    if (!Number.isInteger(event) || event < 1) return;
    // Backlog seeded at session start is history, not new mail: never replay it
    // as a fresh turn after a restart.
    if (event <= lastEventId) { await ackStage(String(hint.attempt_id), "inbox-consumed"); return; }
    if (await deliveredSince(event)) {
      await ackStage(String(hint.attempt_id), "inbox-consumed");
      return;
    }
    const data = await request(`/api/inbox?team=${encodeURIComponent(team)}&name=${encodeURIComponent(name)}&since_event_id=${event - 1}`);
    const messages = (data.messages ?? []).filter((m: any) => Number(m.event_id) === event &&
      (!hint.message_id || m.id === hint.message_id || m.message_id === hint.message_id));
    if (!messages.length) {
      // Already read through MCP: the daemon reconciles this as consumed.
      await ackStage(String(hint.attempt_id), "inbox-consumed");
      return;
    }
    submitNotices(messages);
    delivered = { attempt_id: String(hint.attempt_id), event_id: event, generation: Number(hint.generation) };
    await ackStage(String(hint.attempt_id), "host-queued");
    for (const m of messages) lastEventId = Math.max(lastEventId, Number(m.event_id) || 0);
  }

  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  // True push: one held connection, hints written as they commit. Falls back to
  // the lease long-poll, then to polling, only on explicit unsupported answers.
  async function eventStreamLoop(): Promise<void> {
    delivering = true;
    while (!deliveryStopped) {
      if (!agentId || !(await ensureLease())) { await sleep(1500); continue; }
      const abort = new AbortController();
      streamAbort = abort;
      try {
        const response = await fetch(`${baseUrl}/api/local-delivery/events`, {
          headers: { ...leaseHeaders(), Accept: "text/event-stream" }, signal: abort.signal,
        });
        if (response.status === 404 || response.status === 501) {
          streamUnsupported = true;
          delivering = false;
          void deliveryLoop();
          return;
        }
        if (response.status === 401 || response.status === 409) { lease = null; continue; }
        if (!response.ok || !response.body) throw new Error(`stream ${response.status}`);
        const reader = response.body.getReader();
        let buffer = "";
        let event = "";
        while (!deliveryStopped) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += Buffer.from(value).toString("utf8");
          let index: number;
          while ((index = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, index).replace(/\r$/, "");
            buffer = buffer.slice(index + 1);
            if (line.startsWith("event: ")) event = line.slice(7).trim();
            else if (line.startsWith("data: ") && event === "hint") {
              try { await handleHint(JSON.parse(line.slice(6))); } catch { /* one bad hint never kills the stream */ }
              event = "";
            } else if (line === "") event = "";
          }
        }
      } catch { /* connection lost: reconnect below */ }
      finally {
        abort.abort();
        if (streamAbort === abort) streamAbort = undefined;
      }
      if (!deliveryStopped) await sleep(1000);
    }
    delivering = false;
  }

  async function deliveryLoop(): Promise<void> {
    delivering = true;
    while (!deliveryStopped) {
      if (!agentId || !(await ensureLease())) {
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      // A turn we started has since been read: move the attempt forward.
      if (delivered && await deliveredSince(delivered.event_id)) {
        await ackStage(delivered.attempt_id, "inbox-consumed");
        delivered = null;
      }
      try {
        const data = await longRequest("/api/local-delivery/wait?timeout_ms=20000",
          { method: "GET", headers: leaseHeaders() }, 25_000);
        const hint = (data.hints ?? [])[0];
        if (hint) await handleHint(hint);
      } catch (error: any) {
        if (error?.status === 401 || error?.status === 409) { lease = null; continue; }
        // Only an explicit unsupported capability before any owned delivery can
        // choose polling. A network blip keeps the lease and retries.
        if ((error?.status === 404 || error?.status === 501) && !delivered) {
          delivering = false;
          startPoll();
          return;
        }
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    delivering = false;
  }

  function submitNotices(messages: any[]) {
    const summary = messages.map((m: any) =>
      `- from ${m.from_name}${m.subject ? `: ${m.subject}` : ""}${m.need_reply ? " (needs reply)" : ""}\n${m.body}`,
    ).join("\n\n");
    const notice: InboxNotice = {
      count: messages.length,
      messages: messages.map((m: any) => ({
        from: String(m.from_name ?? "unknown"),
        subject: m.subject ? String(m.subject) : undefined,
        body: String(m.body ?? ""),
        needReply: Boolean(m.need_reply),
      })),
    };
    pi.sendMessage(
      {
        customType: "xats-inbox",
        content: `<xats-inbox>\n${messages.length} new cross-agent message(s):\n${summary}\n\nAct on these messages now. If a message needs a reply, reply with xats_send.\n</xats-inbox>`,
        display: true,
        details: notice,
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  }

  async function pollInbox() {
    if (!agentId || pollingInbox) return;
    pollingInbox = true;
    try {
      // Seed once past the backlog so installing the extension does not replay
      // history, using an explicit since (which never advances the daemon cursor).
      if (!cursorSeeded) {
        const backlog = await request(`/api/inbox?team=${encodeURIComponent(team)}&name=${encodeURIComponent(name)}&since_event_id=0`);
        for (const m of backlog.messages ?? []) lastEventId = Math.max(lastEventId, Number(m.event_id) || 0);
        cursorSeeded = true;
        return;
      }
      const data = await request(
        `/api/inbox?team=${encodeURIComponent(team)}&name=${encodeURIComponent(name)}&since_event_id=${lastEventId}`,
      );
      const messages = data.messages ?? [];
      if (!messages.length) return;
      const summary = messages.map((m: any) =>
        `- from ${m.from_name}${m.subject ? `: ${m.subject}` : ""}${m.need_reply ? " (needs reply)" : ""}\n${m.body}`,
      ).join("\n\n");
      const notice: InboxNotice = {
        count: messages.length,
        messages: messages.map((m: any) => ({
          from: String(m.from_name ?? "unknown"),
          subject: m.subject ? String(m.subject) : undefined,
          body: String(m.body ?? ""),
          needReply: Boolean(m.need_reply),
        })),
      };
      // A custom message, not a user message. It still enters LLM context and,
      // with triggerTurn, still starts a turn when the agent is idle; the
      // difference is that peers' mail no longer masquerades as something the
      // user typed, and the card is drawn by the xats-inbox renderer.
      pi.sendMessage(
        {
          customType: "xats-inbox",
          content: `<xats-inbox>\n${messages.length} new cross-agent message(s):\n${summary}\n\nAct on these messages now. If a message needs a reply, reply with xats_send.\n</xats-inbox>`,
          display: true,
          details: notice,
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
      // Only now is it safe to move the cursor: delivery succeeded.
      for (const m of messages) lastEventId = Math.max(lastEventId, Number(m.event_id) || 0);
    } catch {
      // Delivery failed (session busy, host refused) — leave the cursor alone so
      // the next tick retries instead of silently dropping peer mail.
    } finally {
      pollingInbox = false;
    }
  }

  function startPoll() {
    if (inboxTimer) return;
    inboxTimer = setInterval(() => { void pollInbox(); }, 3000);
  }


  pi.on("session_start", async (_event, ctx) => {
    resolveIdentity(ctx);
    const id = await keepAlive();
    // Continue trying even if startup races the daemon service. It also
    // self-heals after daemon restarts and TTL reaping.
    heartbeatTimer = setInterval(() => { void keepAlive(); }, 30_000);
    // Polling is the delivery path: our daemon exposes no event stream, and a
    // 3 s tick is imperceptible for agent-to-agent coordination.
    // Event-driven delivery: block on the daemon instead of scanning on a timer.
    if (lease) {
      deliveryStopped = false;
      if (!cursorSeeded) {
        try {
          const backlog = await request(`/api/inbox?team=${encodeURIComponent(team)}&name=${encodeURIComponent(name)}&since_event_id=0`);
          for (const m of backlog.messages ?? []) lastEventId = Math.max(lastEventId, Number(m.event_id) || 0);
          cursorSeeded = true;
        } catch { /* seed on the next loop iteration */ }
      }
      if (streamUnsupported) void deliveryLoop();
      else void eventStreamLoop();
    }
    else startPoll();
    ctx.ui.setStatus("xats", ctx.ui.theme.fg("muted", id ? `xats: ${name}` : "xats: daemon unavailable"));
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    deliveryStopped = true;
    streamAbort?.abort();
    delivered = null;
    lease = null;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (inboxTimer) clearInterval(inboxTimer);
    heartbeatTimer = undefined;
    inboxTimer = undefined;
    const id = agentId;
    agentId = null;
    ctx.ui.setStatus("xats", "");
    if (id) await request("/api/deregister", {
      method: "POST",
      // Retain the durable identity and mailbox: a reload or resume must come
      // back as the same agent_id, not a brand-new one. Without a session key
      // there is nothing to prove ownership with, so keep the old delete path.
      body: JSON.stringify({ agent_id: id, session_key: sessionKey ?? undefined,
        retain_mailbox: Boolean(sessionKey) }),
    }).catch(() => undefined);
  });

  // Themed card for the inbox notification. The model still receives the
  // <xats-inbox> payload; this only changes what the person sees.
  pi.registerMessageRenderer<InboxNotice>("xats-inbox", (message, { expanded, outputPad }, theme) => {
    const d = message.details;
    if (!d) return undefined;
    const gutter = theme.fg("borderMuted", "│");
    const replyNeed = d.messages.filter((m) => m.needReply).length;
    const lines: string[] = [
      [
        theme.fg("accent", "✉"),
        theme.bold(theme.fg("customMessageLabel", "xats inbox")),
        theme.fg("muted", "·"),
        theme.fg("muted", `${d.count} new${replyNeed ? ` · ${replyNeed} need${replyNeed === 1 ? "s" : ""} reply` : ""}`),
      ].join(" "),
    ];
    for (const m of d.messages) {
      const badge = m.needReply ? " " + theme.fg("warning", "⚠ needs reply") : "";
      lines.push(`${gutter} ${theme.fg("accent", m.from)}${badge}`);
      if (m.subject) lines.push(`${gutter}   ${theme.bold(m.subject)}`);
      const body = m.body.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
      const shown = expanded ? body : body.slice(0, 1);
      for (const l of shown) lines.push(`${gutter}   ${theme.fg("dim", expanded ? l : clip(l, 96))}`);
      if (!expanded && body.length > 1) {
        lines.push(`${gutter}   ${theme.fg("muted", `… ${body.length - 1} more line(s) · ctrl+o expands`)}`);
      }
    }
    // Draw in the same padded, tinted shell Pi uses for its own custom
    // messages. A bare Text reads as loose transcript output; the Box is what
    // makes the card look native.
    const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Text(lines.join("\n"), 0, 0));
    return box;
  });

  pi.registerTool({
    name: "xats_whoami", label: "Xats Who Am I", description: "Show this Pi agent's xats identity and return address.", parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text", text: `You are \"${name}\" on xats (team ${team}, role ${role}, agent_id ${agentId ?? "unregistered"}).` }], details: {} }; },
  });
  pi.registerTool({
    name: "xats_claim_name",
    label: "Xats Claim Name",
    description: "Assume a specific xats name (e.g. a director assigns 'lend-gpu-worker'). Refuses if a live agent already holds it on your team. The name binds to this session, so it survives resume but not a brand-new session; set XATS_NAME to pin one across restarts.",
    parameters: Type.Object({ name: Type.String({ description: "The name to assume, e.g. 'lend-gpu-worker'" }) }),
    async execute(_id, args) {
      const desired = String((args as any).name ?? "").trim();
      if (!desired) return { content: [{ type: "text", text: "name required" }], details: {}, isError: true };
      const previousId = agentId;
      try {
        const data = await request("/api/register", {
          method: "POST",
          body: JSON.stringify({
            name: desired,
            team,
            role,
            agent_type: "custom",
            agent_type_name: "pi",
            session_key: sessionKey ?? undefined,
            name_mode: "exact",
          }),
        });
        name = typeof data.name === "string" && data.name ? data.name : desired;
        nameMode = "exact";
        agentId = data.agent_id;
        if (sessionKey) writeBinding(sessionKey, name);
        if (previousId && previousId !== agentId) {
          await request("/api/deregister", { method: "POST", body: JSON.stringify({ agent_id: previousId }) }).catch(() => undefined);
        }
        // Delivery polls by name, so a rename takes effect on the next tick;
        // there is no open stream to re-key.
              return { content: [{ type: "text", text: `Now registered as \"${name}\" (team ${team}, role ${role}, agent_id ${agentId}). Give peers \"${name}\" as your return address.` }], details: {} };
      } catch (error: any) {
        if (error?.status === 409) {
          return { content: [{ type: "text", text: `\"${desired}\" is already taken by a live agent on team ${team}. Pick another name, or set XATS_NAME to pin it.` }], details: {}, isError: true };
        }
        return { content: [{ type: "text", text: `claim error: ${error}` }], details: {}, isError: true };
      }
    },
  });
  pi.registerTool({
    name: "xats_agents", label: "Xats Agents", description: "List online xats agents on a team.",
    parameters: Type.Object({ team: Type.Optional(Type.String({ description: "Team, defaults to your team" })) }),
    async execute(_id, args) {
      try { const data = await request(`/api/agents?team=${encodeURIComponent(args.team ?? team)}`); const agents = Array.isArray(data) ? data : data.agents ?? []; return { content: [{ type: "text", text: agents.length ? agents.map((a: any) => `${a.name} | ${a.agent_type_name ?? a.agent_type} | ${a.online ? "online" : "offline"}`).join("\n") : "no agents" }], details: {} }; }
      catch (error) { return { content: [{ type: "text", text: `xats agents error: ${error}` }], details: {}, isError: true }; }
    },
  });
  pi.registerTool({
    name: "xats_inbox", label: "Xats Inbox", description: "Read new xats messages addressed to this Pi agent.", parameters: Type.Object({}),
    async execute() {
      try { const data = await request(`/api/inbox?team=${encodeURIComponent(team)}&name=${encodeURIComponent(name)}`); const messages = data.messages ?? []; const text = messages.length ? messages.map((m: any) => `[${m.from_name}]${m.subject ? ` ${m.subject}` : ""}${m.need_reply ? " (needs reply)" : ""}\n${m.body}`).join("\n\n---\n\n") : "inbox empty"; return { content: [{ type: "text", text }], details: {} }; }
      catch (error) { return { content: [{ type: "text", text: `xats inbox error: ${error}` }], details: {}, isError: true }; }
    },
  });
  pi.registerTool({
    name: "xats_send", label: "Xats Send", description: "Send a message to another xats agent by name.",
    parameters: Type.Object({ to: Type.String(), body: Type.String(), subject: Type.Optional(Type.String()), to_team: Type.Optional(Type.String()), need_reply: Type.Optional(Type.Boolean()) }),
    async execute(_id, args) {
      try { const data = await request("/api/send", { method: "POST", body: JSON.stringify({ from: { team, name }, to: { name: args.to, team: args.to_team ?? team }, subject: args.subject, body: args.body, need_reply: args.need_reply ?? false }) }); return { content: [{ type: "text", text: `sent to ${args.to} (message_id ${data.message_id ?? "?"})` }], details: {} }; }
      catch (error) { return { content: [{ type: "text", text: `xats send error: ${error}` }], details: {}, isError: true }; }
    },
  });
}

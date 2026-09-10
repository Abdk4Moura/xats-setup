import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";

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

let name = baseName;
let nameMode: NameMode = "prefer";
let sessionKey: string | null = null;
let agentId: string | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let inboxTimer: ReturnType<typeof setInterval> | undefined;
let es: any = null;
let pollingInbox = false;

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
    }),
  });
  agentId = data.agent_id;
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
  async function pollInbox() {
    if (!agentId || pollingInbox) return;
    pollingInbox = true;
    try {
      const data = await request(`/api/inbox?team=${encodeURIComponent(team)}&name=${encodeURIComponent(name)}`);
      const messages = data.messages ?? [];
      if (!messages.length) return;
      const summary = messages.map((m: any) =>
        `- from ${m.from_name}${m.subject ? `: ${m.subject}` : ""}${m.need_reply ? " (needs reply)" : ""}\n${m.body}`,
      ).join("\n\n");
      // A real user message is intentionally used here: it is visible in the
      // session and starts a turn (or queues a follow-up if Pi is busy).
      pi.sendUserMessage(`<xats-inbox>\n${messages.length} new cross-agent message(s):\n${summary}\n\nAct on these messages now. If a message needs a reply, reply with xats_send.\n</xats-inbox>`, { deliverAs: "followUp" });
    } catch {
      // The daemon may be restarted independently. The next interval retries.
    } finally {
      pollingInbox = false;
    }
  }

  function startPoll() {
    if (inboxTimer) return;
    inboxTimer = setInterval(() => { void pollInbox(); }, 3000);
  }
  function startSse() {
    const url = `${baseUrl}/api/events?team=${encodeURIComponent(team)}&name=${encodeURIComponent(name)}`;
    try {
      const ES = (globalThis as any).EventSource;
      if (!ES) throw new Error('no ES');
      es = new ES(url);
      es.onmessage = () => { void pollInbox(); };
      es.onerror = () => {
        try { es?.close(); } catch { /* ignore: closing a dead stream */ }
        es = null;
        startPoll();
      };
    } catch {
      startPoll();
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    resolveIdentity(ctx);
    const id = await keepAlive();
    // Continue trying even if startup races the daemon service. It also
    // self-heals after daemon restarts and TTL reaping.
    heartbeatTimer = setInterval(() => { void keepAlive(); }, 30_000);
    // Prefer SSE push, fallback to polling
    startSse();
    // fallback poll if SSE not connected within 4s
    setTimeout(() => { if (!es) startPoll(); }, 4000);
    ctx.ui.setStatus("xats", id ? `xats: ${name}` : "xats: daemon unavailable");
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (inboxTimer) clearInterval(inboxTimer);
    if (es) { try { es.close(); } catch { /* ignore: closing a dead stream */ } es = null; }
    heartbeatTimer = undefined;
    inboxTimer = undefined;
    const id = agentId;
    agentId = null;
    ctx.ui.setStatus("xats", "");
    if (id) await request("/api/deregister", { method: "POST", body: JSON.stringify({ agent_id: id }) }).catch(() => undefined);
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
        // The open SSE stream (and its inbox filter) was opened under the old
        // name; reconnect it so delivery follows the new return address.
        if (es) { try { es.close(); } catch { /* ignore */ } es = null; }
        startSse();
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

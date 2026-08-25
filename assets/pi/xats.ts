import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

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
const name = label ? `pi-${os.hostname()}-${label}` : `pi-${os.hostname()}-${randomUUID().slice(0, 8)}`;
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
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(data)}`);
  return data as any;
}

async function register() {
  const data = await request("/api/register", {
    method: "POST",
    body: JSON.stringify({ name, team, role, agent_type: "custom", agent_type_name: "pi" }),
  });
  agentId = data.agent_id;
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
        try { es?.close(); } catch {}
        es = null;
        startPoll();
      };
    } catch {
      startPoll();
    }
  }

  pi.on("session_start", async (_event, ctx) => {
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
    if (es) { try { es.close(); } catch {} es = null; }
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

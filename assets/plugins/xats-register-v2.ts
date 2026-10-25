/*
 * xats OpenCode v2 plugin.
 * Each OpenCode session gets its own xats identity. Plugin state is shared by
 * location, so handlers always use the invoking tool's sessionID rather than
 * a single mutable "current session".
 */
import { Plugin } from "@opencode/plugin"
import * as os from "node:os"
import fs from "node:fs"
import path from "node:path"
import { randomUUID, createHash } from "node:crypto"

const XATS_BASE = (() => {
  if (process.env.XATS_BASE_URL) return process.env.XATS_BASE_URL
  try {
    const n = Number.parseInt(fs.readFileSync(path.join(os.homedir(), ".xats", "port"), "utf8").trim(), 10)
    if (Number.isInteger(n) && n > 0 && n < 65536) return `http://127.0.0.1:${n}`
  } catch { /* use default */ }
  return "http://127.0.0.1:9100"
})()
const XATS_DB = path.join(os.homedir(), ".cross-agent-teams-mcp", "data.db")
const HEARTBEAT_INTERVAL_MS = 30_000
const RECEIVE_POLL_MS = 3_000
const BINDING_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const BINDING_CAP = 200

type AgentSession = {
  sessionID: string
  name: string
  nameMode: "prefer" | "exact"
  agentID: string | null
  lastEventId: number
  registering?: Promise<AgentSession | null>
  polling?: boolean
  announced?: boolean
}
type XatsAgent = { agent_id: string; name: string; team?: string; device?: string; online?: boolean; role?: string; agent_type?: string; agent_type_name?: string }

function sessionShort(sid: string): string {
  return createHash("sha256").update(sid.trim()).digest("hex").slice(0, 8)
}
function readBindings(file: string): Record<string, { name: string; at: number }> {
  try {
    const all = JSON.parse(fs.readFileSync(file, "utf8"))
    return all?.sessions && typeof all.sessions === "object" ? all.sessions : {}
  } catch { return {} }
}
function writeBinding(file: string, sid: string, name: string): void {
  try {
    const sessions = readBindings(file)
    sessions[sid] = { name, at: Date.now() }
    let entries = Object.entries(sessions).filter(([, value]) => Date.now() - ((value as any)?.at ?? 0) < BINDING_RETENTION_MS)
    if (entries.length > BINDING_CAP) entries = entries.sort((a, b) => ((b[1] as any)?.at ?? 0) - ((a[1] as any)?.at ?? 0)).slice(0, BINDING_CAP)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ version: 1, sessions: Object.fromEntries(entries) }, null, 2))
  } catch { /* identity still works without persistent bindings */ }
}
async function jsonRequest(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, init)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw Object.assign(new Error(data?.error || `HTTP ${response.status}`), { status: response.status, data })
  return data
}
function post(body: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
}

const input = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
})
const stringArg = (description: string) => ({ type: "string", description })
const boolArg = (description: string) => ({ type: "boolean", description })

export default Plugin.define({
  id: "xats.register",
  async setup(ctx) {
    const hostname = os.hostname()
    const kind = process.env.XATS_AGENT_KIND || "opencode"
    const team = process.env.XATS_TEAM ?? "default"
    const label = process.env.XATS_LABEL
    const role = process.env.XATS_ROLE ?? "worker"
    const baseName = `${kind}-${hostname}${label ? `-${label}` : ""}`
    const namesFile = path.join(os.homedir(), ".xats", "names.json")
    const agents = new Map<string, AgentSession>()
    const pending = new Map<string, Promise<AgentSession | null>>()
    let db: any = null
    let closed = false
    const eventController = new AbortController()

    function identity(sid: string): { name: string; nameMode: "prefer" | "exact" } {
      const explicit = process.env.XATS_NAME?.trim()
      const bound = readBindings(namesFile)[sid]?.name
      if (bound) return { name: bound, nameMode: "exact" }
      // Even an explicit prefix must not collapse two tabs into one bus address.
      if (explicit) return { name: `${explicit}-${sessionShort(sid)}`, nameMode: "exact" }
      return { name: `${baseName}-${sessionShort(sid)}`, nameMode: "prefer" }
    }

    async function registerAgent(state: AgentSession): Promise<string | null> {
      try {
        const data = await jsonRequest(`${XATS_BASE}/api/register`, post({
          name: state.name,
          team,
          role,
          agent_type: "custom",
          agent_type_name: kind,
          session_key: state.sessionID,
          name_mode: state.nameMode,
        }))
        if (typeof data?.name === "string" && data.name) state.name = data.name
        return typeof data?.agent_id === "string" ? data.agent_id : null
      } catch (error: any) {
        if (error?.status !== 409) console.warn("[xats] session registration failed", error?.message ?? error)
        return null
      }
    }

    async function ensureSession(sessionID: string): Promise<AgentSession | null> {
      if (closed || !sessionID) return null
      const existing = agents.get(sessionID)
      if (existing?.agentID) return existing
      const running = pending.get(sessionID)
      if (running) return running
      const state = existing ?? { sessionID, ...identity(sessionID), agentID: null, lastEventId: 0 }
      agents.set(sessionID, state)
      const task = (async () => {
        const agentID = await registerAgent(state)
        if (!agentID) return null
        if (closed) {
          await jsonRequest(`${XATS_BASE}/api/deregister`, post({ agent_id: agentID })).catch(() => {})
          return null
        }
        state.agentID = agentID
        if (db) {
          try {
            state.lastEventId = db.query("SELECT COALESCE(MAX(event_id),0) m FROM messages WHERE to_agent_id = ?").get(agentID)?.m ?? 0
          } catch { /* receiver will retry */ }
        }
        if (!state.announced) {
          state.announced = true
          try {
            await ctx.session.synthetic({
              sessionID,
              text: `<xats-identity>You are on the xats bus as "${state.name}" (team ${team}, role ${role}, agent_id ${agentID}). You are an OpenCode agent; use xats_send, xats_agents, and xats_inbox to coordinate. This session's return address is "${state.name}".</xats-identity>`,
              resume: false,
            })
          } catch { /* session may have been deleted while registering */ }
        }
        return state
      })().finally(() => pending.delete(sessionID))
      pending.set(sessionID, task)
      return task
    }

    async function deregister(state: AgentSession): Promise<void> {
      const id = state.agentID
      state.agentID = null
      if (!id) return
      try { await jsonRequest(`${XATS_BASE}/api/deregister`, post({ agent_id: id })) } catch { /* reaper handles stale rows */ }
    }

    async function getAgents(targetTeam: string): Promise<XatsAgent[]> {
      const data = await jsonRequest(`${XATS_BASE}/api/agents?team=${encodeURIComponent(targetTeam)}`)
      return Array.isArray(data) ? data : data.agents ?? []
    }

    async function smartFallback(from: AgentSession, to: string, body: string, subject?: string, needReply = false, targetTeam = team): Promise<string> {
      try {
        const matches = (await getAgents(targetTeam)).filter((agent) => agent.name === to)
        if (!matches.length) return `xats send failed: "${to}" not found anywhere on the mesh`
        const best = matches.find((agent) => agent.online) || matches[0]
        const retryTo = best.device ? `${best.name}:${best.device}` : best.name
        const result = await jsonRequest(`${XATS_BASE}/api/send`, post({
          from: { team, name: from.name },
          to: { name: retryTo, team: targetTeam },
          subject,
          body,
          need_reply: needReply,
        }))
        return `sent to ${retryTo}${matches.length > 1 ? ` (${matches.length} matches; sent to ${best.device || "local"})` : ""} (message_id ${result.message_id ?? "?"})`
      } catch (error: any) { return `xats fallback error: ${error?.message ?? error}` }
    }

    async function sendMessage(from: AgentSession, to: string, body: string, subject?: string, needReply = false, targetTeam = team): Promise<string> {
      if (!from.agentID) return `xats send failed: this session is not registered`
      try {
        const result = await jsonRequest(`${XATS_BASE}/api/send`, post({
          from: { team, name: from.name },
          to: { name: to, team: targetTeam },
          subject,
          body,
          need_reply: needReply,
        }))
        return `sent to ${to} (message_id ${result.message_id ?? "?"}, recipients ${(result.recipients ?? []).length})`
      } catch (error: any) {
        if (error?.data?.error === "unknown_recipient") return smartFallback(from, to, body, subject, needReply, targetTeam)
        return `xats send failed: ${error?.message ?? error}`
      }
    }

    async function pollSession(state: AgentSession): Promise<void> {
      if (!db || !state.agentID || state.polling || closed) return
      state.polling = true
      try {
        const rows = db.query("SELECT event_id, subject, need_reply, from_agent_id FROM messages WHERE to_agent_id = ? AND event_id > ? ORDER BY event_id ASC LIMIT 20").all(state.agentID, state.lastEventId) as any[]
        if (!rows.length) return
        const lines = rows.map((row) => {
          const sender = db.query("SELECT name FROM agents WHERE agent_id = ?").get(row.from_agent_id)?.name || String(row.from_agent_id || "unknown").slice(0, 8)
          return `- from ${sender}${row.subject ? `: ${row.subject}` : ""}${row.need_reply ? " (needs reply)" : ""}`
        })
        const text = ["<xats-inbox>", `${rows.length} new cross-agent message(s):`, ...lines, "Call the xats_inbox tool to read the full bodies and act on them.", "</xats-inbox>"].join("\n")
        await ctx.session.synthetic({ sessionID: state.sessionID, text, description: "xats inbox" })
        for (const row of rows) state.lastEventId = Math.max(state.lastEventId, row.event_id)
      } catch (error) { console.warn("[xats] receive delivery failed", error) }
      finally { state.polling = false }
    }

    // Windows filesystems are case-insensitive but path.resolve keeps the case it
    // was given, so comparing raw resolved strings silently drops sessions when
    // the host reports C:\\Users\\Agboola and the location says C:\\Users\\agboola.
    function sameDirectory(a: string, b: string): boolean {
      const left = path.resolve(a)
      const right = path.resolve(b)
      return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
    }

    async function belongsToLocation(sessionID: string, event: any): Promise<boolean> {
      const eventDirectory = event?.data?.location?.directory ?? event?.location?.directory
      if (typeof eventDirectory === "string" && !sameDirectory(eventDirectory, ctx.location.directory)) return false
      try {
        const result = await ctx.session.get({ sessionID }) as any
        const session = result?.data ?? result
        const directory = session?.location?.directory
        return typeof directory !== "string" || sameDirectory(directory, ctx.location.directory)
      } catch { return false }
    }

    async function eventLoop(): Promise<void> {
      try {
        for await (const event of ctx.event.subscribe({ signal: eventController.signal })) {
          const sid = (event as any).data?.sessionID
          if (event.type === "session.deleted") {
            const state = typeof sid === "string" ? agents.get(sid) : undefined
            if (state) {
              agents.delete(state.sessionID)
              await deregister(state)
            }
            continue
          }
          if (event.type === "session.moved") {
            const state = typeof sid === "string" ? agents.get(sid) : undefined
            const directory = (event as any).data?.directory
            if (state && directory && !sameDirectory(directory, ctx.location.directory)) {
              agents.delete(state.sessionID)
              await deregister(state)
            }
            continue
          }
          // `session.list` is not exposed by the v2.0 Promise plugin API. Observe
          // creation and activity events so resumed sessions are registered too.
          if (typeof sid === "string" && await belongsToLocation(sid, event)) void ensureSession(sid)
        }
      } catch (error) {
        if (!eventController.signal.aborted) console.warn("[xats] event subscription ended", error)
      }
    }

    try {
      const sqlite = await import("bun:sqlite")
      db = new sqlite.Database(XATS_DB, { readonly: true })
    } catch { /* V2 tools remain available without Bun SQLite auto-receive */ }

    // Subscribe before accepting tools; the v2 event feed discovers newly
    // created and resumed session IDs without a location-wide mutable session.
    void eventLoop()

    const heartbeat = setInterval(() => {
      for (const state of agents.values()) if (state.agentID) void fetch(`${XATS_BASE}/api/heartbeat`, post({ agent_id: state.agentID })).catch(() => {})
    }, HEARTBEAT_INTERVAL_MS)
    const receive = setInterval(() => {
      for (const state of agents.values()) void pollSession(state)
    }, RECEIVE_POLL_MS)

    const resolveToolSession = async (sessionID: string): Promise<AgentSession | null> => ensureSession(sessionID)
    const toolDefs: any[] = [
      {
        name: "xats_send",
        description: "Send a cross-agent xats message by recipient name.",
        input: input({ to: stringArg("Recipient agent name"), body: stringArg("Message body"), subject: stringArg("Short subject line"), to_team: stringArg("Recipient team; defaults to this session's team"), need_reply: boolArg("Whether a reply is expected") }, ["to", "body"]),
        execute: async (args: any, toolContext: any) => {
          const state = await resolveToolSession(toolContext.sessionID)
          return { content: state ? await sendMessage(state, args.to, args.body, args.subject, args.need_reply ?? false, args.to_team ?? team) : "xats send failed: session is not available" }
        },
      },
      {
        name: "xats_inbox",
        description: "Read this session's xats inbox.",
        input: input({}),
        execute: async (_args: any, toolContext: any) => {
          const state = await resolveToolSession(toolContext.sessionID)
          if (!state) return { content: "xats inbox unavailable: session is not registered" }
          try {
            const data = await jsonRequest(`${XATS_BASE}/api/inbox?team=${encodeURIComponent(team)}&name=${encodeURIComponent(state.name)}`)
            const messages = data.messages ?? []
            return { content: messages.length ? messages.map((message: any) => `[${message.from_name}${message.from_team && message.from_team !== team ? `@${message.from_team}` : ""}]${message.subject ? ` ${message.subject}` : ""}${message.need_reply ? " (needs reply)" : ""}\n${message.body}`).join("\n\n---\n\n") : "inbox empty (no new messages)" }
          } catch (error: any) { return { content: `xats inbox error: ${error?.message ?? error}` } }
        },
      },
      {
        name: "xats_agents",
        description: "List agents on the xats team.",
        input: input({ team: stringArg("Team name")}),
        execute: async (args: any) => {
          try {
            const list = await getAgents(args.team ?? team)
            return { content: list.length ? list.map((agent) => `${agent.name} | ${agent.agent_type_name || agent.agent_type} | ${agent.online ? "online" : "offline"}`).join("\n") : `no agents on team ${args.team ?? team}` }
          } catch (error: any) { return { content: `xats agents error: ${error?.message ?? error}` } }
        },
      },
      {
        name: "xats_whoami",
        description: "Show this OpenCode session's xats identity.",
        input: input({}),
        execute: async (_args: any, toolContext: any) => {
          const state = await resolveToolSession(toolContext.sessionID)
          return { content: state ? `You are \"${state.name}\" on the xats bus (team ${team}, role ${role}, agent_id ${state.agentID ?? "unregistered"}, session ${state.sessionID}, device ${hostname}).` : "This session is not registered on xats." }
        },
      },
      {
        name: "xats_claim_name",
        description: "Claim a specific xats name for this session.",
        input: input({ name: stringArg("Name to claim") }, ["name"]),
        execute: async (args: any, toolContext: any) => {
          const state = await resolveToolSession(toolContext.sessionID)
          if (!state) return { content: "claim failed: session is not available" }
          const desired = String(args.name).trim()
          if (!desired) return { content: "name required" }
          try {
            const result = await jsonRequest(`${XATS_BASE}/api/register`, post({ name: desired, team, role, agent_type: "custom", agent_type_name: kind, session_key: state.sessionID, name_mode: "exact" }))
            const previous = state.agentID
            state.agentID = result.agent_id
            state.name = result.name || desired
            state.nameMode = "exact"
            writeBinding(namesFile, state.sessionID, state.name)
            state.lastEventId = db?.query("SELECT COALESCE(MAX(event_id),0) m FROM messages WHERE to_agent_id = ?").get(state.agentID)?.m ?? 0
            if (previous && previous !== state.agentID) await jsonRequest(`${XATS_BASE}/api/deregister`, post({ agent_id: previous })).catch(() => {})
            return { content: `Now registered as \"${state.name}\" (team ${team}, role ${role}, agent_id ${state.agentID}).` }
          } catch (error: any) {
            if (error?.status === 409) return { content: `\"${desired}\" is already taken by a live agent on team ${team}. Pick another name.` }
            return { content: `claim failed: ${error?.message ?? error}` }
          }
        },
      },
      {
        name: "xats_discover",
        description: "Discover agents grouped by machine, including remote peers.",
        input: input({ team: stringArg("Team name")}),
        execute: async (args: any) => {
          try {
            const list = (await getAgents(args.team ?? team)).filter((agent) => agent.agent_type_name !== "xats-bridge-inject")
            if (!list.length) return { content: `no agents on team ${args.team ?? team}` }
            const byMachine = new Map<string, XatsAgent[]>()
            for (const agent of list) {
              const machine = agent.device || "unknown"
              byMachine.set(machine, [...(byMachine.get(machine) ?? []), agent])
            }
            return { content: [...byMachine].map(([machine, entries]) => `[${machine}]\n${entries.map((agent) => `  ${agent.name} | ${agent.agent_type_name || agent.agent_type} | ${agent.online ? "online" : "offline"}${agent.role ? ` | ${agent.role}` : ""}${agent.agent_type_name === "xats-bridge-shadow" ? " (remote)" : ""}`).join("\n")}`).join("\n") }
          } catch (error: any) { return { content: `xats discover error: ${error?.message ?? error}` } }
        },
      },
      {
        name: "xats_prune",
        description: "Remove stale bridge shadow and injection agents from the local daemon.",
        input: input({}),
        execute: async ( ) => {
          try {
            const list = await getAgents(team)
            const shadows = list.filter((agent) => ["xats-bridge-shadow", "xats-bridge-inject"].includes(agent.agent_type_name ?? ""))
            for (const agent of shadows) await jsonRequest(`${XATS_BASE}/api/deregister`, post({ agent_id: agent.agent_id })).catch(() => {})
            return { content: shadows.length ? `pruned ${shadows.length} bridge shadow(s)` : "no bridge shadows to prune" }
          } catch (error: any) { return { content: `xats prune error: ${error?.message ?? error}` } }
        },
      },
    ]

    await ctx.tool.transform((editor) => {
      for (const definition of toolDefs) editor.add({ ...definition, options: { codemode: true } })
    })

    return async () => {
      closed = true
      clearInterval(heartbeat)
      clearInterval(receive)
      eventController.abort()
      for (const state of agents.values()) await deregister(state)
      agents.clear()
      try { db?.close() } catch { /* ignore */ }
    }
  },
})

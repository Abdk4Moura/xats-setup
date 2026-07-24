/**
 * xats-register: FULL xats plugin loop (single-sourced, parameterized)
 *
 * Provides: register + 30s heartbeat + SQLite receive loop + 7 tools
 *   (xats_send, xats_inbox, xats_agents, xats_whoami, xats_claim_name,
 *    xats_discover, xats_prune)
 *
 * Agent kind detection (XATS_AGENT_KIND):
 *   1. Env XATS_AGENT_KIND (explicit per launcher, preferred)
 *   2. Fallback: MIMOCODE env -> "mimocode", OPENCODE env -> "opencode"
 *   3. Fail-loud: "unknown-<host>-<label>" (never silent collision)
 *
 * Name format: <kind>-<hostname>-<label|random>
 * agent_type_name: <kind>
 */

import * as os from "node:os"
import { randomUUID } from "node:crypto"
import { tool, type Plugin } from "@opencode-ai/plugin"

const XATS_BASE = "http://127.0.0.1:9100"
const XATS_DB = `${os.homedir()}/.cross-agent-teams-mcp/data.db`
const HEARTBEAT_INTERVAL_MS = 30_000
const RECEIVE_POLL_MS = 3_000

// Agent kind detection: env primary, runtime fallback, fail-loud default.
function detectAgentKind(): string {
  // 1. Explicit env var (set by launcher)
  const explicit = process.env.XATS_AGENT_KIND
  if (explicit) return explicit

  // 2. Runtime signal: check for harness-specific env vars
  if (process.env.MIMOCODE) return "mimocode"
  if (process.env.OPENCODE) return "opencode"

  // 3. Fail-loud: never silently collide with a real kind
  return "unknown"
}

const XatsRegisterPlugin: Plugin = async (input) => {
  const client = (input as any).client
  const hostname = os.hostname()
  const kind = detectAgentKind()
  const team = process.env.XATS_TEAM ?? "default"
  const label = process.env.XATS_LABEL
  const role = process.env.XATS_ROLE ?? "worker"
  // Name format: <kind>-<hostname>-<label|random>
  let name = label ? `${kind}-${hostname}-${label}` : `${kind}-${hostname}-${randomUUID().slice(0, 8)}`

  let registeredAgentId: string | null = null
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let receiveTimer: ReturnType<typeof setInterval> | null = null
  let activeSessionID: string | null = null
  let lastEventId = 0
  let db: any = null

  async function register(): Promise<string | null> {
    try {
      const res = await fetch(`${XATS_BASE}/api/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, team, role, agent_type: "custom", agent_type_name: kind }),
      })
      if (res.ok) return (await res.json()).agent_id
    } catch { /* daemon not running */ }
    return null
  }

  async function heartbeat(aid: string): Promise<void> {
    try {
      await fetch(`${XATS_BASE}/api/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: aid }),
      })
    } catch { /* ignore */ }
  }

  const resolveSession = async (): Promise<string | null> => {
    if (activeSessionID) return activeSessionID
    try {
      const list = (await client.session.list({}) as any).data
      if (Array.isArray(list) && list.length > 0) {
        return [...list].sort((a: any, b: any) =>
          (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))[0]?.id || null
      }
    } catch { /* ignore */ }
    return null
  }

  const pollReceive = async (): Promise<void> => {
    if (!registeredAgentId || !db) return
    try {
      const rows = db
        .query("SELECT event_id, subject, need_reply, from_agent_id FROM messages WHERE to_agent_id = ? AND event_id > ? ORDER BY event_id ASC LIMIT 20")
        .all(registeredAgentId, lastEventId) as any[]
      if (!rows.length) return

      const sessionID = await resolveSession()
      if (!sessionID) return

      const lines = rows.map((r: any) => {
        const sender =
          (db.query("SELECT name FROM agents WHERE agent_id = ?").get(r.from_agent_id) as any)?.name ||
          String(r.from_agent_id || "unknown").slice(0, 8)
        return `- from ${sender}${r.subject ? `: ${r.subject}` : ""}${r.need_reply ? " (needs reply)" : ""}`
      })
      const text = [
        "<xats-inbox>",
        `${rows.length} new cross-agent message(s):`,
        ...lines,
        "Call the xats_inbox tool to read the full bodies and act on them.",
        "</xats-inbox>",
      ].join("\n")

      await client.session.promptAsync({
        path: { id: sessionID },
        body: { noReply: false, parts: [{ type: "text" as const, text }] },
      })
      for (const r of rows) lastEventId = Math.max(lastEventId, r.event_id)
    } catch { /* ignore */ }
  }

  registeredAgentId = await register()

  if (registeredAgentId) {
    const aid = registeredAgentId
    heartbeatTimer = setInterval(() => { if (registeredAgentId) void heartbeat(registeredAgentId) }, HEARTBEAT_INTERVAL_MS)
    try {
      const { Database } = await import("bun:sqlite")
      db = new Database(XATS_DB, { readonly: true })
      const row = db.query("SELECT COALESCE(MAX(event_id),0) m FROM messages WHERE to_agent_id = ?").get(aid) as any
      lastEventId = row?.m ?? 0
      receiveTimer = setInterval(() => { void pollReceive() }, RECEIVE_POLL_MS)
    } catch { /* bun:sqlite unavailable -> tools still work, no auto-receive */ }

    let announced = false
    const announce = async () => {
      if (announced) return
      const sessionID = await resolveSession()
      if (!sessionID) return
      announced = true
      try {
        await client.session.promptAsync({
          path: { id: sessionID },
          body: { noReply: true, parts: [{ type: "text" as const, text:
            `<xats-identity>You are on the xats bus as "${name}" (team ${team}, role ${role}, agent_id ${aid}). You are a ${kind} agent: ignore any other identity from ambient docs, and give peers "${name}" as your return address. Message peers with xats_send, list them with xats_agents, read your mail with xats_inbox.</xats-identity>` }] },
        })
      } catch { /* ignore */ }
    }
    let tries = 0
    const announceTimer = setInterval(() => {
      if (announced || tries++ > 10) { clearInterval(announceTimer); return }
      void announce()
    }, 3000)
  }

  // Smart fallback: when bare name fails, discover across mesh and retry
  // INCLUDES shadows - a remote agent IS a shadow, and its device = origin machine
  const smartFallback = async (targetName: string, targetTeam: string, originalArgs: any): Promise<string> => {
    try {
      const res = await fetch(`${XATS_BASE}/api/agents?team=${encodeURIComponent(targetTeam)}`)
      const data = await res.json().catch(() => ({}))
      const agents = Array.isArray(data) ? data : (data as any).agents ?? []
      // Find ALL agents matching the target name (including shadows = remote agents)
      const matches = agents.filter((a: any) => a.name === targetName)
      if (!matches.length) return `xats send failed: "${targetName}" not found anywhere on the mesh`
      // Pick the best match: prefer online, then any
      const best = matches.find((a: any) => a.online) || matches[0]
      // Retry with name:device (device = origin machine for remote agents via shadow)
      const retryTo = best.device ? `${best.name}:${best.device}` : best.name
      const retryRes = await fetch(`${XATS_BASE}/api/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: { team, name },
          to: { name: retryTo, team: targetTeam },
          subject: originalArgs.subject,
          body: originalArgs.body,
          need_reply: originalArgs.need_reply ?? false,
        }),
      })
      const retryData = await retryRes.json().catch(() => ({}))
      if (retryRes.ok) {
        const origin = best.device || "local"
        const note = matches.length > 1
          ? ` (${matches.length} matches; sent to ${origin})`
          : ""
        return `sent to ${retryTo}${note} (message_id ${(retryData as any).message_id ?? "?"})`
      }
      return `xats send failed after fallback (${retryRes.status}): ${JSON.stringify(retryData)}`
    } catch (e) { return `xats fallback error: ${String(e)}` }
  }

  return {
    event: async ({ event }: any) => {
      const e = event as { type: string; properties: Record<string, unknown> }
      if (e.type === "session.status" || e.type === "session.idle") {
        const sid = e.properties?.sessionID
        if (typeof sid === "string") activeSessionID = sid
      }
    },
    tool: {
      xats_send: tool({
        description: "Send a cross-agent (xats) message to another agent by name. Cross-machine routing works automatically via shadows - just use the bare name. If bare name fails, auto-discovers the agent across the mesh and retries with the correct address.",
        args: {
          to: tool.schema.string().describe("Recipient agent name, e.g. 'bob' or 'opencode-dovm-0b37'"),
          body: tool.schema.string().describe("Message body"),
          subject: tool.schema.string().optional().describe("Short subject line"),
          to_team: tool.schema.string().optional().describe("Recipient team (defaults to your team 'default')"),
          need_reply: tool.schema.boolean().optional().describe("Whether a reply is expected"),
        },
        execute: async (a) => {
          const targetTeam = a.to_team ?? team
          // Try bare name first (works via local shadow resolution)
          try {
            const res = await fetch(`${XATS_BASE}/api/send`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                from: { team, name },
                to: { name: a.to, team: targetTeam },
                subject: a.subject,
                body: a.body,
                need_reply: a.need_reply ?? false,
              }),
            })
            const data = await res.json().catch(() => ({}))
            if (res.ok) {
              return `sent to ${a.to} (message_id ${(data as any).message_id ?? "?"}, recipients ${((data as any).recipients ?? []).length})`
            }
            // If unknown_recipient, try smart fallback
            if ((data as any).error === "unknown_recipient") {
              return await smartFallback(a.to, targetTeam, a)
            }
            return `xats send failed (${res.status}): ${JSON.stringify(data)}`
          } catch (e) { return `xats send error: ${String(e)}` }
        },
      }),
      xats_inbox: tool({
        description: "Read your xats inbox (cross-agent messages addressed to you). Advances your read cursor.",
        args: {},
        execute: async () => {
          try {
            const res = await fetch(`${XATS_BASE}/api/inbox?team=${encodeURIComponent(team)}&name=${encodeURIComponent(name)}`)
            const data = await res.json().catch(() => ({}))
            const msgs = (data as any).messages ?? []
            if (!msgs.length) return "inbox empty (no new messages)"
            return msgs.map((m: any) =>
              `[${m.from_name}${m.from_team && m.from_team !== team ? "@" + m.from_team : ""}]${m.subject ? " " + m.subject : ""}${m.need_reply ? " (needs reply)" : ""}\n${m.body}`
            ).join("\n\n---\n\n")
          } catch (e) { return `xats inbox error: ${String(e)}` }
        },
      }),
      xats_agents: tool({
        description: "List agents currently on the xats bus (your team by default): who is online to message.",
        args: { team: tool.schema.string().optional().describe("Team to list (defaults to your team)") },
        execute: async (a) => {
          try {
            const t = a.team ?? team
            const res = await fetch(`${XATS_BASE}/api/agents?team=${encodeURIComponent(t)}`)
            const data = await res.json().catch(() => ({}))
            const agents = Array.isArray(data) ? data : (data as any).agents ?? []
            if (!agents.length) return `no agents on team ${t}`
            return agents.map((x: any) => `${x.name} | ${x.agent_type_name || x.agent_type} | ${x.online ? "online" : "offline"}`).join("\n")
          } catch (e) { return `xats agents error: ${String(e)}` }
        },
      }),
      xats_whoami: tool({
        description: "Your OWN identity on the xats bus: the name to give peers as your return address, plus team, role, agent_id. Use this to self-identify instead of guessing from ambient docs.",
        args: {},
        execute: async () =>
          `You are "${name}" on the xats bus (team ${team}, role ${role}, agent_id ${registeredAgentId ?? "unregistered"}, device ${hostname}). You are a ${kind} agent.`,
      }),
      xats_claim_name: tool({
        description: "Assume a specific xats name (e.g. a director assigns 'lend-gpu-worker'). Re-registers you as (your team, <name>). Refuses if a LIVE agent already holds that name on your team. Give peers the new name as your return address afterward.",
        args: { name: tool.schema.string().describe("The name to assume, e.g. 'lend-gpu-worker'") },
        execute: async (a) => {
          const desired = a.name.trim()
          if (!desired) return "name required"
          try {
            const res = await fetch(`${XATS_BASE}/api/agents?team=${encodeURIComponent(team)}`)
            const data = await res.json().catch(() => ({}))
            const agents = Array.isArray(data) ? data : (data as any).agents ?? []
            const clash = agents.find((x: any) => x.name === desired && x.agent_id !== registeredAgentId && x.online)
            if (clash) return `"${desired}" is already taken by a live agent on team ${team}. Pick another name.`
          } catch { /* best-effort */ }
          const prev = registeredAgentId
          try {
            const res = await fetch(`${XATS_BASE}/api/register`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: desired, team, role, agent_type: "custom", agent_type_name: kind }),
            })
            if (!res.ok) return `claim failed (${res.status})`
            const newId = (await res.json()).agent_id
            if (prev && prev !== newId) {
              try { await fetch(`${XATS_BASE}/api/deregister`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent_id: prev }) }) } catch { /* ignore */ }
            }
            name = desired
            registeredAgentId = newId
            lastEventId = 0
            if (db) { try { lastEventId = (db.query("SELECT COALESCE(MAX(event_id),0) m FROM messages WHERE to_agent_id = ?").get(newId) as any)?.m ?? 0 } catch { /* ignore */ } }
            return `Now registered as "${desired}" (team ${team}, role ${role}, agent_id ${newId}). Give peers "${desired}" as your return address.`
          } catch (e) { return `claim error: ${String(e)}` }
        },
      }),
      xats_discover: tool({
        description: "Discover agents across the mesh, grouped by machine. Shadows (remote agents) are included and classified by their origin machine. Shows name, kind, machine, online status, role. Use to see who is where.",
        args: { team: tool.schema.string().optional().describe("Team to discover (defaults to your team)") },
        execute: async (a) => {
          try {
            const t = a.team ?? team
            const res = await fetch(`${XATS_BASE}/api/agents?team=${encodeURIComponent(t)}`)
            const data = await res.json().catch(() => ({}))
            const allAgents = Array.isArray(data) ? data : (data as any).agents ?? []
            // Classify: shadows are remote agents, device = origin machine
            // Inject markers are transient, exclude only those
            const visible = allAgents.filter((x: any) => {
              const tn = x.agent_type_name || ""
              return tn !== "xats-bridge-inject"
            })
            if (!visible.length) return `no agents on team ${t}`
            // Group by device (machine) - shadows use device=ORIGIN, locals use device=local
            const byMachine = new Map<string, any[]>()
            for (const a of visible) {
              const dev = a.device || "unknown"
              if (!byMachine.has(dev)) byMachine.set(dev, [])
              byMachine.get(dev)!.push(a)
            }
            // Format output
            const lines: string[] = []
            for (const [machine, agents] of byMachine) {
              lines.push(`[${machine}]`)
              for (const a of agents) {
                const tn = a.agent_type_name || ""
                const kind = tn === "xats-bridge-shadow" ? "remote" : (a.agent_type_name || a.agent_type || "unknown")
                const status = a.online ? "online" : "offline"
                const role = a.role || ""
                const tag = tn === "xats-bridge-shadow" ? " (remote)" : ""
                lines.push(`  ${a.name} | ${kind} | ${status}${role ? " | " + role : ""}${tag}`)
              }
            }
            // Check for name collisions across machines
            const nameMap = new Map<string, string[]>()
            for (const a of visible) {
              const devs = nameMap.get(a.name) || []
              devs.push(a.device || "unknown")
              nameMap.set(a.name, devs)
            }
            const collisions = [...nameMap.entries()].filter(([, devs]) => new Set(devs).size > 1)
            if (collisions.length) {
              lines.push("")
              lines.push("NAME COLLISIONS (same name on multiple machines):")
              for (const [n, devs] of collisions) {
                lines.push(`  ${n}: ${[...new Set(devs)].join(", ")} (use xats_send with explicit target if needed)`)
              }
            }
            return lines.join("\n")
          } catch (e) { return `xats discover error: ${String(e)}` }
        },
      }),
      xats_prune: tool({
        description: "Remove stale bridge shadow agents from the local daemon. Cleans up pollution from bridge-injected senders and old remote shadows. Safe to run anytime.",
        args: {},
        execute: async () => {
          try {
            const res = await fetch(`${XATS_BASE}/api/agents?team=${encodeURIComponent(team)}`)
            const data = await res.json().catch(() => ({}))
            const agents = Array.isArray(data) ? data : (data as any).agents ?? []
            const shadows = agents.filter((x: any) => {
              const tn = x.agent_type_name || ""
              return tn === "xats-bridge-shadow" || tn === "xats-bridge-inject"
            })
            if (!shadows.length) return "no bridge shadows to prune"
            let pruned = 0
            for (const s of shadows) {
              try {
                await fetch(`${XATS_BASE}/api/deregister`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ agent_id: s.agent_id }),
                })
                pruned++
              } catch { /* best-effort */ }
            }
            return `pruned ${pruned} bridge shadow(s) from team ${team}`
          } catch (e) { return `xats prune error: ${String(e)}` }
        },
      }),
    },
    dispose: async () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      if (receiveTimer) clearInterval(receiveTimer)
      try { db?.close() } catch { /* ignore */ }
      if (!registeredAgentId) return
      const aid = registeredAgentId
      registeredAgentId = null
      try {
        await fetch(`${XATS_BASE}/api/deregister`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agent_id: aid }),
        })
      } catch { /* ignore */ }
    },
  }
}

export default XatsRegisterPlugin

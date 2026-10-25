/**
 * xats — OpenCode TUI surfaces.
 *
 * Two additions, both native to the TUI:
 *   - a slot contribution in the prompt footer showing unread mail
 *   - a /xats panel listing the messages
 *
 * This plugin is deliberately independent of the server-side adapter
 * (xats-register.ts): it talks to the daemon over loopback and discovers which
 * agent belongs to the current session through `session_key`. A failure here
 * costs the badge, never message delivery.
 *
 * The inbox is always read with an explicit `since_event_id`, because omitting
 * it makes the daemon advance the caller's processed cursor — that would race
 * with the delivery path and silently swallow mail.
 *
 * State lives in a Solid signal rather than context.storage.memory: in 2.0.27
 * that call returns the value directly instead of the documented
 * `[value, update]` pair, and reading it as a tuple throws inside the render.
 */

import { Plugin } from "@opencode/plugin/tui"
import { Show, createSignal } from "solid-js"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const POLL_MS = 4_000
const DEFAULT_PORT = 9100

type MessageRow = {
  id: string
  from: string
  subject?: string
  body: string
  needReply: boolean
  eventId: number
}

type SessionState = {
  name: string
  unread: number
  needsReply: number
  /** Highest event id counted so far; new ids above this are new mail. */
  cursor: number
  messages: MessageRow[]
}

function debug(line: string): void {
  if (!process.env.XATS_TUI_DEBUG) return
  try {
    fs.appendFileSync("/tmp/xats-tui-debug.log", `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* instrumentation only */
  }
}

function baseUrl(): string {
  if (process.env.XATS_BASE) return process.env.XATS_BASE.replace(/\/+$/, "")
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), ".xats", "port"), "utf8").trim()
    const n = Number.parseInt(raw, 10)
    if (Number.isInteger(n) && n > 0 && n < 65536) return `http://127.0.0.1:${n}`
  } catch {
    /* fall through */
  }
  return `http://127.0.0.1:${DEFAULT_PORT}`
}

async function getJson(url: string): Promise<any> {
  const response = await fetch(url, { signal: AbortSignal.timeout(4_000) })
  if (!response.ok) throw new Error(`${response.status}`)
  return await response.json()
}

function clip(text: string, max: number): string {
  const oneLine = String(text ?? "").replace(/\s+/g, " ").trim()
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1).trimEnd()}…`
}

export default Plugin.define({
  id: "xats.ui",
  async setup(context) {
    const base = baseUrl()
    const [bySession, setBySession] = createSignal<Record<string, SessionState>>({})
    /** sessionID -> xats agent name, resolved once per session. */
    const identity = new Map<string, string>()

    function entryFor(sessionID: string): SessionState | undefined {
      return bySession()[sessionID]
    }

    function patch(sessionID: string, next: SessionState): void {
      setBySession((previous) => ({ ...previous, [sessionID]: next }))
    }

    async function resolveIdentity(sessionID: string, team: string): Promise<string | null> {
      const known = identity.get(sessionID)
      if (known) return known
      try {
        const data = await getJson(`${base}/api/agents?team=${encodeURIComponent(team)}`)
        const agents: any[] = Array.isArray(data) ? data : data.agents ?? []
        const mine = agents.find((agent) => agent && agent.session_key === sessionID)
        if (!mine) {
          debug(`no agent for ${sessionID}`)
          return null
        }
        identity.set(sessionID, mine.name)
        debug(`resolved ${sessionID} -> ${mine.name}`)
        return mine.name
      } catch (error) {
        debug(`resolve failed for ${sessionID}: ${String(error)}`)
        return null
      }
    }

    async function refresh(sessionID: string, team: string): Promise<void> {
      const name = await resolveIdentity(sessionID, team)
      if (!name) return
      try {
        // Explicit since, so the daemon never advances its own cursor for us.
        const data = await getJson(
          `${base}/api/inbox?team=${encodeURIComponent(team)}&name=${encodeURIComponent(name)}&since_event_id=0`,
        )
        const rows: any[] = Array.isArray(data.messages) ? data.messages : []
        const current = entryFor(sessionID)
        const highest = rows.reduce((max, row) => Math.max(max, Number(row.event_id) || 0), 0)
        // First sight of a session starts at the top of the inbox: history is
        // not "unread" just because this badge was installed today.
        const cursor = current?.cursor ?? highest
        const fresh = rows.filter((row) => (Number(row.event_id) || 0) > cursor)
        const messages = rows
          .slice(-40)
          .reverse()
          .map((row) => ({
            id: String(row.id ?? ""),
            from: String(row.from_name ?? "unknown"),
            subject: row.subject ? String(row.subject) : undefined,
            body: String(row.body ?? ""),
            needReply: Boolean(row.need_reply),
            eventId: Number(row.event_id) || 0,
          }))
        const next: SessionState = {
          name,
          cursor: fresh.reduce((max, row) => Math.max(max, Number(row.event_id) || 0), cursor),
          unread: (current?.unread ?? 0) + fresh.length,
          needsReply: (current?.needsReply ?? 0) + fresh.filter((row) => row.need_reply).length,
          messages,
        }
        if (
          current &&
          current.name === next.name &&
          current.cursor === next.cursor &&
          current.unread === next.unread &&
          current.needsReply === next.needsReply &&
          current.messages.length === next.messages.length
        ) {
          return
        }
        debug(`session ${sessionID}: unread=${next.unread} needsReply=${next.needsReply} cursor=${next.cursor}`)
        patch(sessionID, next)
      } catch (error) {
        debug(`inbox failed for ${sessionID}: ${String(error)}`)
      }
    }

    function teamOf(): string {
      return process.env.XATS_TEAM || "default"
    }

    // One timer for the whole app, so a background tab still reports mail.
    const timer = setInterval(() => {
      let sessions: any[] = []
      try {
        sessions = context.data.session.list()
      } catch (error) {
        debug(`session.list failed: ${String(error)}`)
        return
      }
      debug(`tick sessions=${sessions.length}`)
      for (const session of sessions) {
        void refresh(session.id, teamOf())
      }
    }, POLL_MS)

    context.ui.slot({
      append: "prompt.footer.status",
      render: (props?: { sessionID?: string }) => {
        const all = bySession()
        const sessionID = props?.sessionID ?? ""
        // The footer slot may not receive a session id; when it doesn't, report
        // the whole app rather than nothing.
        const entry = sessionID
          ? all[sessionID]
          : Object.values(all).reduce<SessionState | undefined>(
              (worst, item) => (!worst || item.unread > worst.unread ? item : worst),
              undefined,
            )
        debug(`render sessionID=${sessionID || "-"} unread=${entry?.unread ?? "none"}`)
        return (
          <Show when={entry && entry.unread > 0}>
            <text fg={context.theme.text.muted}>
              {`✦ ${entry!.unread}`}
              {entry!.needsReply > 0 ? ` · ${entry!.needsReply} reply` : ""}
            </text>
          </Show>
        )
      },
    })

    context.ui.slot({
      append: "session.panel",
      render: (panel: { name: string; sessionID: string }) => {
        const entry = entryFor(panel.sessionID)
        return (
          <Show when={panel.name === "xats.inbox"}>
            <box flexDirection="column" gap={1}>
              <text fg={context.theme.text.base}>{entry ? `✦ xats · ${entry.name}` : "✦ xats"}</text>
              <Show
                when={entry && entry.messages.length > 0}
                fallback={<text fg={context.theme.text.muted}>No messages.</text>}
              >
                {entry!.messages.map((message) => (
                  <box flexDirection="column">
                    <text fg={context.theme.text.base}>
                      {`${message.from}${message.subject ? `  ${message.subject}` : ""}${message.needReply ? "  ⚠ needs reply" : ""}`}
                    </text>
                    <text fg={context.theme.text.muted}>{clip(message.body, 160)}</text>
                  </box>
                ))}
              </Show>
            </box>
          </Show>
        )
      },
    })

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "xats.inbox",
          title: "Open the xats inbox",
          group: "xats",
          slash: { name: "xats" },
          run: () => {
            const route: any = context.ui.router.current()
            const sessionID = route?.type === "session" ? route.sessionID : undefined
            if (sessionID) {
              const current = entryFor(sessionID)
              if (current && current.unread > 0) patch(sessionID, { ...current, unread: 0, needsReply: 0 })
            }
            context.ui.panel.open("xats.inbox")
          },
        },
      ],
    }))

    return () => clearInterval(timer)
  },
})

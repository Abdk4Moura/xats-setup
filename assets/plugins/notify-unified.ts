/**
 * notify-unified: bg-notify + watch
 *
 * Consolidates session-injection notification plugins into one.
 * xats-register.ts stays separate and untouched.
 *
 * Design rules:
 * - ONE session-resolve + inject helper (injectToSession)
 * - ALL injects wake the agent (noReply:false) -- every notification spurs action
 * - bg_run/bg_check/bg_kill/bg_list tools from bg-notify.ts
 * - watch_start/watch_check/watch_list/watch_stop tools from watch.ts
 *
 * THIS FILE IS A REVIEW PROPOSAL. Do NOT load it in config yet.
 * Cut over only after review + bun build verification.
 */

import * as os from "node:os"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { tool, type Plugin } from "@opencode-ai/plugin"

// ── Constants ───────────────────────────────────────────────────────
const WATCH_MIN_INTERVAL_MS = 2000
const WATCH_DEFAULT_INTERVAL_MS = 30000
const WATCH_DEFAULT_MAX_CHECKS = 720
const WATCH_DEFAULT_PROBE_TIMEOUT_MS = 25000
const WATCH_MAX_EVENTS = 25
const WATCH_SNIPPET_LINES = 6

// ── Types ───────────────────────────────────────────────────────────
interface BgTask {
  id: number
  label: string
  proc: ChildProcess
  logPath: string
  logFile: fs.FileHandle | null
  started: number
  status: "running" | "finished" | "error" | "killed" | "timeout"
  finishedAt: number | null
  timeout: number | null
  exitCode: number | null
}

type WatchStatus = "watching" | "fired" | "stopped" | "error"

interface WatchEvent {
  time: number
  check: number
  code: number | null
  fired: boolean
  reason: string
  snippet: string
}

interface Monitor {
  id: number
  label: string
  command: string
  cwd?: string
  intervalMs: number
  match?: string
  expectExit?: number
  onChange: boolean
  action?: string
  repeat: boolean
  notify: boolean
  maxChecks: number
  timeoutMs: number
  timer: NodeJS.Timeout | null
  busy: boolean
  status: WatchStatus
  checks: number
  lastOutput: string | null
  startedAt: number
  firedAt: number | null
  events: WatchEvent[]
}

// ── Plugin ──────────────────────────────────────────────────────────
const NotifyUnifiedPlugin: Plugin = async (input) => {
  const client = (input as any).client

  // ── Shared state ──────────────────────────────────────────────
  let activeSessionID: string | null = null

  // Bg-notify state
  const bgTasks = new Map<number, BgTask>()
  let bgCounter = 0

  // Watch state
  const monitors = new Map<number, Monitor>()
  let watchCounter = 0

  // ── Shared: session resolve ───────────────────────────────────
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

  // ── Shared: inject to session ─────────────────────────────────
  // ALL injects wake the agent (noReply:false). Every notification
  // spurs the model to act, not just display.
  const injectToSession = async (text: string): Promise<boolean> => {
    const sessionID = await resolveSession()
    if (!sessionID) return false
    try {
      await client.session.promptAsync({
        path: { id: sessionID },
        body: { noReply: false, parts: [{ type: "text" as const, text }] },
      })
      return true
    } catch { return false }
  }

  // ════════════════════════════════════════════════════════════════
  // BG-NOTIFY: task runner + completion notification
  // ════════════════════════════════════════════════════════════════

  const bgNextId = () => ++bgCounter

  const bgNotify = async (task: BgTask): Promise<void> => {
    const elapsed = ((task.finishedAt || Date.now()) - task.started) / 1000
    const success = task.exitCode === 0 && task.status === "finished"
    const taskLabel = task.label.length > 40 ? task.label.slice(0, 37) + "..." : task.label

    let output = ""
    try {
      const content = await fs.readFile(task.logPath, "utf8")
      output = content.trim().split("\n").slice(-5).join("\n")
    } catch { /* ignore */ }

    const title = success
      ? `\u2705 Task ${task.id}: ${taskLabel}`
      : `\u274C Task ${task.id}: ${taskLabel} (${task.status})`
    const message = [
      `Exit ${task.exitCode} \u00B7 ${elapsed.toFixed(1)}s`,
      ...(output ? ["", output] : []),
    ].join("\n")

    await injectToSession(`**${title}**\n${message}`)
  }

  // ════════════════════════════════════════════════════════════════
  // WATCH: periodic probe + fire notification
  // ════════════════════════════════════════════════════════════════

  const watchNextId = () => ++watchCounter

  const watchSnippet = (text: string): string =>
    text.trim().split("\n").slice(-WATCH_SNIPPET_LINES).join("\n").slice(-1500)

  const watchRunProbe = (m: Monitor): Promise<{ code: number | null; output: string }> =>
    new Promise((resolve) => {
      let out = ""
      let done = false
      const proc = spawn("bash", ["-c", m.command], { cwd: m.cwd })
      const cap = (b: Buffer) => { out += b.toString() }
      proc.stdout.on("data", cap)
      proc.stderr.on("data", cap)
      const timer = setTimeout(() => {
        if (done) return
        try { proc.kill("SIGKILL") } catch { /* ignore */ }
        done = true
        resolve({ code: null, output: out + "\n[probe timed out]" })
      }, m.timeoutMs)
      proc.on("exit", (code) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve({ code, output: out })
      })
      proc.on("error", (e) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve({ code: null, output: out + `\n[probe error: ${e.message}]` })
      })
    })

  const watchEvaluate = (m: Monitor, code: number | null, output: string): string[] => {
    const reasons: string[] = []
    if (m.match) {
      let hit = false
      try { hit = new RegExp(m.match).test(output) }
      catch { hit = output.includes(m.match) }
      if (hit) reasons.push(`matched /${m.match}/`)
    }
    if (m.expectExit !== undefined && code === m.expectExit) reasons.push(`exit ${code}`)
    if (m.onChange && m.checks > 1 && m.lastOutput !== null && output !== m.lastOutput)
      reasons.push("output changed")
    return reasons
  }

  const watchStop = (m: Monitor, status: WatchStatus): void => {
    if (m.timer) { clearInterval(m.timer); m.timer = null }
    if (m.status === "watching") m.status = status
  }

  const watchNotifyFire = async (m: Monitor, reasons: string[], output: string): Promise<void> => {
    if (!m.notify) return
    const title = `\uD83D\uDD14 Watch ${m.id} fired: ${m.label}`
    const body = [
      `Triggered after ${m.checks} check(s): ${reasons.join("; ")}`,
      ...(m.repeat ? [] : ["(one-shot \u2014 monitor stopped)"]),
      "",
      watchSnippet(output),
    ].join("\n")
    await injectToSession(`**${title}**\n${body}`)
  }

  const watchTick = async (m: Monitor): Promise<void> => {
    if (m.busy || m.status !== "watching") return
    m.busy = true
    try {
      m.checks++
      const { code, output } = await watchRunProbe(m)
      const reasons = watchEvaluate(m, code, output)
      const fired = reasons.length > 0
      m.events.push({
        time: Date.now(), check: m.checks, code, fired,
        reason: fired ? reasons.join("; ") : "no match",
        snippet: watchSnippet(output),
      })
      if (m.events.length > WATCH_MAX_EVENTS) m.events.shift()
      m.lastOutput = output

      if (fired) {
        m.firedAt = m.firedAt ?? Date.now()
        if (m.action) {
          try { spawn("bash", ["-c", m.action], { cwd: m.cwd, detached: true, stdio: "ignore" }).unref() }
          catch { /* ignore */ }
        }
        void watchNotifyFire(m, reasons, output)
        if (!m.repeat) watchStop(m, "fired")
      }
      if (m.status === "watching" && m.checks >= m.maxChecks) watchStop(m, "stopped")
    } catch { /* keep watching */ }
    finally { m.busy = false }
  }

  const watchDescribe = (m: Monitor): string => {
    const conds: string[] = []
    if (m.match) conds.push(`match /${m.match}/`)
    if (m.expectExit !== undefined) conds.push(`exit==${m.expectExit}`)
    if (m.onChange) conds.push("on change")
    return conds.length ? conds.join(" OR ") : "sample-only (never auto-fires)"
  }

  // ════════════════════════════════════════════════════════════════
  // PLUGIN RETURN: event handler + tools + dispose
  // ════════════════════════════════════════════════════════════════

  return {
    event: async ({ event }: any) => {
      const e = event as { type: string; properties: Record<string, unknown> }
      if (e.type === "session.status" || e.type === "session.idle") {
        const sid = e.properties?.sessionID
        if (typeof sid === "string") activeSessionID = sid
      }
    },

    tool: {
      // ── Bg-notify tools ──────────────────────────────────────
      bg_run: tool({
        description: "Run a shell command in the background. Returns a task ID. Notifies automatically on completion.",
        args: {
          command: tool.schema.string().describe("Shell command to run"),
          cwd: tool.schema.string().optional().describe("Working directory"),
          label: tool.schema.string().optional().describe("Human-readable label"),
          timeout: tool.schema.number().optional().describe("Kill after N seconds"),
        },
        execute: async (args) => {
          const id = bgNextId()
          const taskLabel = args.label || args.command.slice(0, 60)
          const logPath = path.join(os.tmpdir(), `bg-notify-${id}.log`)
          const logFd = await fs.open(logPath, "w")

          const proc = spawn("bash", ["-c", args.command], {
            cwd: args.cwd,
            stdio: ["ignore", logFd.fd, logFd.fd],
            detached: true,
          })
          proc.unref()

          const task: BgTask = {
            id, label: taskLabel, proc, logPath, logFile: logFd,
            started: Date.now(),
            status: "running",
            finishedAt: null,
            timeout: args.timeout || null,
            exitCode: null,
          }
          bgTasks.set(id, task)

          const finish = (status: BgTask["status"], code: number | null) => {
            if (task.status !== "running") return
            task.status = status
            task.exitCode = code
            task.finishedAt = Date.now()
            task.logFile?.close().catch(() => { task.logFile = null })
            void bgNotify(task)
          }

          if (args.timeout) {
            const timer = setTimeout(() => {
              if (task.status === "running") {
                try { process.kill(-proc.pid!, "SIGTERM") } catch { /* ignore */ }
                finish("timeout", null)
              }
            }, args.timeout * 1000)
            proc.on("exit", () => clearTimeout(timer))
          }

          proc.on("exit", (code) => finish(code === 0 ? "finished" : "error", code))
          proc.on("error", () => finish("error", null))

          const timeoutStr = args.timeout ? `Kills after ${args.timeout}s. ` : ""
          return `Task ${id} started: ${taskLabel}\nLog: ${logPath}\n${timeoutStr}You will be notified on completion.`
        },
      }),
      bg_check: tool({
        description: "Check status of a background task.",
        args: { task_id: tool.schema.number().describe("Task ID") },
        execute: async (args) => {
          const task = bgTasks.get(args.task_id)
          if (!task) return `Unknown task ${args.task_id}`
          const elapsed = ((task.finishedAt || Date.now()) - task.started) / 1000
          let output = ""
          try { output = await fs.readFile(task.logPath, "utf8") } catch { /* ignore */ }
          return `Task ${task.id} (${task.label}): ${task.status} [${elapsed.toFixed(1)}s]\n\n${output.slice(-3000)}`
        },
      }),
      bg_kill: tool({
        description: "Kill a running background task.",
        args: { task_id: tool.schema.number().describe("Task ID") },
        execute: async (args) => {
          const task = bgTasks.get(args.task_id)
          if (!task) return `Unknown task ${args.task_id}`
          if (task.status !== "running") return `Task ${args.task_id} already ${task.status}`
          try { process.kill(-task.proc.pid!, "SIGTERM") } catch { /* ignore */ }
          return `Task ${args.task_id} killed`
        },
      }),
      bg_list: tool({
        description: "List all background tasks.",
        args: {},
        execute: async () => {
          if (bgTasks.size === 0) return "No background tasks."
          return [...bgTasks.values()]
            .map(t => `  ${t.id}: ${t.label} [${t.status}]`)
            .join("\n")
        },
      }),

      // ── Watch tools ──────────────────────────────────────────
      watch_start: tool({
        description:
          "Start a monitor: periodically run a probe command and fire when a condition is met " +
          "(regex match, exit code, or output change). On fire it can run an action and notifies the " +
          "session. One-shot by default; set repeat=true for a standing watcher. Returns a monitor ID.",
        args: {
          command: tool.schema.string().describe("Probe shell command, run every interval"),
          interval: tool.schema.number().optional().describe("Seconds between checks (default 30, min 2)"),
          match: tool.schema.string().optional().describe("Regex; fire when probe output matches"),
          expect_exit: tool.schema.number().optional().describe("Fire when probe exit code equals this (e.g. 0)"),
          on_change: tool.schema.boolean().optional().describe("Fire when output changes vs the previous check"),
          action: tool.schema.string().optional().describe("Shell command to run when the monitor fires"),
          repeat: tool.schema.boolean().optional().describe("Keep watching after firing (default false = one-shot)"),
          notify: tool.schema.boolean().optional().describe("Inject a session notification on fire (default true)"),
          max_checks: tool.schema.number().optional().describe("Safety cap on total checks (default 720)"),
          cwd: tool.schema.string().optional().describe("Working directory for the probe/action"),
          label: tool.schema.string().optional().describe("Human-readable label"),
        },
        execute: async (a: any) => {
          const id = watchNextId()
          const m: Monitor = {
            id,
            label: a.label || String(a.command).slice(0, 60),
            command: a.command,
            cwd: a.cwd,
            intervalMs: Math.max(WATCH_MIN_INTERVAL_MS, (a.interval ? a.interval * 1000 : WATCH_DEFAULT_INTERVAL_MS)),
            match: a.match,
            expectExit: a.expect_exit,
            onChange: !!a.on_change,
            action: a.action,
            repeat: !!a.repeat,
            notify: a.notify !== false,
            maxChecks: a.max_checks && a.max_checks > 0 ? a.max_checks : WATCH_DEFAULT_MAX_CHECKS,
            timeoutMs: WATCH_DEFAULT_PROBE_TIMEOUT_MS,
            timer: null,
            busy: false,
            status: "watching",
            checks: 0,
            lastOutput: null,
            startedAt: Date.now(),
            firedAt: null,
            events: [],
          }
          monitors.set(id, m)
          const t = setInterval(() => { void watchTick(m) }, m.intervalMs)
          if (typeof t.unref === "function") t.unref()
          m.timer = t
          setTimeout(() => { void watchTick(m) }, 250)
          const every = Math.round(m.intervalMs / 1000)
          return `Monitor ${id} started: ${m.label}\nFires on: ${watchDescribe(m)}\nEvery ${every}s${m.repeat ? " (repeating)" : " (one-shot)"}. Use watch_check ${id} to inspect.`
        },
      }),
      watch_check: tool({
        description: "Check a monitor's status, recent checks, and whether it fired.",
        args: { monitor_id: tool.schema.number().describe("Monitor ID") },
        execute: async (a: any) => {
          const m = monitors.get(a.monitor_id)
          if (!m) return `Unknown monitor ${a.monitor_id}`
          const age = ((Date.now() - m.startedAt) / 1000).toFixed(0)
          const head = `Monitor ${m.id} (${m.label}): ${m.status} \u2014 ${m.checks} check(s) over ${age}s\n` +
            `Fires on: ${watchDescribe(m)}${m.firedAt ? ` \u2014 FIRED at check where reason recorded` : ""}`
          const recent = m.events.slice(-6).map(e =>
            `  #${e.check} ${e.fired ? "\uD83D\uDD14" : "\u00B7"} exit=${e.code} ${e.reason}` +
            (e.snippet ? `\n     ${e.snippet.replace(/\n/g, "\n     ")}` : "")).join("\n")
          return `${head}\n${recent || "  (no checks yet)"}`
        },
      }),
      watch_list: tool({
        description: "List all monitors and their status.",
        args: {},
        execute: async () => {
          if (monitors.size === 0) return "No monitors."
          return [...monitors.values()].map(m =>
            `  ${m.id}: ${m.label} [${m.status}] \u2014 ${m.checks} checks, fires on ${watchDescribe(m)}`).join("\n")
        },
      }),
      watch_stop: tool({
        description: "Stop a monitor.",
        args: { monitor_id: tool.schema.number().describe("Monitor ID") },
        execute: async (a: any) => {
          const m = monitors.get(a.monitor_id)
          if (!m) return `Unknown monitor ${a.monitor_id}`
          if (m.status !== "watching") return `Monitor ${a.monitor_id} already ${m.status}`
          watchStop(m, "stopped")
          return `Monitor ${a.monitor_id} stopped`
        },
      }),
    },

    // ── Cleanup ─────────────────────────────────────────────────
    dispose: async () => {
      // Bg-notify cleanup
      for (const task of bgTasks.values()) {
        if (task.status === "running") {
          try { task.proc.kill("SIGTERM") } catch { /* ignore */ }
        }
        await task.logFile?.close().catch(() => {})
      }
      bgTasks.clear()
      // Watch cleanup
      for (const m of monitors.values()) if (m.timer) clearInterval(m.timer)
      monitors.clear()
    },
  }
}

export default NotifyUnifiedPlugin

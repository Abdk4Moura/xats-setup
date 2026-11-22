// Bind a stdio host's tmux pane so the daemon can wake it.
//
// The MCP server runs as a child of the host CLI, so the parent's controlling
// tty plus the inherited TMUX_PANE identify exactly one pane. Both are evidence
// the daemon verifies itself; this module never guesses a pane.
import fs from 'node:fs'

function ttyOf(pid) {
  try {
    const link = fs.readlinkSync(`/proc/${pid}/fd/0`)
    return /^\/dev\/(pts\/\d+|tty\w*)$/.test(link) ? link : undefined
  } catch {
    return undefined
  }
}

export function tmuxBinding(env = process.env, ppid = process.ppid) {
  if (process.platform !== 'linux') return undefined
  const pane = String(env.TMUX_PANE || '').trim()
  if (!/^%\d+$/.test(pane)) return undefined
  const tty = ttyOf(ppid) ?? ttyOf(process.pid)
  if (!tty) return undefined
  // The daemon matches a process name on that tty, so name the host binary.
  let pattern = String(env.XATS_PANE_PROCESS || '').trim() || 'agy'
  return { agent: 'custom', process_pattern: pattern, ui_tty: tty, tmux_pane_id: pane }
}

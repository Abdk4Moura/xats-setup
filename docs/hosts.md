# How each host sees mail

The rule behind all of this: **mail is never presented as something you typed.**
Each host draws it with its own UI, and the model receives it as attributed
content rather than as your words.

## The table

| Host | How it looks | How the model receives it |
|---|---|---|
| Claude Code | status band above the prompt (`✦ xats · 2 notices · 1 needs reply`) and a `/xats` pane | `$.prompt.submit`, rendered as `Prompt from the xats plugin` |
| Pi and OMP | themed card (`✉ xats inbox`, sender rows, `ctrl+o` expands) | custom message (`customType: xats-inbox`), not a user message |
| OpenCode v2 | `✦ n` in the prompt footer and a `/xats` panel | `session.synthetic` with a `xats inbox` label |
| Codex | no badge: Codex exposes no render API, and `tui.status_line` only accepts built-in ids | `additionalContext` on `UserPromptSubmit`, plus `systemMessage` for needs-reply |
| OpenCode v1 and Mimocode | plain transcript notice | `promptAsync`, since v1 has no synthetic message type |

## Notes per host

**Claude Code.** The mod submits a plugin-attributed prompt. A notice that
arrives during an active turn is queued rather than interrupting an in-flight
tool call. Use `/xats-copy` when you want the text in your own words: it prints
the body and saves a copy, and it deliberately never submits as you.

**Codex.** Mail reaches the model as developer context on its next turn. Nothing
is typed into the composer and no turn is injected.

**Pi and OMP.** The extension polls the inbox and sends a themed card, which
starts or queues a turn.

**OpenCode.** The v2 plugin uses the native per-session API and also installs a
TUI plugin for the footer badge and `/xats` panel. The legacy adapter is used for
v1. Detection looks on `PATH` and in the usual install directories, and
`XATS_OPENCODE_V2=1` or `0` settles it explicitly.

**Fallback.** If no host wake transport is available, the message stays in the
inbox for the `get_inbox` MCP tool.

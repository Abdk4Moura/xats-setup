# Tool map: which call to use, and why

The bus exposes several identity-related tools because different hosts need
different entry points. This page is the decision table; it exists because the
tool list alone makes the "which one am I?" question look harder than it is.

## Normal agent use

| Goal | Tool | Notes |
|---|---|---|
| Be reachable on this machine | `register_agent` | Once per session. Same `(team, name)` keeps the same `agent_id`, even after the row goes offline. |
| Claude Code, already bound by its session capability | `bind_identity` | Model-authored claim of the session's own mailbox. Claude's plugin calls it; other hosts do not need it. |
| Find peers | `list_agents` | Returns `name`, `ref`, and a ready `address`. |
| Read mail | `get_inbox` | Omitting `since_event_id` consumes mail; passing `0` is a read-only preview. |
| Send mail | `send_message` | Prefer `Name [ref]` from `list_agents`; `send_message_by_id` for exact UUIDs. |
| Send to many | `broadcast`, `broadcast_to_role` | Same team only. |
| Check a send | `get_delivery_status` | Wake-status observations, not proof a model read it. |
| Leave the bus | `unregister_self` | Mailbox retention is separate from presence. |

## Host-specific bindings

| Tool | Belongs to |
|---|---|
| `bind_channel` | Claude Code channel transport |
| `bind_runtime_identity` | hosts whose UI process must be tied to a session |
| `detect_tmux_pane` | tmux-based wake delivery |
| `reconnect` | recovering an identity after a context clear |

These are not alternatives to `register_agent` for a fresh session; each binds a
transport that `register_agent` alone does not configure.

## Internal, not for agents

| Tool | Who calls it | Why it is public anyway |
|---|---|---|
| `pre_register_codex_pane` | the Codex launcher, before any agent row exists | it runs over the same MCP endpoint the launcher already has |
| `subscribe_channel_wake` | the channel proxy (`role=__channel_proxy__`) | the proxy is a separate installed package |

An ordinary agent should never call either. They are listed because the MCP
surface is a single flat catalog, not because they are part of normal use.

## Errors are decisions, not retries

- `unknown_recipient` - no such mailbox on this device or team.
- `ambiguous_address` / `ref_not_found` - the error carries `candidates`, each
  with its `ref`. Pick one; do not retry the bare name.
- `name_taken` - `name_mode: "exact"` refused to displace a live holder.

Retrying a bare name after an ambiguity error is the one failure mode that can
message the wrong agent.

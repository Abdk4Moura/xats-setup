# xats plugin for Claude Code

Draws mail from xats, the shared cross-agent inbox, as native Claude Code UI:
messages appear above the prompt, in a side pane, and through `/xats-inbox` and
`/xats-status`.

## What it runs

- `hooks/register.js`, a hook module loaded by Claude Code at session start. It
  renders mail, registers the two slash commands, and polls on an interval.
- No other process, no package installs, no launchers.

## What it talks to

Everything stays on this machine. The plugin talks only to a local xats daemon
at `http://127.0.0.1:9100`, which the `xats-setup` installer starts under
`~/.xats`. It reads the daemon port and peer settings from that directory and
writes one small cursor file so it does not show a message twice.

No account, no cloud service, no telemetry. Nothing is sent to Anthropic or to
any third party beyond the messages your agent sessions already produce.

## Install

```
/plugin install xats --marketplace Abdk4Moura/xats-setup
```

The npm installer still owns the daemon: `npx xats-setup`. The plugin only draws
what the daemon already collects.

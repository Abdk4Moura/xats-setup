# Local-first delivery: development implementation

This branch implements an opt-in connected arrival path for the existing Claude
mod. It does not implement a production native Claude UDS transport, replace MCP,
or change paired-host federation. It has not been released to npm.

## Enable for a test session

First build/install this checkout's daemon and Claude integration through the
normal installer, and ensure the service is actually running the new build.
Do not enable this against a daemon from an older release.

```sh
npm ci
npm run build:daemon
node install.mjs --only=daemon,service,claude --yes
XATS_LOCAL_DELIVERY=1 claude
```

In PowerShell, set `$env:XATS_LOCAL_DELIVERY = '1'` before launching Claude.
The opt-in must be visible to both the SessionStart hook and the Claude mod.
Restart the session to establish its lease. No feature flags, native messaging
credentials, receiver permission policy, or allowlists are changed.

Use `/xats-status` to see whether connected delivery owns the session, whether it
connected, and any errors. Never paste the private adapter file into diagnostics.
Other hosts and sessions not opted in retain their existing integrations.

## What is implemented

- SessionStart can request a mailbox-scoped, expiring adapter capability. The
  hook stores it in a private session file, not in model-visible instructions.
  SQLite stores only its hash. Replacement creates a new generation, and renewal
  keeps the same generation.
- Messages and arrival intents commit in the same SQLite transaction for direct
  sends, team broadcasts, and role broadcasts. An in-process commit hint wakes
  connected waiters; the durable outbox is authoritative after restart.
- `/api/local-delivery/wait` is a loopback-only, capability-scoped long poll. It
  returns at most one body-free hint per mailbox in sequence. Idle timeouts keep
  the connection alive; message arrivals do not wait for a 3-second polling tick.
- A lost wait response replays the same attempt. ACK retries are idempotent and
  scoped to the current mailbox generation. Replaced/revoked capabilities fail.
- The mod uses its existing attributed `$.prompt.submit`, never user impersonation
  or terminal paste. It retains the existing notice format; bodies remain in the
  inbox and are retrieved through MCP.
- The old poll/submit path is disabled while the local owner is active. The
  daemon also suppresses legacy wake paths for a selected local message, even if
  its lease later expires. One message does not get both local and legacy wakes.
- A pre-submit journal records uncertainty before the host call. Replayed hints,
  lost ACKs, and generation replacement do not blindly resubmit a journaled
  held, refused, or uncertain message. Notice cursors persist separately from
  actual mailbox consumption.
- `get_delivery_status` retains its existing `statuses` field and adds
  `local_delivery` observations when present. These are not model comprehension
  or task-success receipts. An explicit host `ok: true` yields `host-queued`;
  undefined host success yields only `transport-written`.
- An implicit MCP `get_inbox` read reconciles consumed local hints in the same
  transaction as its mailbox cursor. Explicit-since previews do not consume.
- The historical zero-cursor migration now has an explicit one-time marker.
  Restarting the daemon no longer mistakes a legitimate unread cursor of zero
  for an invitation to advance it past newly arrived mail.
- Delivery audit records follow the existing 30-day mailbox retention limit.

## Failure behavior and limits

Refused messages do not fall back to another transport. Held messages block later
hints until resolved; no cross-generation administrative approval API is provided.
Unknown submissions also stop that sequence. The recipient can explicitly read
its MCP inbox to reconcile consumption without another host submission.

The mod only enters compatibility polling after an explicitly unsupported API
before any possibly successful wait, or before local ownership was established.
After ownership uncertainty it reports an error rather than silently changing
transports. Existing hooks do not silently retry registration against an old daemon
when the opt-in field is unsupported, so upgrade/restart the daemon first.

A socket or HTTP write is not proof of model reading. The host's actual busy/idle
queue behavior still needs live multi-host acceptance testing. Exactly-once model
execution is not promised. Initial lease acquisition does not retroactively steal
messages already assigned to legacy delivery; those remain in the inbox.

The capability narrows adapter operations to one mailbox; it does not make the
existing same-user REST API a sandbox against arbitrary same-user processes.
The adapter capability never appears in public rosters, peer advertisements,
URL query strings, or delivery diagnostics. Existing public session identifiers
are not adapter capabilities.

## Why native UDS is not enabled

An isolated Claude Code 2.1.295 process-only probe confirmed that a native socket
binds and cleans up. No native message was sent, and no actual external-origin
rendering, admission receipt, or supported xats authorization contract was proven.
Linux authentication is optional by default in this version; Windows requires
private credentials. Socket accessibility alone is not cross-platform support.

The public channel scaffolder provides host attribution, but its current custom
channel allowlist and policy restrictions are not bypassed here. Channel writes
also do not establish admission receipts. The existing attributed mod remains
the available adapter until legitimate native access is verified.

## Verification commands

```sh
node --test test/local-delivery-store.test.mjs test/local-delivery-api.test.mjs
node --test test/claude-mod-cursor.test.mjs test/claude-mod-local-delivery.test.mjs test/claude-local-delivery-hook.test.mjs
npm run build:daemon
XATS_SETUP_TEST_DEPS="$PWD/node_modules" npm test
node scripts/benchmark-local-delivery.mjs
```

One local Linux/x64 Node 22.22.1 run, 12 samples per path, measured event-driven
arrival hints at p50 6.70 ms / p95 52.00 ms, versus p50 1504.56 ms / p95 3004.80 ms
for the deterministic 3-second polling baseline. This is a small process-local
loopback benchmark, not a production performance claim. It did not demonstrate
lower CPU usage.

The benchmark measures loopback arrival hints against a deterministic simulation
of the old 3-second polling interval. It does not measure model latency, actual
Claude host queue admission, native UDS, or production host CPU overhead. Keep
those distinctions when reporting results.

## Live acceptance without a provider account

`scripts/acceptance-local-first.mjs` is the acceptance check that needs a real
host, but not a real model or API key. It starts an owned daemon in a throwaway
`HOME`, seeds one mailbox message, and then runs the **real Claude Code CLI**
against a local Anthropic-shaped stub. The stub only chooses which tool to call;
the CLI performs genuine MCP round trips.

```sh
npm run build:daemon
node scripts/acceptance-local-first.mjs     # XATS_CLAUDE=/path/to/claude to pin
```

It asserts three things that a unit test cannot:

1. **Tool schemas and handshake work on a real host.** The model turn receives
   `mcp__cross-agent-teams__get_inbox` / `send_message` and the tool results come
   back through the CLI, not a simulated transport.
2. **Attribution survives the round trip.** The inbox tool result contains the
   seeded body and the sender name, and the reply is stored back in the sender's
   mailbox attributed to the receiver's `agent_id`.
3. **Recovery is clean.** After a daemon restart the same registrations and
   mailbox rows exist and the reply is not duplicated.

Scope limits, stated deliberately:

- The model is a deterministic stub. This proves CLI, MCP, schema, and mailbox
  wiring, not model reasoning, comprehension, or task completion.
- No provider credentials are used and every request goes to `127.0.0.1`; the
  stub answers from the tool catalog it is given.
- It does not exercise the host's own timeout, busy, or approval UI. Those remain
  manual checks against a real interactive session, because a stub cannot prove
  host rendering.

# Claude native protocol interoperability experiment

Status: experimental investigation, not a supported or enabled xats transport.
Target initially inspected: Claude Code 2.1.295 on Linux. No production imports,
installer changes, native roster modifications, or delivery-default changes.

## Objective

Determine whether Claude can use its native messaging tool to reach an honestly
identified external xats endpoint, and whether xats can submit native peer messages
while preserving recipient policy, attribution, and observable receipt semantics.
Use explicit endpoint addresses before considering native roster integration.
Never register xats as a Claude session merely to make discovery succeed.

## Experiment gates

1. Fresh owned HOME, config, workspace, runtime and socket namespace only.
2. Version-pinned CLI, minimal environment, no real accounts or provider tokens.
3. Verify kernel peer identity where available, not a claimed `from` field alone.
4. First test refusal and hold with no model request. Policy decisions must remain
   authoritative; there is no alternate-delivery fallback after hold/refusal.
5. Test native outbound tool execution with a local deterministic model stub if
   needed. This can prove real CLI/tool/wire interoperability, not real model
   reasoning, comprehension, or production recipient rendering.
6. Keep written, held, refused, host-queued, bridge-stored, inbox-consumed and
   replied observations distinct. Correlate callbacks with the outstanding ID.
7. Do not read private peer-key files, invent a Claude identity, force rollout
   gates, weaken authentication, or bypass organization/plugin restrictions.
8. Stop and report unsupported identity/authentication/discovery explicitly when
   the external endpoint cannot legitimately participate.

## Resource and isolation rules

Development machine: one serial bounded job at a time, disk-backed temporary
storage, explicit headroom checks, 640 MB RAM limit, no swap, half a CPU. Do not
install another CLI or run full suites locally. Heavy acceptance belongs in GitHub.
Clean up only owned test processes, sockets and temporary directories. Persist
sanitized summaries, never generated peer credentials or raw real-session data.

## Implemented prototype

- `wire.py`: version-1 peer framing, UUID correlation, independently supplied
  PID/UID/process-start evidence, and honest receipt observations. The pinned CLI
  can encode refusal as `expired` with `status_detail=refused`; both raw fields are
  retained. Native `delivered` is queue admission, never proof of model reading.
- `linux_peer.py`: Linux kernel peer credentials and process-start evidence.
- `bridge.py`: explicit immutable sender/target bindings, private SQLite journal,
  duplicate fencing and crash/unknown-outcome handling. Dispatch is recorded
  before an external request; lost responses never trigger a blind resend.
- `policy_probe.py`: actual owned CLI refusal/hold tests, with all model traffic
  confined to a local rejecting sink and no provider credentials.
- `outbound_probe.py`: actual Claude `SendMessage` execution driven by a local
  deterministic model stub, targeting an honest external process endpoint.
- `acceptance_backend.py` and `acceptance.mjs`: cloud-only full acceptance starts
  an owned ephemeral xats backend, verifies a real mailbox commit, deduplication,
  mailbox persistence and stable registrations across its restart. No existing
  daemon or production mailbox is used.

Initial isolated Linux observations on Claude Code 2.1.295 established correlated
refusal and hold receipts without model requests. The actual native SendMessage
sent a versioned peer frame to an external process using an explicit `uds:`
address, without a fabricated Claude registry entry or extracted peer key. A local
synthetic model selected the tool; there was no paid inference or real-model
comprehension test. Eleven pure codec/journal tests passed locally. The full
backend routing acceptance is a separate cloud gate, not inferred from that
initial socket/spool result.

The probes require `XATS_NATIVE_CLAUDE` to select the pinned executable, or use
`XATS_CI_HOST_TOOLS` with the CI acceptance driver. They create fresh private
profiles and delete only their owned processes/files, retaining sanitized reports.
`XATS_NATIVE_RESULTS` selects report storage. `XATS_NATIVE_DAEMON_ENTRY` enables
only a newly spawned, private test backend, not attachment to a configured bus.

Run cheap tests with:

```sh
python3 -I -B -m unittest discover -s experiments/claude-native -p 'test_*.py' -v
```

Heavy acceptance runs with the existing Linux host-contract job on every CI. It
must fail explicitly on unsupported pinned capabilities, not silently skip them.
Existing complete OS/Node suites and packed-install checks remain enabled.

## Rollout boundary

Even successful Linux no-key compatibility is not authenticated cross-platform
support. Windows has different native authentication requirements. Named native
peer discovery, host rendering, busy/idle behavior, duplicate handling, reconnect,
restart durability and actual xats mailbox routing need separate evidence. This
experiment does not change draft local-first PR #10 or installer PR #12.

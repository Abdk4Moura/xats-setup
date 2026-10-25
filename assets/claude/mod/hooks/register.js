/**
 * xats mod for Claude Code.
 *
 * Two jobs, both about fidelity:
 *
 *  1. Draw xats mail where Claude Code draws its own notices — the band above
 *     the prompt and a pane — instead of pushing text through the composer.
 *  2. Deliver mail to Claude as a plugin-attributed prompt, never as the
 *     person's own words. `$.prompt.submit({ text })` renders as
 *     "Prompt from the xats plugin"; `asUser: true` would fake the user and is
 *     deliberately never used here.
 *
 * Identity stays with the SessionStart hook (xats-hook.mjs), which registers
 * the session on the bus. This mod only discovers that registration by
 * session key, heartbeats it, and reads what is waiting.
 *
 * Note: `$.prompt.submit` may not be called from a hook that is holding a turn
 * (a command.run hook deadlocks), so delivery is always scheduled from the
 * poll timer, which is a background job.
 */

// Stamped into /xats-status: if this string is not what you just deployed, the
// host is running an older copy of the mod and nothing else you see matters.
const MOD_BUILD = "2026-10-25-mailbox-cursor-v5";

let lastSessionID = "";
let lastAgentsSeen = "none";

async function sessionIDOf($) {
  if (lastSessionID) return lastSessionID;
  try {
    lastSessionID = String((await $.session.id()) ?? "");
  } catch (error) {
    lastSessionID = `<error: ${error && error.message ? error.message : error}>`;
  }
  return lastSessionID;
}
const DEFAULT_PORT = 9100;
const POLL_MS = 3000;
const HEARTBEAT_MS = 30000;
const SUBMIT_DEBOUNCE_MS = 500;
const DEVICE_READY_ATTEMPTS = 20;

/** Messages found but not yet handed to Claude. */
let pending = [];
/** Newest messages, kept for the /xats pane until the person clears them. */
let recent = [];
let agentId = null;
let agentName = null;
let team = "default";
let lastEventId = 0;
let acceptedEventId = 0;
let cursorLoaded = false;
let cursorPath = "";
let cursorError = "";
let mailboxCursor = null;
let mailboxCursorError = "";
let submitting = false;
let polling = false;
let deliveryScheduled = false;
let nextSubmitAt = 0;
let submitFailures = 0;
let submitAttempts = 0;
let submitOk = 0;
let lastSubmitError = "";
let resolving = 0;
let lastError = "";
let polls = 0;

// Both `$.env.get` and `$.fs.read` are asynchronous in the mods API. Forgetting
// the await is silent and brutal: a Promise stringifies to "[object Promise]",
// which is truthy, so the URL becomes "http://[object Promise]" (or the port
// file is never read) and every request fails at the URL parser.
async function baseUrl($) {
  const explicit = (await $.env.get("XATS_BASE")) || (await $.env.get("XATS_BASE_URL"));
  if (explicit) return String(explicit).replace(/\/+$/, "");
  const port = Number.parseInt(String((await $.env.get("XATS_PORT")) || ""), 10);
  if (Number.isInteger(port) && port > 0 && port < 65536) return `http://127.0.0.1:${port}`;
  const home = (await $.env.get("HOME")) || (await $.env.get("USERPROFILE")) || "";
  if (home) {
    for (const sep of ["/", "\\"]) {
      try {
        const raw = await $.fs.read(`${home}${sep}.xats${sep}port`);
        const n = Number.parseInt(String(raw ?? "").trim(), 10);
        if (Number.isInteger(n) && n > 0 && n < 65536) return `http://127.0.0.1:${n}`;
      } catch {
        /* try the next separator */
      }
    }
  }
  return `http://127.0.0.1:${DEFAULT_PORT}`;
}

// `$.http.fetch` does not resolve to a WHATWG Response. It resolves to
// { status, ok, headers, text } where `text` is already the body string.
// Treating it as a Response yields an empty object and silently zero results.
async function readJson($, url, init) {
  const res = await $.http.fetch(url, init);
  if (!res) return {};
  if (typeof res.text === "string") {
    if (res.ok === false) throw new Error(`http ${res.status} for ${url}`);
    return res.text ? JSON.parse(res.text) : {};
  }
  if (typeof res.json === "function") return await res.json();
  if (typeof res.text === "function") {
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }
  return {};
}

// Peer settings (~/.xats/peer/config.json) are shared by the runtime, the CLI and
// this command, so a change made here is the same change made anywhere.
async function peerConfigPath($) {
  const home = (await $.env.get("HOME")) || (await $.env.get("USERPROFILE")) || "";
  const sep = home.includes("\\") ? "\\" : "/";
  return `${home}${sep}.xats${sep}peer${sep}config.json`;
}

async function readPeerConfig($) {
  const file = await peerConfigPath($);
  try {
    const raw = await $.fs.read(file);
    return { file, config: JSON.parse(String(raw ?? "{}")) };
  } catch {
    return { file, config: { autoApprove: "manual", overlay: "auto" } };
  }
}

async function writePeerConfig($, config) {
  const file = await peerConfigPath($);
  await $.fs.write(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
}

function clip(text, max) {
  const oneLine = String(text ?? "").replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1).trimEnd()}…`;
}

function summaryLine(message) {
  const subject = message.subject ? `: ${message.subject}` : "";
  const eventId = Number(message.event_id);
  const event = Number.isSafeInteger(eventId) && eventId >= 0 ? ` #${eventId}` : "";
  return `-${event} from ${message.from_name || "unknown"}${subject}${message.need_reply ? " (needs reply)" : ""}`;
}

function payloadText(messages) {
  return [
    "<xats-inbox>",
    `${messages.length} cross-agent notice(s):`,
    ...messages.map(summaryLine),
    "",
    "Call mcp__cross-agent-teams__get_inbox to read the full bodies and act on them.",
    "</xats-inbox>",
  ].join("\n");
}

/** Find the agent the SessionStart hook registered for this session. */
async function resolveIdentity($, base) {
  if (agentId) return true;
  const sessionID = await sessionIDOf($);
  if (!sessionID || sessionID.startsWith("<error")) return false;
  const url = `${base}/api/agents?team=${encodeURIComponent(team)}`;
  const data = await readJson($, url);
  const agents = Array.isArray(data) ? data : data.agents ?? [];
  lastAgentsSeen = `${url} -> ${Array.isArray(agents) ? agents.length : "not-array"}: ${agents
    .slice(0, 3)
    .map((a) => `${a && a.name}/${a && a.session_key}`)
    .join(", ")}`;
  const mine = agents.find((a) => a && a.session_key === sessionID);
  if (!mine) return false;
  agentId = mine.agent_id;
  agentName = mine.name;
  resolving = 0;
  return true;
}

async function acceptedCursorPath($) {
  const sessionID = await sessionIDOf($);
  // A session id is a UUID on supported hosts. Never allow a host-supplied
  // path separator (or a long arbitrary string) into the filename.
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionID)) return "";
  const home = (await $.env.get("HOME")) || (await $.env.get("USERPROFILE")) || "";
  if (!home) return "";
  const sep = home.includes("\\") ? "\\" : "/";
  return `${home}${sep}.xats${sep}sessions${sep}${sessionID}.cursor.json`;
}

async function loadAcceptedCursor($) {
  if (cursorLoaded) return;
  cursorLoaded = true;
  cursorPath = await acceptedCursorPath($);
  if (!cursorPath) return;
  try {
    const saved = JSON.parse(String((await $.fs.read(cursorPath)) ?? ""));
    if (saved?.version === 1 && saved.agent_id === agentId &&
        Number.isSafeInteger(saved.event_id) && saved.event_id >= 0) {
      acceptedEventId = saved.event_id;
      lastEventId = Math.max(lastEventId, acceptedEventId);
    } else if (saved?.agent_id && saved.agent_id !== agentId) {
      cursorError = "previous agent id ignored";
    }
  } catch {
    // Missing/torn cursor means replay, never skip. Do not seed from the
    // daemon's current max: mail could have arrived during this reload.
  }
}

async function persistAcceptedCursor($, batch) {
  const eventId = batch.reduce((max, message) => {
    const id = Number(message.event_id);
    return Number.isSafeInteger(id) && id >= 0 ? Math.max(max, id) : max;
  }, acceptedEventId);
  if (eventId <= acceptedEventId) return;
  acceptedEventId = eventId;
  if (!cursorPath) return;
  try {
    await $.fs.write(cursorPath, `${JSON.stringify({ version: 1, agent_id: agentId, event_id: eventId })}\n`);
    cursorError = "";
  } catch (error) {
    // The prompt was accepted; never requeue it just because persistence
    // failed. A later reload may replay it, which is safer than losing it.
    cursorError = String(error && error.message ? error.message : error);
  }
}

async function readMailboxCursor($, base) {
  const url = `${base}/api/cursor?agent_id=${encodeURIComponent(agentId)}`;
  try {
    const data = await readJson($, url);
    const cursor = data.last_processed_event_id;
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("invalid mailbox cursor response");
    mailboxCursor = cursor;
    mailboxCursorError = "";
    return cursor;
  } catch (error) {
    // Cursor lookup is advisory. If it fails, keep the established behavior:
    // still notify rather than silently suppressing mail.
    mailboxCursorError = String(error && error.message ? error.message : error);
    return null;
  }
}

function dropConsumedPending(cursor) {
  const before = pending.length;
  pending = pending.filter((message) => {
    const eventId = Number(message.event_id);
    return !Number.isSafeInteger(eventId) || eventId > cursor;
  });
  return before - pending.length;
}

async function invalidate($) {
  // Claude's mods API may return void, not a Promise. Calling `.catch` on
  // `undefined` aborted the original poll before it scheduled delivery.
  try { await $.ui.invalidate("ui.render"); } catch { /* cosmetic redraw */ }
}

async function deliver($) {
  if (submitting || pending.length === 0) return;
  submitting = true;
  let batch = [];
  try {
    // Check immediately before submission as well as during each poll, because
    // the person may read the MCP inbox while the notice is in its debounce.
    try {
      const base = await baseUrl($);
      const cursor = await readMailboxCursor($, base);
      if (cursor !== null) dropConsumedPending(cursor);
    } catch (error) {
      mailboxCursorError = String(error && error.message ? error.message : error);
    }
    if (pending.length === 0) return;

    batch = pending.splice(0, pending.length);
    submitAttempts += 1;
    // Plain submit: Claude Code attributes this to the plugin. `asUser` is not
    // an option here — peer mail must never look like the person typed it.
    const result = await $.prompt.submit({ text: payloadText(batch) });
    if (result?.ok === false) throw new Error(result.error || "prompt_submit_refused");
    submitOk += 1;
    await persistAcceptedCursor($, batch);
    submitFailures = 0;
    nextSubmitAt = 0;
    lastSubmitError = "";
  } catch (error) {
    lastSubmitError = String(error && error.message ? error.message : error);
    // A busy turn may refuse a prompt. Keep the batch and retry on later polls,
    // even if no new mail arrives. Cap backoff so a long turn cannot strand it.
    if (batch.length > 0) {
      pending = batch.concat(pending);
      submitFailures += 1;
      nextSubmitAt = Date.now() + Math.min(30_000, 3_000 * 2 ** Math.min(submitFailures - 1, 4));
    }
  } finally {
    submitting = false;
    await invalidate($);
  }
}

function scheduleDelivery($) {
  if (pending.length === 0 || submitting || deliveryScheduled) return;
  const delay = Math.max(SUBMIT_DEBOUNCE_MS, nextSubmitAt - Date.now());
  deliveryScheduled = true;
  $.clock.after(delay, () => {
    deliveryScheduled = false;
    void deliver($);
  });
}

async function poll($) {
  if (polling) return;
  polling = true;
  polls += 1;
  try {
    const base = await baseUrl($);
    if (!(await resolveIdentity($, base))) {
      resolving += 1;
      return;
    }
    await loadAcceptedCursor($);
    const data = await readJson(
      $,
      `${base}/api/inbox?team=${encodeURIComponent(team)}&name=${encodeURIComponent(agentName)}&since_event_id=${lastEventId}`,
    );
    const messages = Array.isArray(data.messages) ? data.messages : [];
    const hadPending = pending.length > 0;
    if (messages.length > 0) {
      for (const message of messages) {
        lastEventId = Math.max(lastEventId, Number(message.event_id) || 0);
        pending.push(message);
        recent.push(message);
      }
      // Keep the pane bounded; the inbox tool is the source of truth.
      if (recent.length > 50) recent = recent.slice(-50);
    }
    // The MCP cursor advances only when get_inbox is called without an explicit
    // since_event_id. Suppress those already-read events from plugin notices.
    const cursor = await readMailboxCursor($, base);
    const dropped = cursor === null ? 0 : dropConsumedPending(cursor);
    if (messages.length > 0 || (hadPending && dropped > 0)) await invalidate($);
  } catch (error) {
    lastError = String(error && error.message ? error.message : error);
  } finally {
    polling = false;
    // This is intentionally outside the "new messages" branch. A failed
    // submit must get another chance even when the server returns no new mail.
    if (agentId) scheduleDelivery($);
  }
}

/** Band text: identity while idle, unread counts when there is mail. */
function bandText() {
  if (!agentName) return null;
  const replyNeed = pending.filter((m) => m.need_reply).length;
  if (pending.length === 0) return `✦ xats · ${agentName}`;
  const reply = replyNeed > 0 ? ` · ${replyNeed} need${replyNeed === 1 ? "s" : ""} reply` : "";
  // "Pending" means the plugin has not handed the notice to Claude yet. It
  // does not claim the person has not independently read the MCP inbox.
  return `✦ xats · ${pending.length} notice${pending.length === 1 ? "" : "s"} pending${reply}`;
}

export function register(on, options) {
  if (options && typeof options.team === "string" && options.team) team = options.team;

  on("session.start", async ($, e, next) => {
    // Timers first: a failure to register the commands must not also cost us
    // the inbox poll. Registration is cosmetic; delivery is not.
    $.clock.every(POLL_MS, () => {
      void poll($);
    });
    $.clock.every(HEARTBEAT_MS, () => {
      if (!agentId) return;
      void baseUrl($).then((base) => readJson($, `${base}/api/heartbeat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent_id: agentId }),
      })).catch(() => {});
    });
    // The registration hook runs around the same moment as this one; poll a few
    // times quickly so the first band appears without waiting a full interval.
    for (let i = 1; i <= DEVICE_READY_ATTEMPTS; i += 1) {
      $.clock.after(i * 250, () => {
        void poll($);
      });
    }
    // Register separately and in this order: a rejection of one command (a name
    // that collides, a host that forbids it) must not silently cost us the
    // diagnostic command, which is the only way to see what went wrong.
    // The user's /xats skill owns the short name; only register namespaced
    // commands so a harmless collision never obscures delivery errors.
    for (const [name, description] of [
      ["xats-status", "Show xats bus status for this session"],
      ["xats-inbox", "Open the xats inbox"],
    ]) {
      try {
        await $.command.register({ name, description, immediate: true });
      } catch (error) {
        const detail = error && error.message ? error.message : String(error);
        lastError = lastError ? `${lastError}; ${name}: ${detail}` : `${name}: ${detail}`;
      }
    }
    return next(e);
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const text = bandText();
    if (!text) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    const theirs = await next(e);
    return Box({
      flexDirection: "column",
      children: [Text({ children: [text], dimColor: pending.length === 0 }), theirs],
    });
  });

  // The pane is the "read it properly" surface: one row per message, bodies
  // clipped, and a clear button. Opening it is a person's action, so it may
  // appear at any terminal width.
  on("command.run", { command: "xats-inbox" }, async ($, e) => {
    const args = String(e?.args ?? "").trim().split(/\s+/).filter(Boolean);
    const [verb, value] = args;
    if (verb === "config" || verb === "policy") {
      const { file, config } = await readPeerConfig($);
      if (!verb || !value) {
        if (verb === "config" || verb === "policy" || args.length === 0) {
          return {
            text: [
              `xats peer settings  ${file}`,
              `  autoApprove: ${config.autoApprove ?? "manual"}   (manual | shared | open)`,
              `  overlay:     ${config.overlay ?? "auto"}`,
              `  overlayPeers: ${(config.overlayPeers ?? []).join(",") || "(none)"}`,
              "",
              'Change with: /xats policy shared   or   /xats config overlay tunlion',
            ].join("\n"),
          };
        }
      }
      if (verb === "policy" || verb === "config") {
        if (value === "shared" || value === "open" || value === "manual") {
          const next = { ...config, autoApprove: value };
          await writePeerConfig($, next);
          return { text: `xats autoApprove = ${value}\nApplies to peers discovered on an interface you share; restart the peer runtime to pick it up.` };
        }
        if (verb === "config" && value) {
          const [key, val] = [value, args[2]];
          if (!val) return { text: "usage: /xats config <overlay|overlayPeers|port> <value>" };
          const next = { ...config };
          if (key === "overlay") next.overlay = val;
          else if (key === "overlayPeers") next.overlayPeers = val.split(",").map((x) => x.trim()).filter(Boolean);
          else if (key === "port") next.port = Number.parseInt(val, 10);
          else return { text: `unknown setting: ${key}` };
          await writePeerConfig($, next);
          return { text: `xats ${key} = ${val}` };
        }
      }
    }
    if (args.length === 0) return undefined; // fall through to the pane below
    if (!agentName) {
      return {
        text: `xats: no identity yet (session not registered on the bus).${lastError ? `\nlast error: ${lastError}` : ""}`,
      };
    }
    await $.ui.open({ id: "xats-inbox", title: "xats inbox", closeOnEscape: true });
    return {};
  }).catch(async ($, e, next) => ({
    text: `xats: could not open the inbox (${next.error.kind}).`,
  }));

  on("command.run", { command: "xats-inbox" }, async ($) => {
    if (!agentName) {
      return {
        text: `xats: no identity yet (session not registered on the bus).${lastError ? `\nlast error: ${lastError}` : ""}`,
      };
    }
    await $.ui.open({ id: "xats-inbox", title: "xats inbox", closeOnEscape: true });
    return {};
  }).catch(async ($, e, next) => ({
    text: `xats: could not open the inbox (${next.error.kind}).`,
  }));

  on("ui.render", { component: "Pane" }, async ($, e, next) => {
    if (e.requestId !== "xats-inbox") return next(e);
    const { Box, Text, Button } = $.ui.resolve(e);
    const redraw = () => $.ui.invalidate("ui.render");

    const header = Box({
      flexDirection: "row",
      columnGap: 2,
      children: [
        Text({ children: [`✦ xats · ${agentName}`], bold: true }),
        Text({ children: [`${recent.length} shown · ${pending.length} pending notices`], dimColor: true }),
        Button({
          key: "clear",
          label: "Dismiss",
          plain: true,
          onPress: () => {
            // Explicit human dismissal also clears a notice left pending after
            // the person read its body via MCP. No implicit read cursor is
            // available to the mod without consuming mail on the server.
            recent = [];
            pending = [];
            redraw();
          },
        }),
      ],
    });

    if (recent.length === 0) {
      return Box({
        flexDirection: "column",
        children: [header, Text({ children: ["No messages."], dimColor: true })],
      });
    }

    const rows = recent.slice().reverse().map((message, index) => {
      const badge = message.need_reply ? "  ⚠ needs reply" : "";
      const subject = message.subject ? `  ${message.subject}` : "";
      return Box({
        key: `msg-${message.id ?? index}`,
        flexDirection: "column",
        children: [
          Text({ children: [`${message.from_name || "unknown"}${subject}${badge}`] }),
          Text({ children: [clip(message.body, 160)], dimColor: true }),
        ],
      });
    });

    return Box({ flexDirection: "column", columnGap: 1, children: [header, ...rows] });
  });

  // Diagnostics as a transcript line, so a person can see why nothing draws.
  on("command.run", { command: "xats-status" }, async ($) => ({
    text: [
      `xats status  [${MOD_BUILD}]`,
      `  base:     ${await baseUrl($)}`,
      `  team:     ${team}`,
      `  identity: ${agentName ? `${agentName} (${agentId})` : "unregistered"}`,
      `  session:  ${await sessionIDOf($)}`,
      `  agents:   ${lastAgentsSeen}`,
      `  cursor:   fetched ${lastEventId} · accepted ${acceptedEventId}`,
      `  cursor file: ${cursorPath || "unavailable"}`,
      `  cursor error: ${cursorError || "none"}`,
      `  mailbox:  ${mailboxCursor ?? "unavailable"}${mailboxCursorError ? ` · ${mailboxCursorError}` : ""}`,
      `  pending:  ${pending.length}`,
      `  polls:    ${polls}`,
      `  submit:   ${submitOk}/${submitAttempts} ok, ${submitFailures} consecutive failures`,
      `  retry:    ${nextSubmitAt ? `${Math.max(0, nextSubmitAt - Date.now())}ms` : "none"}`,
      `  submit error: ${lastSubmitError || "none"}`,
      `  other error:  ${lastError || "none"}`,
    ].join("\n"),
  })).catch(async ($, e, next) => ({
    text: `xats status failed (${next.error.kind}): ${lastError || "no detail"}`,
  }));
}

/**
 * Test seam. `claude plugin test` cannot stub the clock, so tests drive `poll`
 * directly with their own `$` instead of waiting on real timers.
 */
export const __internals = {
  poll,
  deliver,
  bandText,
  state: () => ({
    agentId,
    agentName,
    team,
    lastEventId,
    acceptedEventId,
    cursorPath,
    cursorError,
    mailboxCursor,
    mailboxCursorError,
    pending: pending.length,
    recent: recent.length,
    submitAttempts,
    submitOk,
    submitFailures,
    lastSubmitError,
    lastError,
  }),
  setTeam(value) {
    team = value;
  },
  reset() {
    pending = [];
    recent = [];
    agentId = null;
    agentName = null;
    team = "default";
    lastEventId = 0;
    acceptedEventId = 0;
    cursorLoaded = false;
    cursorPath = "";
    cursorError = "";
    mailboxCursor = null;
    mailboxCursorError = "";
    lastSessionID = "";
    submitting = false;
    polling = false;
    deliveryScheduled = false;
    nextSubmitAt = 0;
    submitFailures = 0;
    submitAttempts = 0;
    submitOk = 0;
    lastSubmitError = "";
    resolving = 0;
    lastError = "";
    polls = 0;
  },
};

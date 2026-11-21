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
const MOD_BUILD = "2026-10-25-local-delivery-v6";

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
let localOwned = false;
let localUnsupported = false;
let localLease = null;
let localBusy = false;
let localConnected = false;
let localCanFallback = true;
// Bounded re-arm/retry accounting: after a daemon restart the owner keeps
// trying instead of falling back to polling or waiting for a manual /mcp.
let localReconnects = 0;
let busyRetries = 0;
const MAX_BUSY_RETRIES = 6;
let localError = "";
let localAttempt = null;
// Retain every unresolved host outcome, not just the most recent receipt.
let localOutcomes = {};
let localAck = null;
let localEpoch = 0;

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

// Hand a message to the person in their own words. A mod cannot write into
// the composer, and submitting as the user would fake authorship, so this
// prints the body and drops a copy in a file they can paste from. It never
// sends anything.
async function copyCommand($, e) {
  const args = String(e?.args ?? "").trim().split(/\s+/).filter(Boolean);
  const want = args[0] ?? "";
  const pool = pending.length > 0 ? pending : recent;
  if (pool.length === 0) {
    return { text: "xats copy: nothing to copy. The inbox is empty." };
  }
  let pick;
  if (/^last$/i.test(want)) {
    pick = pool[pool.length - 1];
  } else if (/^\d+$/.test(want)) {
    const index = Math.min(pool.length, Math.max(1, Number(want))) - 1;
    pick = pool[index];
  } else {
    pick = pool[0];
  }

  const body = String(pick.body ?? "");
  const eventId = Number(pick.event_id);
  const header = `from ${pick.from_name || "unknown"}${pick.subject ? ` \u00b7 ${pick.subject}` : ""}${Number.isSafeInteger(eventId) ? ` \u00b7 #${eventId}` : ""}`;

  let saved = "not saved";
  try {
    const home = (await $.env.get("HOME")) || (await $.env.get("USERPROFILE")) || "";
    const dir = `${home}/.xats/clip`;
    const file = `${dir}/xats-${Number.isSafeInteger(eventId) ? eventId : Date.now()}.txt`;
    await $.fs.write(file, body.endsWith("\n") ? body : `${body}\n`);
    saved = file;
  } catch (error) {
    saved = `not saved (${error && error.message ? error.message : error})`;
  }

  return {
    text: [
      `xats copy  ${header}`,
      "",
      body,
      "",
      `saved: ${saved}`,
      "Sending is yours: paste it into the composer if you want it in your own words.",
    ].join("\n"),
  };
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
      if (saved.local_delivery && typeof saved.local_delivery.attempt_id === "string" &&
          ["host-queued", "transport-written", "inbox-consumed", "held", "refused", "failed", "unknown"].includes(saved.local_delivery.stage)) {
        localAttempt = saved.local_delivery;
      }
      for (const attempt of Object.values(saved.local_outcomes ?? {})) {
        if (Number.isSafeInteger(attempt?.event_id) && attempt.event_id > 0 &&
            ["held", "refused", "unknown"].includes(attempt.stage)) {
          localOutcomes[attempt.event_id] = attempt;
        }
      }
      // Migrate the original single-attempt journal without changing version 1.
      if (Number.isSafeInteger(localAttempt?.event_id) && localAttempt.event_id > 0 &&
          localAttempt.retryable !== true &&
          ["held", "refused", "unknown"].includes(localAttempt.stage)) {
        localOutcomes[localAttempt.event_id] = localAttempt;
      }
      if (localAttempt || Object.keys(localOutcomes).length) localCanFallback = false;
    } else if (saved?.agent_id && saved.agent_id !== agentId) {
      cursorError = "previous agent id ignored";
    }
  } catch {
    // Missing/torn cursor means replay, never skip. Do not seed from the
    // daemon's current max: mail could have arrived during this reload.
  }
}

async function writeCursor($) {
  await $.fs.write(cursorPath, `${JSON.stringify({ version: 1, agent_id: agentId,
    event_id: acceptedEventId, ...(localAttempt ? { local_delivery: localAttempt } : {}),
    ...(Object.keys(localOutcomes).length ? { local_outcomes: localOutcomes } : {}) })}\n`);
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
    await writeCursor($);
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
    // Only actual inbox consumption proves these uncertain outcomes safe to
    // forget. A later accepted notice alone does not resolve an older refusal.
    let pruned = false;
    for (const id of Object.keys(localOutcomes)) {
      if (Number(id) <= cursor) { delete localOutcomes[id]; pruned = true; }
    }
    // Only uncertainty may be resolved by a real read. A refusal or an explicit
    // hold is a host decision and must never be rewritten as consumption.
    if (localAttempt && localAttempt.stage === "unknown" && localAttempt.event_id <= cursor) {
      localAttempt = { ...localAttempt, stage: "inbox-consumed" };
      pruned = true;
    }
    if (pruned && cursorPath) await writeCursor($);
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
  if (localOwned || submitting || pending.length === 0) return;
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
  if (localOwned || pending.length === 0 || submitting || deliveryScheduled) return;
  const delay = Math.max(SUBMIT_DEBOUNCE_MS, nextSubmitAt - Date.now());
  deliveryScheduled = true;
  $.clock.after(delay, () => {
    deliveryScheduled = false;
    void deliver($);
  });
}

async function poll($) {
  if (localOwned || polling) return;
  polling = true;
  polls += 1;
  try {
    const base = await baseUrl($);
    if (!(await resolveIdentity($, base))) {
      resolving += 1;
      return;
    }
    await loadAcceptedCursor($);
    if (await connectLocal($)) return;
    const data = await readJson(
      $,
      `${base}/api/inbox?team=${encodeURIComponent(team)}&name=${encodeURIComponent(agentName)}&since_event_id=${lastEventId}`,
    );
    const messages = Array.isArray(data.messages) ? data.messages : [];
    const hadPending = pending.length > 0;
    if (messages.length > 0) {
      for (const message of messages) {
        lastEventId = Math.max(lastEventId, Number(message.event_id) || 0);
        // Even an explicit transport opt-out must not replay a message that a
        // previous local owner held, refused, or may already have submitted.
        if (localOutcomes[Number(message.event_id)]) continue;
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

// Local delivery credentials never appear in URLs or diagnostics. Once a wait
// may have claimed work, failures cannot re-enable the legacy submitter.
async function localRequest($, route, body, lease = localLease) {
  const base = await baseUrl($);
  const res = await $.http.fetch(`${base}/api/local-delivery/${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "X-Xats-Delivery-Token": lease.token,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res || res.ok === false || res.status >= 400) {
    const error = new Error("local delivery request failed");
    error.status = res?.status;
    throw error;
  }
  if (typeof res.text === "string") return JSON.parse(res.text || "{}");
  if (typeof res.json === "function") return await res.json();
  if (typeof res.text === "function") return JSON.parse(await res.text());
  throw new Error("invalid local delivery response");
}

/**
 * Host submit outcomes, classified by evidence rather than convenience.
 *
 * A non-ok result is NOT automatically a refusal: the common cause is a turn
 * already running, which is a hold-and-retry, not a policy decision. Only an
 * explicit refusal signal is terminal.
 */
function classifySubmitResult(result) {
  if (result === undefined) return "transport-written";
  if (result?.ok === true) return "host-queued";
  const stage = String(result?.stage ?? result?.status ?? "").toLowerCase();
  if (stage === "held") return "held";
  if (stage === "refused" || result?.refused === true) return "refused";
  const reason = String(result?.error ?? result?.reason ?? result?.code ?? "");
  // Busy signals are retryable, and distinct from a host-held message: the
  // host is mid-turn, so wait for the boundary instead of settling the attempt.
  if (/busy|in.?progress|mid.?turn|turn|queued|running|not.?idle|interrupt/i.test(reason)) return "busy";
  // Unclassifiable: record uncertainty instead of inventing a refusal.
  return "unknown";
}

function validGeneration(value) {
  return (Number.isSafeInteger(value) && value > 0) ||
    (typeof value === "string" && value.length > 0 && value.length <= 256);
}

function startLocalOwner($) {
  localOwned = true;
  const epoch = localEpoch;
  $.clock.after(0, () => { if (epoch === localEpoch) void localTick($); });
  $.clock.every(HEARTBEAT_MS, () => { if (epoch === localEpoch) void renewLocal($); });
}

async function connectLocal($) {
  if (localUnsupported || submitting || pending.length ||
      String(await $.env.get("XATS_LOCAL_DELIVERY")) !== "1") return false;
  const file = await acceptedCursorPath($);
  if (!file) return false;
  try {
    const lease = JSON.parse(String(await $.fs.read(file.replace(/\.cursor\.json$/, ".delivery.json"))));
    const expiry = typeof lease.expiresAt === "number" ? lease.expiresAt : Date.parse(lease.expiresAt);
    if (!validLocalLease(lease) || !Number.isFinite(expiry)) {
      if (!localCanFallback || Object.keys(localOutcomes).length) {
        startLocalOwner($);
        localError = "lease unavailable after prior local delivery; restart the session hook, no polling fallback";
        return true;
      }
      localError = "invalid or expired lease; polling before connection";
      return false;
    }
    // A persisted expiry is only a snapshot. Another mod instance may have
    // renewed this generation. Never extend it locally without server proof.
    if (expiry <= Date.now()) await validateLocalLease($, lease);
    localLease = lease;
    startLocalOwner($);
    localError = "";
    return true;
  } catch {
    if (!localCanFallback || Object.keys(localOutcomes).length) {
      startLocalOwner($);
      localError = "lease unavailable after prior local delivery; restart the session hook, no polling fallback";
      return true;
    }
    localError = "lease unavailable; polling before connection";
    return false;
  }
}

function validLocalLease(lease) {
  return lease?.version === 1 && lease.agent_id === agentId &&
    typeof lease.token === "string" && /^[A-Za-z0-9_-]{43}$/.test(lease.token) &&
    validGeneration(lease.generation);
}

async function validateLocalLease($, lease) {
  const data = await localRequest($, "renew", {}, lease);
  const expiry = typeof data.expiresAt === "number" ? data.expiresAt : Date.parse(data.expiresAt);
  if (data.generation !== lease.generation || !Number.isFinite(expiry) || expiry <= Date.now()) {
    const error = new Error("stale generation or expiry");
    error.status = 409;
    throw error;
  }
  lease.expiresAt = data.expiresAt;
}

async function refreshLocalLease($) {
  const file = await acceptedCursorPath($);
  const lease = JSON.parse(String(await $.fs.read(file.replace(/\.cursor\.json$/, ".delivery.json"))));
  if (!validLocalLease(lease)) throw new Error("invalid replacement lease");
  await validateLocalLease($, lease);
  if (lease.generation !== localLease?.generation || lease.token !== localLease?.token) {
    // Old attempt IDs belong to the old capability. Reclaim and reconcile
    // from the durable per-event journal instead of reusing a stale ACK.
    localAck = null;
  }
  localLease = lease;
}

function leaseMayHaveChanged(error) {
  return [401, 403, 409, 410].includes(error?.status);
}

/**
 * Ask the daemon to re-attach this identity to the live host session after a
 * restart dropped the in-memory binding. Fail-closed: the daemon refuses unless
 * exactly one session is unbound and this lease owns the identity.
 */
async function rebindLocal($) {
  if (!localLease) return false;
  try {
    await localRequest($, "rebind", {});
    localError = "";
    return true;
  } catch (error) {
    localError = error?.status === 409
      ? "rebind refused; another session may own this identity"
      : "rebind failed; will retry";
    return false;
  }
}

async function renewLocal($) {
  if (!localOwned) return;
  try {
    if (localLease) await validateLocalLease($, localLease);
    else await refreshLocalLease($);
    localError = "";
  } catch (error) {
    if (leaseMayHaveChanged(error) || error?.status === 404) {
      if (await rebindLocal($)) return;
      try { await refreshLocalLease($); localError = ""; return; } catch { /* retain ownership */ }
    }
    localError = "lease renewal failed; no polling fallback";
  }
}

async function saveLocalAttempt($, hint, stage, accepted = false, { blocking = true, retryable = false } = {}) {
  localAttempt = { attempt_id: hint.attempt_id, generation: hint.generation, event_id: hint.event_id, stage,
    ...(retryable ? { retryable: true } : {}) };
  if (blocking && ["held", "refused", "unknown"].includes(stage)) localOutcomes[hint.event_id] = localAttempt;
  else delete localOutcomes[hint.event_id];
  if (accepted) {
    acceptedEventId = Math.max(acceptedEventId, hint.event_id);
    lastEventId = Math.max(lastEventId, acceptedEventId);
  }
  if (!cursorPath) throw new Error("cursor persistence unavailable");
  try {
    await writeCursor($);
    cursorError = "";
  } catch {
    cursorError = "local delivery cursor persistence failed; restart may replay a notice";
    throw new Error("cursor persistence failed");
  }
}

async function processLocalHint($, hint) {
  // A lost ack repeats the same attempt, not the host submission. Persisted
  // unknown is intentional: a crash after a write must not cause blind retry.
  if (localAttempt?.attempt_id === hint.attempt_id && localAttempt.generation === hint.generation &&
      localAttempt.retryable !== true) {
    return localAttempt.stage;
  }
  const base = await baseUrl($);
  const cursor = await readMailboxCursor($, base);
  if (cursor !== null && cursor >= hint.event_id) {
    await saveLocalAttempt($, hint, "inbox-consumed");
    return "inbox-consumed";
  }
  if (localOutcomes[hint.event_id]) {
    // Replacement attempts and generations do not undo prior host outcomes.
    const stage = localOutcomes[hint.event_id].stage;
    await saveLocalAttempt($, hint, stage);
    return stage;
  }
  if (hint.event_id <= acceptedEventId) {
    await saveLocalAttempt($, hint, "transport-written");
    return "transport-written";
  }
  const data = await readJson($,
    `${base}/api/inbox?team=${encodeURIComponent(team)}&name=${encodeURIComponent(agentName)}&since_event_id=${hint.event_id - 1}`);
  // A hint claims exactly one event. Do not submit later mailbox entries out
  // of order while the daemon still owns their delivery attempts.
  const batch = (Array.isArray(data.messages) ? data.messages : [])
    .filter((m) => Number(m.event_id) === hint.event_id && (m.id === hint.message_id || m.message_id === hint.message_id));
  if (!batch.length) throw new Error("hint missing from mailbox");
  recent.push(...batch);
  recent = recent.slice(-50);
  pending = batch;
  await invalidate($);
  // Check again immediately before admission: an actual MCP read alone proves
  // inbox-consumed. Explicit-since mailbox reads above never advance that cursor.
  const latest = await readMailboxCursor($, base);
  if (latest !== null && latest >= hint.event_id) {
    pending = [];
    await saveLocalAttempt($, hint, "inbox-consumed");
    return "inbox-consumed";
  }
  await saveLocalAttempt($, hint, "unknown"); // durable before touching the host
  submitAttempts += 1;
  let stage;
  try {
    stage = classifySubmitResult(await $.prompt.submit({ text: payloadText(batch) }));
  } catch (error) {
    // A thrown submit is uncertainty, never a refusal.
    stage = "unknown";
    lastSubmitError = String(error?.message || error || "prompt submit failed");
  }
  if (stage === "busy") {
    // Busy host: keep the claim, do not acknowledge, and retry at the next turn
    // boundary. Journaled as a held stage for visibility but explicitly
    // non-blocking so the retry is not skipped as an already-settled outcome.
    await saveLocalAttempt($, hint, "held", false, { blocking: false, retryable: true });
    pending = [];
    lastSubmitError = "host busy; retrying at the next turn boundary";
    const busy = new Error("host_busy");
    busy.retryable = true;
    busy.hint = hint;
    throw busy;
  }
  pending = [];
  if (stage === "host-queued" || stage === "transport-written") submitOk += 1;
  lastSubmitError = ["refused", "held", "unknown"].includes(stage) ? `local delivery ${stage}; no automatic resubmit` : "";
  try {
    await saveLocalAttempt($, hint, stage, stage === "host-queued" || stage === "transport-written");
  } catch {
    // Preserve the real observed stage for ack retries in this process. The
    // pre-submit journal remains unknown on disk if this final write failed.
  }
  await invalidate($);
  return stage;
}

async function localTick($) {
  if (!localOwned || localBusy) return;
  localBusy = true;
  const epoch = localEpoch;
  let delay = 250;
  try {
    if (!localLease) await refreshLocalLease($);
    if (!localAck) {
      let data;
      try {
        data = await localRequest($, "wait?timeout_ms=20000");
      } catch (error) {
        // Only explicit unsupported capability BEFORE a successful wait can
        // choose polling. Auth errors and uncertain waits retain ownership.
        if (localCanFallback && (error.status === 404 || error.status === 501)) {
          localUnsupported = true;
          localOwned = false;
          localError = "local delivery unsupported; polling";
          return;
        }
        localCanFallback = false;
        throw error;
      }
      localCanFallback = false;
      localConnected = true;
      if (data.generation !== localLease.generation || !Array.isArray(data.hints) || data.hints.length > 1) {
        const error = new Error("invalid generation or hints");
        error.status = 409;
        throw error;
      }
      const hint = data.hints[0];
      if (!hint) return;
      if (hint.generation !== localLease.generation || typeof hint.attempt_id !== "string" || !hint.attempt_id ||
          typeof hint.message_id !== "string" || !Number.isSafeInteger(hint.event_id) || hint.event_id < 1) {
        const error = new Error("invalid delivery hint");
        error.status = 409;
        throw error;
      }
      const token = localLease.token;
      let stage;
      try { stage = await processLocalHint($, hint); }
      catch (error) {
        // A retryable hold must reach the tick handler so the claim stays open.
        if (error?.retryable) throw error;
        // A transient preview/page miss is not a host denial. Leave the claim
        // unacknowledged so the same hint can be fetched again.
        if (localAttempt?.attempt_id !== hint.attempt_id || localAttempt.generation !== hint.generation) throw error;
        stage = localAttempt.stage;
        localError = "local delivery preparation failed; no polling fallback";
      }
      localAck = { attempt_id: hint.attempt_id, stage, generation: hint.generation, token };
    }
    if (localAck.generation !== localLease.generation || localAck.token !== localLease.token) {
      localAck = null;
      return;
    }
    await localRequest($, "ack", { attempt_id: localAck.attempt_id, stage: localAck.stage });
    localAck = null;
    localError = "";
    delay = 0;
  } catch (error) {
    if (leaseMayHaveChanged(error) || !localLease) {
      // Re-arm: the daemon may have restarted. Re-read the lease file, then
      // keep retrying with backoff instead of surrendering ownership to polling.
      try { await refreshLocalLease($); localReconnects += 1; } catch { /* keep owner */ }
    }
    if (error?.retryable) {
      busyRetries += 1;
      if (busyRetries > MAX_BUSY_RETRIES) {
        // Stop spinning. Record a terminal hold for this exact event so the
        // polling path cannot smuggle it in later, and park the owner briefly.
        try { await saveLocalAttempt($, error.hint, "held", false); } catch { /* keep state */ }
        busyRetries = 0;
        localError = "host stayed busy; delivery held, no polling fallback";
        delay = 30000;
      } else {
        localError = `host busy; retry ${busyRetries}/${MAX_BUSY_RETRIES}`;
        delay = Math.min(8000, 2000 * busyRetries);
      }
    } else {
      localReconnects += 1;
      localError = "local delivery request or generation failed; retrying, no polling fallback";
      delay = Math.min(5000, 500 * Math.max(1, localReconnects));
    }
  } finally {
    localBusy = false;
    if (localOwned && epoch === localEpoch) {
      $.clock.after(delay, () => { if (epoch === localEpoch) void localTick($); });
    }
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
      ["xats-copy", "Copy an xats message so you can send it yourself"],
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

  on("command.run", { command: "xats-copy" }, copyCommand);

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
      `  local delivery: ${localOwned ? (localConnected ? "connected" : "reconnecting") : "polling"}${localError ? ` · ${localError}` : ""}`,
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
  classifySubmitResult,
  localTick,
  renewLocal,
  deliver,
  bandText,
  copyCommand,
  state: () => ({
    localOwned,
    localConnected,
    localError,
    localAttempt,
    localOutcomes,
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
    localEpoch += 1;
    localOwned = false;
    localUnsupported = false;
    localLease = null;
    localBusy = false;
    localConnected = false;
    localCanFallback = true;
    localError = "";
    localAttempt = null;
    localOutcomes = {};
    localAck = null;
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

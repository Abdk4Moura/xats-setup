// Native peer interoperability through the documented mod and socket APIs.
// The original SendMessage implementation still performs the actual native send.
// No Claude session-registry entries are created for non-Claude agents.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAGES = ["transport-written", "host-queued", "inbox-consumed", "held", "refused", "expired", "failed", "unknown"];
let bridge = null;
let error = "";

function cleanLine(value) {
  return String(value ?? "").replace(/[\r\n\x00-\x1f\x7f]/g, " ").slice(0, 180);
}

function peerLabel(peer) {
  return `xats:${cleanLine(peer.name)}${peer.ref ? ` [${cleanLine(peer.ref)}]` : ""}`;
}

function validPeer(peer, state) {
  return peer && UUID.test(peer.agent_id) && typeof peer.name === "string" &&
    typeof peer.address === "string" && peer.address.startsWith(`uds:${state.socketRoot}/`) &&
    peer.address.endsWith(`/${state.pid}.sock`) && !peer.address.includes("..") &&
    !/[\x00-\x1f]/.test(peer.address);
}

function receive(state, value) {
  if (!value || typeof value !== "object") return;
  if (value.kind === "peers") {
    state.rawPeers = Array.isArray(value.peers) ? value.peers.slice(0, 128) : [];
    if (state.pid) state.peers = state.rawPeers.filter(peer => validPeer(peer, state));
  } else if (value.kind === "receipt") {
    const request = state.requests.get(value.attempt_id);
    if (!request || request.generation !== value.generation || request.event_id !== value.event_id ||
        !STAGES.includes(value.stage)) return;
    state.receipts.push(value);
    state.latest.set(value.attempt_id, value);
  } else if (value.kind === "diagnostic") {
    error = cleanLine(value.reason || "native peer diagnostic");
  }
}

async function runBridge($, state, request) {
  let buffered = "";
  try {
    for await (const chunk of $.process.spawn(request)) {
      if (chunk.stream !== "stdout") continue;
      buffered += chunk.text;
      if (buffered.length > 1024 * 1024) throw new Error("native status overflow");
      let end;
      while ((end = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        let value;
        try { value = JSON.parse(line); } catch { continue; }
        if (value.kind === "ready") {
          if (value.state_dir !== state.root || !Number.isSafeInteger(value.pid) || value.pid <= 1) {
            throw new Error("invalid native helper identity");
          }
          const parent = state.ownerSocket.slice(0, state.ownerSocket.lastIndexOf("/"));
          const ownerPid = state.ownerSocket.slice(state.ownerSocket.lastIndexOf("/") + 1, -5);
          const expectedSockets = `${parent}/xats-${ownerPid}-${value.pid}`;
          if (value.socket_root !== expectedSockets) throw new Error("invalid native socket namespace");
          state.pid = value.pid;
          state.socketRoot = expectedSockets;
          if (state.closed) {
            await $.fs.write(`${state.root}/stop-${state.pid}`, "stop\n");
            continue;
          }
          state.ready = true;
          state.everReady = true;
          state.peers = state.rawPeers.filter(peer => validPeer(peer, state));
          state.resolve(true);
          error = "";
        } else if (value.kind === "unavailable") {
          error = `native helper unavailable (${cleanLine(value.reason)})`;
        } else receive(state, value);
      }
    }
  } catch {
    error = "native helper stopped or could not start";
  } finally {
    state.ready = false;
    state.resolve(false);
  }
}

export async function stopNativeBridge($) {
  const state = bridge;
  if (!state) return;
  state.closed = true;
  state.ready = false;
  if (state.pid) {
    try { await $.fs.write(`${state.root}/stop-${state.pid}`, "stop\n"); } catch { /* unload closes its stream too */ }
  }
  bridge = null;
}

export async function connectNativeBridge($, { cursorPath, agentId, base, rearm = false }) {
  const wasSelected = Boolean(bridge?.everReady);
  if (bridge?.agentId === agentId && bridge.cursorPath === cursorPath && (bridge.ready || !rearm)) {
    // Once this adapter admitted native work, a crashed helper is uncertainty,
    // not permission to switch the same request to prompt.submit.
    return bridge.ready || bridge.everReady;
  }
  if (String(await $.env.get("XATS_NATIVE_PEERS")) === "0") return false;
  const socket = String((await $.env.get("CLAUDE_CODE_MESSAGING_SOCKET")) || "");
  if (!/^\/[^\x00\r\n]*\/[1-9][0-9]*\.sock$/.test(socket)) return false;
  const home = (await $.env.get("HOME")) || "";
  const session = cursorPath.match(/\/([A-Za-z0-9_-]{1,128})\.cursor\.json$/)?.[1];
  if (!home.startsWith("/") || !session || !UUID.test(agentId)) return false;
  if (bridge) await stopNativeBridge($);
  const state = { agentId, cursorPath, root: `${home}/.xats/native/${session}`, ownerSocket: socket, socketRoot: "", pid: null,
    ready: false, everReady: wasSelected, closed: false, peers: [], rawPeers: [],
    requests: new Map(), latest: new Map(), receipts: [], resolve: () => {} };
  bridge = state;
  const ready = new Promise(resolve => { state.resolve = resolve; });
  const timer = $.clock.after(4500, () => { if (!state.ready) { state.closed = true; state.resolve(false); } });
  const token = (await $.env.get("CLAUDE_CODE_MESSAGING_TOKEN")) || "";
  const request = {
    argv: ["python3", "-I", "-B", `${$.plugin.root}/native/peer.py`,
      "--state-dir", state.root, "--base", base, "--agent-id", agentId, "--socket", socket],
    env: { CLAUDE_CODE_MESSAGING_TOKEN: String(token), PYTHONDONTWRITEBYTECODE: "1" },
  };
  $.clock.after(0, () => { void runBridge($, state, request); });
  const connected = await ready;
  timer?.cancel?.();
  return connected || wasSelected;
}

export function nativeBridgeState() {
  return { ready: Boolean(bridge?.ready), selected: Boolean(bridge?.everReady),
    peers: bridge?.peers.length || 0, error };
}

export function drainNativeReceipts() {
  if (!bridge) return [];
  return bridge.receipts.splice(0);
}

export async function nativeSubmit($, hint, message, text) {
  const state = bridge;
  if (!state?.everReady) return null;
  if (!state.ready || state.closed) throw new Error("native owner unavailable; no alternate submission");
  if (!UUID.test(hint.attempt_id) || !UUID.test(hint.message_id)) throw new Error("invalid native hint");
  const request = { attempt_id: hint.attempt_id, message_id: hint.message_id,
    generation: hint.generation, event_id: hint.event_id,
    source_agent_id: message.from_agent_id, text };
  state.requests.set(hint.attempt_id, request);
  const response = `${state.root}/responses/${hint.attempt_id}.json`;
  // Clear a prior pre-admission response before retrying the same claim.
  await $.fs.write(response, "");
  await $.fs.write(`${state.root}/requests/${hint.attempt_id}.json`, JSON.stringify(request) + "\n");
  let written = null;
  for (let i = 0; i < 55; i += 1) {
    let value = state.latest.get(hint.attempt_id);
    if (!value) {
      try { value = JSON.parse(String(await $.fs.read(response))); } catch { /* response not ready */ }
    }
    if (value?.attempt_id === hint.attempt_id && value.generation === hint.generation &&
        value.event_id === hint.event_id && (STAGES.includes(value.stage) ||
          (value.kind === "pre-admission" && value.stage === "busy"))) {
      if (value.stage !== "transport-written") return value.stage;
      written = value.stage;
      if (i >= 10) return written;
    }
    if (!state.ready) throw new Error("native helper ended during submission");
    await $.clock.sleep(100);
  }
  // No response is an unknown outcome. The pre-submit journal forbids replay.
  return written || "unknown";
}

function listing(state) {
  if (!state?.ready || !state.peers.length) return "";
  return "xats peers (native IPC, non-Claude):\n" + state.peers.map(peer =>
    `- ${peerLabel(peer)} (${cleanLine(peer.agent_type)})\n  SendMessage to: xats:${peer.agent_id}\n  Native address: ${peer.address}`
  ).join("\n");
}

export async function listNativePeers($, e, next) {
  const original = await next(e);
  if (original?.deny || original?.isError || typeof original?.result?.listing !== "string") return original;
  const text = listing(bridge);
  if (!text) return original;
  return { ...original, result: { ...original.result,
    listing: `${original.result.listing}\n\n${text}`,
    sections: [...(original.result.sections || []), { kind: "xats", total: bridge.peers.length,
      rows: bridge.peers.map(peer => ({ name: peerLabel(peer), id: `xats:${peer.agent_id}`,
        type: cleanLine(peer.agent_type), status: "online" })) }],
  } };
}

export async function listNativePeerCommand($, e, next) {
  const original = await next(e);
  const text = listing(bridge);
  return text && typeof original?.text === "string"
    ? { ...original, text: `${original.text}\n\n${text}` } : original;
}

export async function routeNativeSend($, e, next) {
  if (typeof e.to !== "string" || !e.to.startsWith("xats:")) return next(e);
  const peers = bridge?.ready ? bridge.peers : [];
  const matches = peers.filter(peer => e.to === `xats:${peer.agent_id}` || e.to === peerLabel(peer));
  if (matches.length !== 1) return { isDelivered: false,
    reason: "xats native peer is unavailable or ambiguous; refresh ListAgents and use its exact address" };
  // The documented hook readdresses the original send. Claude applies its
  // normal send checks to the changed destination; we never answer success.
  return next({ ...e, to: matches[0].address });
}

export const __nativeInternals = {
  receive, listing, peerLabel,
  setState(value) { bridge = value; error = ""; },
  reset() { bridge = null; error = ""; },
};

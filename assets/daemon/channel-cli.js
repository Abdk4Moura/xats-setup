#!/usr/bin/env node

// plugins/cross-agent-teams-channel/src/cli.ts
import { randomUUID } from "crypto";
import { realpathSync } from "fs";
import { hostname } from "os";
import { fileURLToPath } from "url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// plugins/cross-agent-teams-channel/src/proxy.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
function createProxyServer() {
  return new McpServer(
    { name: "cross-agent-teams-channel", version: "0.1.0" },
    { capabilities: { experimental: { "claude/channel": {} } } }
  );
}
function relayChannelWake(server, params) {
  try {
    const notif = {
      method: "notifications/claude/channel",
      params
    };
    const p = server.server.notification(notif);
    if (p && typeof p.catch === "function") {
      p.catch(() => {
      });
    }
  } catch {
  }
}

// plugins/cross-agent-teams-channel/src/daemon-client.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// plugins/cross-agent-teams-channel/src/find-claude-pid.ts
import { execFileSync } from "child_process";
var MAX_HOPS = 8;
function readPsRow(pid) {
  try {
    const out = execFileSync("ps", ["-o", "ppid=,args=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 1e3,
      stdio: ["ignore", "pipe", "ignore"]
    });
    const trimmed = out.trim();
    if (!trimmed) return null;
    const m = /^\s*(\d+)\s+(.*)$/.exec(trimmed);
    if (!m) return null;
    return { ppid: parseInt(m[1], 10), cmd: m[2] };
  } catch {
    return null;
  }
}
function isClaudeCmd(cmd) {
  const first = cmd.trim().split(/\s+/)[0];
  if (!first) return false;
  const base = first.replace(/^.*\//, "");
  return base === "claude";
}
function findClaudeUiPid(startPpid = process.ppid, reader = readPsRow) {
  let pid = startPpid;
  for (let i = 0; i < MAX_HOPS; i++) {
    const row = reader(pid);
    if (!row) break;
    if (isClaudeCmd(row.cmd)) return pid;
    if (row.ppid <= 1 || row.ppid === pid) break;
    pid = row.ppid;
  }
  return startPpid;
}

// plugins/cross-agent-teams-channel/src/daemon-client.ts
var DEFAULT_BACKOFF_SCHEDULE_MS = [1e3, 1e4, 6e4, 6e5];
async function parseToolResult(resp) {
  const r = resp;
  const text = r.content?.[0]?.text;
  if (typeof text !== "string") return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
function resolveBackoffSchedule(config) {
  if (config.backoffScheduleMs && config.backoffScheduleMs.length > 0) {
    return config.backoffScheduleMs.map((ms) => Math.max(1, ms));
  }
  if (config.backoffInitialMs !== void 0 || config.backoffMaxMs !== void 0) {
    const initial = config.backoffInitialMs ?? DEFAULT_BACKOFF_SCHEDULE_MS[0];
    const max = config.backoffMaxMs ?? DEFAULT_BACKOFF_SCHEDULE_MS[DEFAULT_BACKOFF_SCHEDULE_MS.length - 1];
    const schedule = [];
    let next = Math.max(1, initial);
    while (schedule.length < DEFAULT_BACKOFF_SCHEDULE_MS.length) {
      schedule.push(Math.min(next, max));
      next *= 2;
    }
    return schedule;
  }
  return DEFAULT_BACKOFF_SCHEDULE_MS;
}
async function runRegistrationSequence(config) {
  const order = [];
  const requestInit = config.token ? { headers: { Authorization: `Bearer ${config.token}` } } : void 0;
  const transport = new StreamableHTTPClientTransport(new URL(config.daemonUrl), {
    requestInit
  });
  const client = new Client({ name: "cross-agent-teams-proxy", version: "0.1.0" });
  if (config.notificationHandler) {
    client.fallbackNotificationHandler = async (n) => {
      if (n.method === "notifications/channel_wake") {
        config.notificationHandler(n.params);
      }
    };
  }
  await client.connect(transport);
  try {
    const registerArgs = {
      agent_type: "custom",
      agent_type_name: "cross-agent-teams-channel",
      model: "proxy",
      role: "__channel_proxy__",
      name: `channel-proxy-${process.pid}`,
      team: "default",
      claude_ui_pid: findClaudeUiPid(),
      delivery: {
        kind: "claude-channel",
        channel_session_id: config.channel_session_id
      }
    };
    if (config.device !== void 0) {
      registerArgs.device = config.device;
    }
    const registerResp = await client.callTool({
      name: "register_agent",
      arguments: registerArgs
    });
    order.push("register_agent");
    const regResult = await parseToolResult(registerResp);
    if (!("agent_id" in regResult)) {
      throw new Error(`register_agent failed: ${JSON.stringify(regResult)}`);
    }
    const subResp = await client.callTool({
      name: "subscribe_channel_wake",
      arguments: { channel_session_id: config.channel_session_id }
    });
    order.push("subscribe_channel_wake");
    const subResult = await parseToolResult(subResp);
    if (!("ok" in subResult) || subResult.ok !== true) {
      throw new Error(`subscribe_channel_wake failed: ${JSON.stringify(subResult)}`);
    }
    return {
      order,
      lastSubscribeResult: subResult,
      client,
      transport,
      close: async () => {
        try {
          await transport.terminateSession();
        } catch {
        }
        try {
          await client.close();
        } catch {
        }
        try {
          await transport.close();
        } catch {
        }
      }
    };
  } catch (err) {
    try {
      await transport.terminateSession();
    } catch {
    }
    try {
      await client.close();
    } catch {
    }
    try {
      await transport.close();
    } catch {
    }
    throw err;
  }
}
async function waitForDisconnect(seq, opts = {}) {
  const interval = opts.healthCheckIntervalMs ?? 3e4;
  const shouldStop = opts.shouldStop ?? (() => false);
  let disconnected = false;
  let wakeup = null;
  const closeHandler = () => {
    disconnected = true;
    wakeup?.();
  };
  const prevOnClose = seq.transport.onclose;
  seq.transport.onclose = () => {
    prevOnClose?.();
    closeHandler();
  };
  while (!disconnected && !shouldStop()) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        wakeup = null;
        resolve();
      }, interval);
      wakeup = () => {
        clearTimeout(timer);
        wakeup = null;
        resolve();
      };
    });
    if (disconnected || shouldStop()) break;
    try {
      await seq.client.callTool({ name: "echo", arguments: { msg: "hb" } });
    } catch {
      disconnected = true;
      break;
    }
  }
}
function runReconnectingProxy(config) {
  let stopped = false;
  let currentSeq = null;
  const backoffScheduleMs = resolveBackoffSchedule(config);
  let backoffIndex = 0;
  async function loop() {
    while (!stopped) {
      let failed = false;
      try {
        const seq = await runRegistrationSequence(config);
        backoffIndex = 0;
        currentSeq = seq;
        if (config.onSequenceComplete) config.onSequenceComplete([...seq.order]);
        await waitForDisconnect(seq, {
          healthCheckIntervalMs: config.healthCheckIntervalMs,
          shouldStop: () => stopped
        });
        if (config.onDisconnect) config.onDisconnect();
        try {
          await seq.close();
        } catch {
        }
        currentSeq = null;
      } catch {
        failed = true;
      }
      if (stopped) break;
      const wait = backoffScheduleMs[Math.min(backoffIndex, backoffScheduleMs.length - 1)];
      if (failed) backoffIndex += 1;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  void loop();
  return {
    stop: async () => {
      stopped = true;
      if (currentSeq) {
        try {
          await currentSeq.close();
        } catch {
        }
      }
    }
  };
}

// plugins/cross-agent-teams-channel/src/cli.ts
var CliArgError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "CliArgError";
  }
};
var LOOPBACK_HOSTS = /* @__PURE__ */ new Set(["localhost", "0.0.0.0", "::", "::1"]);
function isNonLoopbackDaemonUrl(daemonUrl) {
  try {
    const parsed = new URL(daemonUrl);
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "") return false;
    if (LOOPBACK_HOSTS.has(host)) return false;
    if (host.startsWith("127.")) return false;
    return true;
  } catch {
    return true;
  }
}
function deriveHostnameDeviceLabel(hostnameValue) {
  const normalized = hostnameValue.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
  if (normalized.length === 0 || normalized.length > 64) return null;
  return normalized;
}
function buildStartupHint(csid, device) {
  const isCrossHost = device !== void 0;
  const deviceClause = isCrossHost ? `, device: "${device}"` : "";
  const deviceRegisterFragment = isCrossHost ? ` (this proxy is running with --device "${device}", so include device: "${device}" verbatim \u2014 the daemon enforces per-origin device validation, and on a remote daemon omitting it returns device_required_from_remote)` : "";
  const ask = isCrossHost ? `'To join cross-agent-teams (xats) and message other agents, reply with: Register to xats \u2014 name: your-agent-name, team: your-team-name (optional; defaults to the current working directory basename), device: ${device} (cross-host setup \u2014 keep this value verbatim).'` : `'To join cross-agent-teams (xats) and message other agents, reply with: Register to xats \u2014 name: your-agent-name, team: your-team-name (optional; defaults to the current working directory basename).'`;
  const content = [
    `cross-agent-teams-mcp: your channel_session_id is ${csid}.`,
    `Do NOT register automatically. First ask the user (in English) to register this session so it can talk to other agents \u2014 use exactly this wording: ${ask}`,
    `Once the user provides a name (and optionally a team), call register_agent({agent_type: "claude-code", name: "<name from user>", team: "<team from user, omit if not provided>"${deviceClause}, ui_pid: $PPID, project_dir: "<current working directory>"})${deviceRegisterFragment}. Do NOT pass channel_session_id here; the daemon auto-binds via ui_pid.`,
    `If this is a reconnect (context clear, resume, or channel re-attach), route by whether you still remember your own (team, name): if you DO remember it (for example after closing Claude Code and resuming the conversation, where your $PPID has changed but the context survived), call register_agent({agent_type: "claude-code", name: "<your remembered name>", team: "<your remembered team>"${deviceClause}, ui_pid: $PPID, project_dir: "<current working directory>"}) and then state in your reply which identity you re-registered as \u2014 do NOT call reconnect, because it would reverse-look-up the changed $PPID, find no match, and return need_register. If you do NOT remember your (team, name) (for example after a context clear), call reconnect({ui_pid: $PPID}) to recover your prior (team, name) and rebind to this new csid in one step; on a need_register result, ask the user. bind_channel({channel_session_id: "${csid}"}) only rebinds when your CURRENT MCP session is already bound to your agent; on a fresh or resumed MCP session it returns unknown_agent, so use reconnect (or register_agent with your remembered identity) instead. Neither is the primary first-time registration path.`,
    `Do not use curl or another external HTTP client for Claude registration here \u2014 that would create a different MCP session, and follow-up tools in Claude Code could still see unknown_agent.`
  ].join(" ");
  return {
    content,
    meta: { source: "cross_agent_teams_mcp", kind: "startup_bind_hint" }
  };
}
function parseCliArgs(argv, env = process.env, deps = {}) {
  let daemonUrl;
  let token;
  let explicitDevice;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    switch (flag) {
      case "--daemon-url":
        daemonUrl = next;
        i++;
        break;
      case "--token":
        token = next;
        i++;
        break;
      case "--device":
        explicitDevice = next;
        i++;
        break;
      default:
        break;
    }
  }
  if (!daemonUrl || daemonUrl.length === 0) {
    daemonUrl = env.CROSS_AGENT_TEAMS_MCP_DAEMON_URL;
  }
  if (!token || token.length === 0) {
    token = env.CROSS_AGENT_TEAMS_MCP_TOKEN;
  }
  if (!daemonUrl || daemonUrl.length === 0) {
    throw new CliArgError(
      "missing --daemon-url (or CROSS_AGENT_TEAMS_MCP_DAEMON_URL env var)"
    );
  }
  let device;
  let deviceAutoDerivedNotice;
  if (explicitDevice !== void 0) {
    device = resolveDeviceLabel(explicitDevice);
  } else if (isNonLoopbackDaemonUrl(daemonUrl)) {
    const hostnameFn = deps.hostname ?? hostname;
    const derived = deriveHostnameDeviceLabel(hostnameFn());
    if (derived === null) {
      throw new CliArgError(
        `--device is required when --daemon-url is non-loopback (got ${daemonUrl}); os.hostname() did not yield a usable label`
      );
    }
    device = derived;
    deviceAutoDerivedNotice = `--device not supplied; auto-derived "${derived}" from os.hostname() for remote daemon ${daemonUrl}. Pass --device <label> explicitly to silence this notice and pin the device label.`;
  }
  return { daemonUrl, token, device, deviceAutoDerivedNotice };
}
async function main(argv = process.argv.slice(2), env = process.env) {
  let args;
  try {
    args = parseCliArgs(argv, env);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`cross-agent-teams-proxy: ${msg}
`);
    process.exit(2);
  }
  if (args.deviceAutoDerivedNotice !== void 0) {
    process.stderr.write(`cross-agent-teams-proxy: ${args.deviceAutoDerivedNotice}
`);
  }
  const csid = randomUUID();
  const hostServer = createProxyServer();
  const stdioTransport = new StdioServerTransport();
  let registrationEverSucceeded = false;
  const controller = runReconnectingProxy({
    daemonUrl: args.daemonUrl,
    token: args.token,
    device: args.device,
    channel_session_id: csid,
    notificationHandler: (params) => {
      relayChannelWake(hostServer, params);
    },
    onSequenceComplete: () => {
      registrationEverSucceeded = true;
      const hint = buildStartupHint(csid, args.device);
      relayChannelWake(hostServer, hint);
    }
  });
  let stopped = false;
  const shutdown = async () => {
    if (stopped) return;
    stopped = true;
    try {
      await controller.stop();
    } catch {
    }
    try {
      await hostServer.close();
    } catch {
    }
    if (!registrationEverSucceeded) {
      process.stderr.write(`cross-agent-teams-proxy: daemon unreachable at ${args.daemonUrl}
`);
      process.exit(1);
    }
    process.exit(0);
  };
  stdioTransport.onclose = () => {
    void shutdown();
  };
  await hostServer.connect(stdioTransport);
  process.on("SIGTERM", () => {
    void shutdown();
  });
  process.on("SIGINT", () => {
    void shutdown();
  });
}
function isEntry() {
  try {
    const metaPath = fileURLToPath(import.meta.url);
    const argvPath = realpathSync(process.argv[1]);
    return metaPath === argvPath;
  } catch {
    return false;
  }
}
if (isEntry()) {
  void main();
}
function resolveDeviceLabel(explicit) {
  const raw = explicit ?? hostname();
  if (raw.includes(":")) {
    throw new CliArgError("invalid_device_label");
  }
  const normalized = raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  const label = normalized.length > 0 ? normalized : "local";
  if (label.length > 64) {
    throw new CliArgError("invalid_device_label");
  }
  return label;
}
export {
  CliArgError,
  buildStartupHint,
  deriveHostnameDeviceLabel,
  isNonLoopbackDaemonUrl,
  main,
  parseCliArgs
};
//# sourceMappingURL=channel-cli.js.map
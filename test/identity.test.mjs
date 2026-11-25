// identity.test.mjs — the daemon's per-session identity rules.
//
// These run the real daemon (daemon/dist/cli.js) against a throwaway DB and
// exercise /api/register. The overlay bundle needs the base package's
// node_modules (fastify, the MCP SDK), which only exist after xats-setup has
// installed the daemon on this machine. When those are absent the suite skips
// rather than failing a clean checkout — set XATS_SETUP_TEST_DEPS to point at a
// node_modules directory to force it.

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "daemon", "dist", "cli.js");
const TEAM = "default";
const ROLE = "worker";

function findDeps() {
  const candidates = [
    process.env.XATS_SETUP_TEST_DEPS,
    path.join(os.homedir(), ".xats", "daemon", "node_modules"),
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      if (fs.statSync(path.join(dir, "fastify")).isDirectory()) return dir;
    } catch {
      /* not here */
    }
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(base, proc, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null)
      throw new Error(`daemon exited early (code ${proc.exitCode})${daemonStderr ? `\n--- daemon stderr ---\n${daemonStderr.slice(-2000)}` : " (no stderr captured)"}`);
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

let env = null;
// Child stderr, so a failed start reports why instead of just an exit code.
let daemonStderr = "";

before(async () => {
  const deps = findDeps();
  if (!deps) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xats-ident-"));
  // The overlay resolves fastify/MCP from a sibling node_modules.
  fs.symlinkSync(deps, path.join(root, "node_modules"), "dir");
  const cli = path.join(root, "cli.js");
  fs.copyFileSync(CLI, cli);
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  const port = await freePort();
  const proc = spawn(
    process.execPath,
    // Pass an explicit device label: this test is about session identity, not
    // about hostname normalisation. A runner hostname that normalises to empty
    // (or exceeds 64 chars) makes the daemon exit with invalid_device_label,
    // which is a different concern and is covered separately.
    [cli, "daemon", "--device", "ident-test", "--port", String(port), "--db", path.join(root, "data.db")],
    {
      env: { ...process.env, CROSS_AGENT_TEAMS_MCP_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const base = `http://127.0.0.1:${port}`;
  // Keep the child's stderr: "exited early (code 1)" is unactionable on its own,
  // and this is the only place that sees it.
  daemonStderr = "";
  proc.stderr?.on("data", (chunk) => { daemonStderr += String(chunk); });
  const up = await waitForHealth(base, proc);
  if (!up) {
    proc.kill("SIGKILL");
    throw new Error(`daemon never became healthy on ${base}${daemonStderr ? `\n--- daemon stderr ---\n${daemonStderr.slice(-2000)}` : ""}`);
  }
  env = { base, proc, root, db: path.join(root, "data.db"), deps };
});

after(async () => {
  if (!env) return;
  env.proc.kill("SIGKILL");
  // Windows cannot unlink a file SQLite still holds, and the kill is asynchronous,
  // so the DB can still be open here. Wait for exit, then retry the removal
  // instead of failing a green suite on cleanup.
  await new Promise((resolve) => {
    if (env.proc.exitCode !== null || env.proc.signalCode !== null) return resolve();
    env.proc.once("exit", resolve);
    setTimeout(resolve, 3000);
  });
  try {
    fs.rmSync(env.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // A leftover temp directory is not a test failure.
  }
});

function register(body) {
  return fetch(`${env.base}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      team: TEAM,
      role: ROLE,
      agent_type: "custom",
      agent_type_name: "pi",
      ...body,
    }),
  }).then(async (res) => ({
    status: res.status,
    body: await res.json().catch(() => ({})),
  }));
}

function withDb(fn) {
  const require = createRequire(path.join(env.deps, "noop.js"));
  const Database = require("better-sqlite3");
  const db = new Database(env.db);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const skip = (t) => {
  if (!env) {
    t.skip("daemon dependencies not installed (set XATS_SETUP_TEST_DEPS)");
    return true;
  }
  return false;
};

test("same preferred name from two sessions stays two distinct identities", async (t) => {
  if (skip(t)) return;
  const a = await register({
    name: "dup-name",
    session_key: "sess-A",
    name_mode: "prefer",
  });
  const b = await register({
    name: "dup-name",
    session_key: "sess-B",
    name_mode: "prefer",
  });

  assert.equal(a.status, 200);
  assert.equal(a.body.name, "dup-name", "first session keeps the clean name");
  assert.equal(b.status, 200);
  assert.equal(b.body.name, "dup-name-2", "second session is disambiguated");
  assert.notEqual(
    a.body.agent_id,
    b.body.agent_id,
    "the two sessions must not share an agent_id",
  );
});

test("re-registering the same session reconnects to the same agent_id", async (t) => {
  if (skip(t)) return;
  const first = await register({
    name: "reconnect",
    session_key: "sess-R",
    name_mode: "prefer",
  });
  const again = await register({
    name: "reconnect",
    session_key: "sess-R",
    name_mode: "prefer",
  });

  assert.equal(again.body.agent_id, first.body.agent_id);
  assert.equal(again.body.name, first.body.name);
});

test("a Claude MCP reconnect reuses its named identity instead of minting -2", async (t) => {
  if (skip(t)) return;
  // Shape of the 2026-11-25 incident: the SessionStart hook registered a
  // retained Claude row, the MCP server reconnected, and the model called
  // register_agent with the same name but no session key.
  const first = await register({
    name: "claude-mcp-reconnect",
    agent_type: "claude-code",
    session_key: "sess-CMR",
    name_mode: "prefer",
  });
  assert.equal(first.status, 200);

  const recovery = await register({
    name: "claude-mcp-reconnect",
    agent_type: "claude-code",
  });

  assert.equal(recovery.status, 200);
  assert.equal(
    recovery.body.name,
    "claude-mcp-reconnect",
    "the recovery keeps the exact name; a -2 mailbox splits replies",
  );
  assert.equal(
    recovery.body.agent_id,
    first.body.agent_id,
    "the recovery reuses the retained row, not a duplicate identity",
  );
});

test("a Claude reconnect records the runtime ui_pid for later proofs", async (t) => {
  if (skip(t)) return;
  const first = await register({
    name: "claude-pid-proof",
    agent_type: "claude-code",
    session_key: "sess-CPP",
    name_mode: "prefer",
    ui_pid: 424242,
  });
  assert.equal(first.status, 200);

  const row = withDb((db) =>
    db.prepare("SELECT runtime_ui_pid FROM agents WHERE name=?").get("claude-pid-proof"),
  );
  assert.equal(row.runtime_ui_pid, 424242);

  // The same process, now without a session key, is recognized by its pid.
  const again = await register({
    name: "claude-pid-proof",
    agent_type: "claude-code",
    ui_pid: 424242,
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.agent_id, first.body.agent_id);
});

test("a different live Claude process cannot take a retained name", async (t) => {
  if (skip(t)) return;
  const first = await register({
    name: "claude-held-name",
    agent_type: "claude-code",
    session_key: "sess-CHN1",
    name_mode: "prefer",
    ui_pid: 111111,
  });
  assert.equal(first.status, 200);

  const clash = await register({
    name: "claude-held-name",
    agent_type: "claude-code",
    ui_pid: 222222,
  });

  assert.equal(clash.status, 409);
  assert.equal(clash.body.error, "identity_in_use");
});

test("activity clears offline_since instead of reporting a replying agent offline", async (t) => {
  if (skip(t)) return;
  const reg = await register({ name: "presence", session_key: "sess-P" });
  withDb((db) =>
    db.prepare("UPDATE agents SET offline_since=? WHERE name=?").run(
      new Date().toISOString(),
      "presence",
    ),
  );

  const heartbeat = await fetch(`${env.base}/api/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent_id: reg.body.agent_id }),
  });
  assert.equal(heartbeat.status, 200);

  const row = withDb((db) =>
    db.prepare("SELECT offline_since FROM agents WHERE name=?").get("presence"),
  );
  assert.equal(row.offline_since, null);
});

test("exact mode refuses a name a live agent already holds", async (t) => {
  if (skip(t)) return;
  await register({
    name: "held-name",
    session_key: "sess-H1",
    name_mode: "prefer",
  });
  const clash = await register({
    name: "held-name",
    session_key: "sess-H2",
    name_mode: "exact",
  });

  assert.equal(clash.status, 409);
  assert.equal(clash.body.error, "name_taken");
});

test("exact mode guards the name even without a session_key", async (t) => {
  if (skip(t)) return;
  await register({
    name: "held-no-session",
    session_key: "sess-N1",
    name_mode: "prefer",
  });
  const clash = await register({ name: "held-no-session", name_mode: "exact" });

  assert.equal(
    clash.status,
    409,
    "an explicit exact request must not silently take over",
  );
});

test("legacy register (no session_key, no mode) keeps takeover semantics", async (t) => {
  if (skip(t)) return;
  const owner = await register({
    name: "legacy-name",
    session_key: "sess-L1",
    name_mode: "prefer",
  });
  const takeover = await register({ name: "legacy-name" });

  assert.equal(takeover.status, 200);
  assert.equal(takeover.body.name, "legacy-name");
  assert.equal(
    takeover.body.agent_id,
    owner.body.agent_id,
    "legacy callers still take over the row",
  );
});

test("a session keeps a claimed name when it resumes under a different default", async (t) => {
  if (skip(t)) return;
  const claim = await register({
    name: "claimed-role",
    session_key: "sess-C1",
    name_mode: "exact",
  });
  assert.equal(claim.body.name, "claimed-role");

  // On resume the harness computes a fresh default name but offers it as
  // "prefer"; the daemon must hand back the name this session already owns.
  const resume = await register({
    name: "pi-host-cccc1111",
    session_key: "sess-C1",
    name_mode: "prefer",
  });

  assert.equal(resume.body.name, "claimed-role");
  assert.equal(resume.body.agent_id, claim.body.agent_id);
});

test("a stale holder is taken over rather than suffixed", async (t) => {
  if (skip(t)) return;
  const original = await register({
    name: "stale-name",
    session_key: "sess-S1",
    name_mode: "prefer",
  });

  // Age the row past the agent TTL so it is no longer live.
  withDb((db) => {
    db.prepare("UPDATE agents SET last_seen_at=? WHERE name=?").run(
      new Date(Date.now() - 3_600_000).toISOString(),
      "stale-name",
    );
  });

  const reclaim = await register({
    name: "stale-name",
    session_key: "sess-S2",
    name_mode: "exact",
  });

  assert.equal(reclaim.status, 200, "a dead holder must not block a reclaim");
  assert.equal(
    reclaim.body.name,
    "stale-name",
    "the reclaimer gets the exact name, not -2",
  );
  assert.equal(
    reclaim.body.agent_id,
    original.body.agent_id,
    "the row is reused, not duplicated",
  );
});

test("two same-type sessions keep separate inboxes", async (t) => {
  if (skip(t)) return;
  const a = await register({
    name: "inbox-a",
    session_key: "sess-IA",
    name_mode: "prefer",
  });
  const b = await register({
    name: "inbox-b",
    session_key: "sess-IB",
    name_mode: "prefer",
  });
  assert.notEqual(a.body.name, b.body.name);

  const send = (to) =>
    fetch(`${env.base}/api/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: { team: TEAM, name: "inbox-a" },
        to: { name: to, team: TEAM },
        subject: `ping ${to}`,
        body: `body for ${to}`,
        need_reply: false,
      }),
    }).then((res) => res.json());

  await send("inbox-a");
  await send("inbox-b");

  const inboxOf = (name) =>
    fetch(
      `${env.base}/api/inbox?team=${encodeURIComponent(TEAM)}&name=${encodeURIComponent(name)}`,
    ).then((res) => res.json());
  const subjectsOf = async (name) =>
    ((await inboxOf(name)).messages ?? []).map((m) => m.subject);

  const subjectsA = await subjectsOf("inbox-a");
  const subjectsB = await subjectsOf("inbox-b");

  assert.ok(subjectsA.includes("ping inbox-a"), "A receives its own mail");
  assert.ok(!subjectsA.includes("ping inbox-b"), "A must not receive B mail");
  assert.ok(subjectsB.includes("ping inbox-b"), "B receives its own mail");
  assert.ok(!subjectsB.includes("ping inbox-a"), "B must not receive A mail");
});

test("the unique identity index still holds", async (t) => {
  if (skip(t)) return;
  const dupes = withDb((db) =>
    db
      .prepare(
        "SELECT device, team, name, COUNT(*) c FROM agents GROUP BY device, team, name HAVING c > 1",
      )
      .all(),
  );
  assert.deepEqual(dupes, [], "no two rows may share (device, team, name)");
});

test("roster addresses carry a stable ref and ambiguity is refused, not guessed", async (t) => {
  if (skip(t)) return;
  const sender = await register({ name: "addr-sender", session_key: "sess-ADDR-S" });
  const first = await register({ name: "addr-dup", session_key: "sess-ADDR-A" });
  const second = await register({ name: "addr-dup", session_key: "sess-ADDR-B" });

  // A second identical name is suffixed by the daemon, so cross-device style
  // ambiguity is simulated by the duplicate-looking pair below.
  assert.equal(first.body.name, "addr-dup");
  assert.equal(second.body.name, "addr-dup-2");

  const roster = await fetch(`${env.base}/api/agents?team=${TEAM}`).then((res) => res.json());
  const rows = roster.agents.filter((row) => row.name.startsWith("addr-dup"));
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.match(row.ref, /^[0-9a-f]{8}$/, "roster must advertise a stable ref");
    assert.equal(row.address, `${row.name} [${row.ref}]`);
  }
  assert.notEqual(rows[0].ref, rows[1].ref, "refs must distinguish the two identities");

  const target = rows.find((row) => row.agent_id === second.body.agent_id);
  const sent = await fetch(`${env.base}/api/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      from: { team: TEAM, name: sender.body.name },
      to: { name: target.address },
      body: "addressed by ref",
      auto_poke: false,
    }),
  });
  assert.equal(sent.status, 200);
  const receipt = await sent.json();
  assert.deepEqual(receipt.recipients, [second.body.agent_id], "the ref selects exactly one identity");

  const wrong = await fetch(`${env.base}/api/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      from: { team: TEAM, name: sender.body.name },
      to: { name: "addr-dup [00000000]" },
      body: "unresolvable",
      auto_poke: false,
    }),
  });
  assert.equal(wrong.status, 400);
  const failure = await wrong.json();
  assert.equal(failure.error, "ref_not_found");
  assert.ok(Array.isArray(failure.candidates), "failure must name the candidates instead of guessing");
  assert.equal(failure.candidates[0].name, "addr-dup");
});

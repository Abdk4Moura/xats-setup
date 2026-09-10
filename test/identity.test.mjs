// identity.test.mjs — the daemon's per-session identity rules.
//
// These run the real daemon (assets/daemon/cli.js) against a throwaway DB and
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
const CLI = path.join(HERE, "..", "assets", "daemon", "cli.js");
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
      throw new Error(`daemon exited early (code ${proc.exitCode})`);
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
    [cli, "daemon", "--port", String(port), "--db", path.join(root, "data.db")],
    {
      env: { ...process.env, CROSS_AGENT_TEAMS_MCP_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const base = `http://127.0.0.1:${port}`;
  const up = await waitForHealth(base, proc);
  if (!up) {
    proc.kill("SIGKILL");
    throw new Error(`daemon never became healthy on ${base}`);
  }
  env = { base, proc, root, db: path.join(root, "data.db"), deps };
});

after(() => {
  if (!env) return;
  env.proc.kill("SIGKILL");
  fs.rmSync(env.root, { recursive: true, force: true });
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

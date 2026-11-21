// Durable-identity semantics: a stable ref per mailbox, ambiguity refusal, and
// presence expiry that never silently destroys identity.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(path.join(repo, 'package.json'));
let Database;
try { Database = require('better-sqlite3'); } catch { /* CI requires native deps */ }

async function load(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xats-identity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const file = path.join(dir, 'mods.mjs');
  buildSync({ stdin: { contents: `
    export { applySchema } from './daemon/src/storage/schema.ts';
    export { AgentsRepo } from './daemon/src/storage/agents-repo.ts';
    export { EventsOutbox } from './daemon/src/storage/events-outbox.ts';
    export { SendMessageService } from './daemon/src/mcp/send-message.ts';
    export { listAgentsForTeam } from './daemon/src/mcp/list-agents.ts';
    export { runCleanup } from './daemon/src/daemon/cleanup.ts';
    export { agentRefPrefix, assignAgentRefs, parseAgentAddress, resolveAgentAddress, formatAgentAddress } from './daemon/src/storage/agent-ref.ts';
    export { safeRosterAgent } from './lib/peer-federation.mjs';
  `, resolveDir: repo, loader: 'ts' }, outfile: file, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' });
  return import(pathToFileURL(file).href);
}

test('refs are deterministic, uniformly sized and stable across restarts', { skip: !Database }, async t => {
  const { assignAgentRefs, parseAgentAddress, formatAgentAddress } = await load(t);
  const ids = ['9f1c0a54-1111-4a2b-8c3d-000000000001', '9f1c0a54-2222-4a2b-8c3d-000000000002'];
  const first = assignAgentRefs(ids);
  assert.deepEqual([...first.keys()].sort(), [...ids].sort());
  assert.equal(new Set(first.values()).size, 2, 'distinct identities get distinct refs');
  for (const ref of first.values()) assert.match(ref, /^[0-9a-f]{8}$/);
  assert.deepEqual(assignAgentRefs(ids), first, 'rebuilding a roster must not renumber identities');
  assert.deepEqual(parseAgentAddress(' build bot [ab12cd34] '), { name: 'build bot', ref: 'ab12cd34' });
  assert.deepEqual(parseAgentAddress('[ab12cd34]'), { name: '', ref: 'ab12cd34' });
  assert.deepEqual(parseAgentAddress('name:otherdevice'), { name: 'name:otherdevice' });
  assert.equal(formatAgentAddress('bot', 'ab12cd34'), 'bot [ab12cd34]');
  assert.throws(() => parseAgentAddress('   '), /empty_address/);
});

test('colliding prefixes are lengthened instead of aliasing two identities', { skip: !Database }, async t => {
  const { assignAgentRefs } = await load(t);
  const refs = assignAgentRefs(Array.from({ length: 400 }, (_, i) => `id-${i}`));
  assert.equal(new Set(refs.values()).size, 400);
  assert.ok([...refs.values()].every(ref => ref.length >= 8));
});

test('ambiguous names are refused with candidates; refs resolve across devices', { skip: !Database }, async t => {
  const { resolveAgentAddress, assignAgentRefs } = await load(t);
  const roster = [
    { agent_id: 'a1', name: 'worker', device: 'laptop' },
    { agent_id: 'a2', name: 'worker', device: 'desktop' },
    { agent_id: 'a3', name: 'solo', device: 'laptop' },
  ];
  const ambiguous = resolveAgentAddress('worker', roster);
  assert.equal(ambiguous.error, 'ambiguous_address');
  assert.equal(ambiguous.candidates.length, 2);
  assert.ok(ambiguous.candidates.every(c => /^[0-9a-f]{8}$/.test(c.ref)), 'candidates carry actionable refs');

  const local = resolveAgentAddress('worker', roster, { localDevice: 'laptop' });
  assert.equal(local.ok, true, 'a local device is a deterministic tie-break');
  assert.equal(local.agent_id, 'a1');

  const refs = assignAgentRefs(roster.map(r => r.agent_id));
  const byRef = resolveAgentAddress(`worker [${refs.get('a2')}]`, roster, { localDevice: 'laptop' });
  assert.equal(byRef.ok, true);
  assert.equal(byRef.agent_id, 'a2', 'the ref overrides the local-device preference');
  assert.equal(byRef.via, 'ref');
  assert.equal(resolveAgentAddress('renamed [abcd]', roster).error, 'ref_not_found');
  assert.equal(resolveAgentAddress('[abcd]', roster).error, 'ref_not_found');
  assert.equal(resolveAgentAddress('nobody', roster).error, 'unknown_recipient');
});

test('presence expiry marks every agent offline without destroying identity', { skip: !Database }, async t => {
  const { applySchema, AgentsRepo, listAgentsForTeam, runCleanup } = await load(t);
  const db = new Database(':memory:');
  t.after(() => db.close());
  applySchema(db);
  const repo = new AgentsRepo(db);
  const registered = repo.register({ name: 'opencode-worker', team: 'default', device: 'local', agent_type: 'opencode' });
  const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  db.prepare('UPDATE agents SET last_seen_at=? WHERE agent_id=?').run(old, registered.agent_id);

  assert.equal(repo.markStaleOffline(new Date(Date.now() - 180_000).toISOString()), 1);
  const roster = listAgentsForTeam(db, 'default');
  const row = roster.agents.find(agent => agent.agent_id === registered.agent_id);
  assert.ok(row, 'an offline identity stays in the roster');
  assert.equal(row.online, false);
  assert.match(row.address, new RegExp(`^opencode-worker \\[${row.ref}\\]$`));

  // Reconnecting/reactivating restores presence for the SAME identity.
  const again = repo.register({ name: 'opencode-worker', team: 'default', device: 'local', agent_type: 'opencode' });
  assert.equal(again.agent_id, registered.agent_id, 'identity is not reissued after presence expiry');
  assert.equal(listAgentsForTeam(db, 'default').agents.find(a => a.agent_id === again.agent_id).online, true);

  // Hard removal is a separate, much longer retention decision.
  const offlineLongAgo = new Date(Date.now() - 31 * 86400_000).toISOString();
  db.prepare('UPDATE agents SET last_seen_at=?, offline_since=? WHERE agent_id=?').run(offlineLongAgo, offlineLongAgo, registered.agent_id);
  db.prepare(`INSERT INTO agents(agent_id,device,team,role,name,registered_at,last_seen_at,offline_since)
              VALUES ('recent','local','default','default','recent',?,?,?)`).run(offlineLongAgo, offlineLongAgo, new Date(Date.now() - 86400_000).toISOString());
  runCleanup(db);
  const remaining = listAgentsForTeam(db, 'default').agents.map(agent => agent.agent_id);
  assert.ok(!remaining.includes(registered.agent_id), 'only the retention horizon purges identity');
  assert.ok(remaining.includes('recent'), 'a recently offline identity is retained');
});

test('send_message addresses by name [ref] and never guesses on ambiguity', { skip: !Database }, async t => {
  const { applySchema, AgentsRepo, EventsOutbox, SendMessageService, listAgentsForTeam } = await load(t);
  const db = new Database(':memory:');
  t.after(() => db.close());
  applySchema(db);
  const repo = new AgentsRepo(db);
  const sender = repo.register({ name: 'sender', team: 'default', device: 'local', agent_type: 'custom' });
  const a = repo.register({ name: 'dup', team: 'default', device: 'local', agent_type: 'custom' });
  const b = repo.register({ name: 'dup-2', team: 'default', device: 'local', agent_type: 'custom' });
  const service = new SendMessageService(db, repo, new EventsOutbox(db));
  const roster = listAgentsForTeam(db, 'default').agents;
  const refA = roster.find(row => row.agent_id === a.agent_id).ref;
  const refB = roster.find(row => row.agent_id === b.agent_id).ref;

  const byRef = await service.send({ from: sender.agent_id, to_agent_name: `dup [${refB}]`, body: 'to b', auto_poke: false });
  assert.equal(byRef.recipients?.[0], b.agent_id, 'ref selects the exact identity');
  const byName = await service.send({ from: sender.agent_id, to_agent_name: 'dup', body: 'to a', auto_poke: false });
  assert.equal(byName.recipients?.[0], a.agent_id, 'an unambiguous name still works');
  const mismatch = await service.send({ from: sender.agent_id, to_agent_name: `dup [${'0'.repeat(8)}]`, body: 'x', auto_poke: false });
  assert.equal(mismatch.error, 'ref_not_found');
  assert.ok(refA !== refB);
});

test('refs stay prefix-stable across roster sizes, so remote refs still resolve', { skip: !Database }, async t => {
  const { assignAgentRefs, resolveAgentAddress, agentRefPrefix } = await load(t);
  // `id-10014` and `id-22672` share the 8-char prefix c9184ee7, so a roster
  // containing both must widen. Hardcoded so the case is deterministic.
  assert.equal(agentRefPrefix('id-10014', 8), agentRefPrefix('id-22672', 8));
  const small = ['zeta', 'alpha'];
  const big = [...small, 'id-10014', 'id-22672'];
  const smallRefs = assignAgentRefs(small);
  const bigRefs = assignAgentRefs(big);
  const width = [...bigRefs.values()][0].length;
  assert.ok(width > 8, 'a colliding roster must lengthen its refs');
  for (const id of small) {
    assert.ok(bigRefs.get(id).startsWith(smallRefs.get(id)), 'a longer ref must extend the shorter one');
  }
  const roster = big.map(id => ({ agent_id: id, name: id, device: 'remote' }));
  const remoteSaidShort = smallRefs.get('alpha');
  const resolved = resolveAgentAddress(`alpha [${remoteSaidShort}]`, roster);
  assert.equal(resolved.ok, true, 'a shorter ref quoted by a peer must still resolve');
  assert.equal(resolved.agent_id, 'alpha');
});

test('federation forwards a well-formed peer ref and drops a malformed one', async t => {
  const { safeRosterAgent } = await load(t);
  const base = { agent_id: 'a', name: 'peer', team: 'default', device: 'box' };
  assert.equal(safeRosterAgent({ ...base, ref: 'ABCD1234' }).ref, 'abcd1234');
  assert.equal(safeRosterAgent({ ...base, ref: 'not-a-ref' }).ref, undefined);
  assert.equal(safeRosterAgent({ ...base, ref: '../../etc' }).ref, undefined);
  assert.equal(safeRosterAgent(base).ref, undefined);
});

test('an identity whose binding died with the daemon is reclaimed, not suffixed', { skip: !Database }, async t => {
  const mods = await load(t);
  const db = new Database(':memory:');
  t.after(() => db.close());
  mods.applySchema(db);
  const repo = new mods.AgentsRepo(db);

  const first = repo.register({ name: 'reclaim', team: 'default', agent_type: 'claude-code', session_key: 'sess-1', name_mode: 'exact' });
  // The daemon restarted, so its in-memory MCP binding is gone but the row is
  // still within the presence TTL.
  db.prepare('UPDATE agents SET binding_lost = 1 WHERE agent_id = ?').run(first.agent_id);

  const reclaimed = repo.register({ name: 'reclaim', team: 'default', agent_type: 'claude-code', session_key: 'sess-2', name_mode: 'prefer' });
  assert.equal(reclaimed.agent_id, first.agent_id, 'the reconnecting session keeps its mailbox');
  assert.equal(reclaimed.name, 'reclaim', 'no -2 identity is invented');
  assert.equal(db.prepare('SELECT binding_lost FROM agents WHERE agent_id = ?').get(first.agent_id).binding_lost, 0);

  // A live holder that still has its binding is not stolen.
  const held = repo.register({ name: 'held', team: 'default', agent_type: 'claude-code', session_key: 'sess-3', name_mode: 'exact' });
  const other = repo.register({ name: 'held', team: 'default', agent_type: 'claude-code', session_key: 'sess-4', name_mode: 'prefer' });
  assert.notEqual(other.agent_id, held.agent_id);
  assert.equal(other.name, 'held-2');
});

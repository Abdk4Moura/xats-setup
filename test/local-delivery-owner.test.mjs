// Single delivery owner: a live local lease decides which component delivers.
// The auto_poke flag controls the tmux wake only, never ownership.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xats-owner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const file = path.join(dir, 'mods.mjs');
  buildSync({ stdin: { contents: `
    export { applySchema } from './daemon/src/storage/schema.ts';
    export { AgentsRepo } from './daemon/src/storage/agents-repo.ts';
    export { EventsOutbox } from './daemon/src/storage/events-outbox.ts';
    export { SendMessageService } from './daemon/src/mcp/send-message.ts';
    export { LocalDeliveryStore } from './daemon/src/storage/local-delivery.ts';
  `, resolveDir: repo, loader: 'ts' }, outfile: file, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' });
  return import(pathToFileURL(file).href);
}

function setup(t, mods) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  mods.applySchema(db);
  const agents = new mods.AgentsRepo(db);
  const service = new mods.SendMessageService(db, agents, new mods.EventsOutbox(db));
  const store = new mods.LocalDeliveryStore(db);
  const sender = agents.register({ name: 'owner-sender', team: 'default', agent_type: 'custom' });
  return { db, agents, service, store, sender };
}

const outbox = (db) => db.prepare('SELECT message_id, status, generation FROM local_delivery_outbox').all();

test('a live lease owns delivery even when auto_poke is disabled', { skip: !Database }, async t => {
  const mods = await load(t);
  const { db, agents, service, store, sender } = setup(t, mods);
  const recipient = agents.register({
    name: 'owner-claude', team: 'default', agent_type: 'claude-code',
    session_key: 'sess-owner', name_mode: 'exact',
  });
  store.issueLease({ agentId: recipient.agent_id, sessionKey: 'sess-owner' });

  const result = await service.send({
    from: sender.agent_id, to_agent_id: recipient.agent_id,
    body: 'owner-probe', auto_poke: false,
  });
  assert.ok(result.recipients, `send must succeed: ${JSON.stringify(result)}`);
  const rows = outbox(db);
  assert.equal(rows.length, 1, 'exactly one local delivery row for one message');
  assert.equal(rows[0].status, 'stored');
  assert.equal(rows[0].generation, null, 'not claimed yet, but enqueued for the owner');
});

test('without a lease the polling path owns and no row is created', { skip: !Database }, async t => {
  const mods = await load(t);
  const { db, agents, service, sender } = setup(t, mods);
  const recipient = agents.register({ name: 'owner-plain', team: 'default', agent_type: 'custom' });

  // auto_poke true and false must both leave ownership with the polling path.
  await service.send({ from: sender.agent_id, to_agent_id: recipient.agent_id, body: 'no-lease-1' });
  await service.send({ from: sender.agent_id, to_agent_id: recipient.agent_id, body: 'no-lease-2', auto_poke: false });
  assert.equal(outbox(db).length, 0, 'no local owner means no outbox rows');
});

test('an expired lease hands ownership back instead of stranding rows', { skip: !Database }, async t => {
  const mods = await load(t);
  const { db, agents, service, store, sender } = setup(t, mods);
  const recipient = agents.register({
    name: 'owner-expired', team: 'default', agent_type: 'claude-code',
    session_key: 'sess-expired', name_mode: 'exact',
  });
  store.issueLease({ agentId: recipient.agent_id, sessionKey: 'sess-expired', ttlMs: 1000, now: Date.now() - 60_000 });
  assert.equal(store.hasLiveLease(recipient.agent_id), false);
  await service.send({ from: sender.agent_id, to_agent_id: recipient.agent_id, body: 'expired-lease' });
  assert.equal(outbox(db).length, 0, 'an expired lease must not create an unclaimable row');
});

test('self-sends never create a delivery row', { skip: !Database }, async t => {
  const mods = await load(t);
  const { db, agents, service, store, sender } = setup(t, mods);
  agents.register({ name: 'self-sess', team: 'default', agent_type: 'claude-code', session_key: 'sess-self', name_mode: 'exact' });
  const selfRow = agents.findByIdentity({ device: 'local', team: 'default', name: 'self-sess' });
  store.issueLease({ agentId: selfRow.agent_id, sessionKey: 'sess-self' });
  await service.send({ from: selfRow.agent_id, to_agent_id: selfRow.agent_id, body: 'to myself' });
  assert.equal(outbox(db).length, 0);
});

test('a recipient past the reachability window is stored, not refused', { skip: !Database }, async t => {
  const mods = await load(t);
  const { db, agents, service, sender } = setup(t, mods);
  const recipient = agents.register({ name: 'owner-stale', team: 'default', agent_type: 'custom' });
  const longAgo = new Date(Date.now() - 600_000).toISOString();
  db.prepare('UPDATE agents SET last_seen_at=? WHERE agent_id=?').run(longAgo, recipient.agent_id);

  const result = await service.send({ from: sender.agent_id, to_agent_id: recipient.agent_id, body: 'late reply payload' });
  assert.equal(result.error, undefined, `must not fail: ${JSON.stringify(result)}`);
  assert.equal(result.queued_unreachable, true);
  assert.ok(result.unreachable_seconds >= 180);

  const stored = db.prepare('SELECT body FROM messages WHERE to_agent_id=?').all(recipient.agent_id);
  assert.deepEqual(stored.map((row) => row.body), ['late reply payload'], 'the reply must be retrievable');
  const status = db.prepare('SELECT wake_status, skip_reason FROM message_delivery_status WHERE message_id=?')
    .get(result.message_id);
  assert.deepEqual(status, { wake_status: 'skipped', skip_reason: 'queued_unreachable' });
  assert.equal(outbox(db).length, 0, 'no local owner for an offline recipient');
});

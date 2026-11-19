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

test('daemon schema restart preserves zero unread cursors until an actual inbox read', { skip: !Database }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xats-schema-cursor-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const file = path.join(dir, 'schema.mjs');
  buildSync({ stdin: { contents: `
    export { applySchema } from './daemon/src/storage/schema.ts';
    export { AgentsRepo } from './daemon/src/storage/agents-repo.ts';
    export { GetInboxService } from './daemon/src/mcp/get-inbox.ts';
  `, resolveDir: repo, loader: 'ts' }, outfile: file, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' });
  const { applySchema, AgentsRepo, GetInboxService } = await import(pathToFileURL(file).href);
  const db = new Database(':memory:');
  t.after(() => db.close());
  applySchema(db);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO agents(agent_id,device,team,role,name,registered_at,last_seen_at,last_processed_event_id) VALUES (?,?,?,?,?,?,?,?)')
    .run('receiver', 'local', 'default', 'worker', 'receiver', now, now, 0);
  db.prepare('INSERT INTO events(from_team,to_team,event_type,payload,created_at) VALUES (?,?,?,?,?)')
    .run('default', 'default', 'message', '{}', now);
  db.prepare('INSERT INTO messages(id,event_id,from_team,to_team,from_agent_id,to_agent_id,body,sent_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('pending', 1, 'default', 'default', 'sender', 'receiver', 'unread during upgrade', now);
  const cursor = () => db.prepare('SELECT last_processed_event_id c FROM agents WHERE agent_id=?').get('receiver').c;
  for (let restart = 0; restart < 2; restart++) {
    applySchema(db);
    assert.equal(cursor(), 0, 'startup must not silently consume pending mail');
  }
  const inbox = new GetInboxService(db, new AgentsRepo(db));
  assert.equal(inbox.get({ caller: 'receiver', since_event_id: 0 }).messages[0].id, 'pending');
  assert.equal(cursor(), 0, 'preview remains read-only');
  assert.equal(inbox.get({ caller: 'receiver' }).messages[0].id, 'pending');
  assert.equal(cursor(), 1, 'actual inbox consumption advances the cursor');
  applySchema(db);
  assert.equal(cursor(), 1, 'startup must not reset consumed positions either');
});

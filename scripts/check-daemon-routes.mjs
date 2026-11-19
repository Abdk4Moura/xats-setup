#!/usr/bin/env node
// Portable exact source/build parity, with a deliberately reviewed route set.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const expected = ['/api/agents', '/api/agents/all', '/api/cursor', '/api/deregister', '/api/heartbeat', '/api/inbox', '/api/register', '/api/send', '/api/whoami'].sort();
const routes = text => [...new Set([...text.matchAll(/["'](\/api\/[a-z_/-]+)["']/g)].map(match => match[1]))].sort();
const source = routes(fs.readFileSync(path.join(repo, 'daemon/src/daemon/rest-api.ts'), 'utf8'));
const built = routes(fs.readFileSync(path.join(repo, 'daemon/dist/cli.js'), 'utf8'));
assert.deepEqual(source, expected, 'source route set differs from the reviewed API');
assert.deepEqual(built, expected, 'built route set differs from the reviewed API');
console.log(`Source and build expose exactly ${expected.length} reviewed REST routes.`);

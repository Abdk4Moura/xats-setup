// The rebind rule is TypeScript, so bundle it the way the other daemon tests do.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xats-bind-recovery-'))
const out = path.join(dir, 'binding-recovery.mjs')
buildSync({
  stdin: { contents: "export { selectRebindCandidate } from './daemon/src/daemon/binding-recovery.ts';",
    resolveDir: repo, loader: 'ts' },
  outfile: out, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent',
})
const { selectRebindCandidate } = await import(pathToFileURL(out).href)
test.after(() => fs.rmSync(dir, { recursive: true, force: true }))

test('exactly one lost binding is the only safe rebind candidate', () => {
  assert.deepEqual(selectRebindCandidate([{ agent_id: 'a1', team: 'default' }]), { agent_id: 'a1', team: 'default' })
})

test('zero or several lost bindings are refused instead of guessed', () => {
  assert.equal(selectRebindCandidate([]), null)
  assert.equal(selectRebindCandidate([
    { agent_id: 'a1', team: 'default' },
    { agent_id: 'a2', team: 'default' },
  ]), null)
})

test('malformed candidates are refused', () => {
  assert.equal(selectRebindCandidate([{ agent_id: '', team: 'default' }]), null)
  assert.equal(selectRebindCandidate([{ agent_id: 'a1', team: '' }]), null)
})

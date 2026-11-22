import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildSync } from 'esbuild'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xats-pane-draft-'))
buildSync({ entryPoints: [path.join(root, 'daemon/src/mcp/pane-draft.ts')], bundle: true, platform: 'node', format: 'esm', outfile: path.join(dir, 'draft.mjs') })
const { extractDraft } = await import(pathToFileURL(path.join(dir, 'draft.mjs')).href)
test.after(() => fs.rmSync(dir, { recursive: true, force: true }))

const pane = (...lines) => lines.join('\n')

test('an empty composer has no draft to preserve', () => {
  assert.deepEqual(extractDraft(pane('────────────────', '> ', '────────────────', '? for shortcuts')), { text: '', multiline: false })
})

test('one typed line is captured exactly so it can be put back', () => {
  assert.deepEqual(extractDraft(pane('some output', '> fix the failing test', '─────')), { text: 'fix the failing test', multiline: false })
})

test('a wrapped or multi-line draft is reported, never rewritten', () => {
  const wrapped = extractDraft(pane('> first part of a thought', 'second part', '─────'))
  assert.equal(wrapped.multiline, true)
  assert.match(wrapped.text, /first part of a thought\nsecond part/)
})

test('a Claude-style prompt marker is understood too', () => {
  assert.deepEqual(extractDraft(pane('❯ explain this file', '')).text, 'explain this file')
})

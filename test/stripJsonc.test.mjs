import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stripJsonc } from '../lib/harness.mjs';

describe('stripJsonc', () => {
  it('strips // line comments', () => {
    const raw = `{\n  // comment\n  "a": 1\n}`;
    const obj = JSON.parse(stripJsonc(raw));
    assert.equal(obj.a, 1);
  });
  it('strips /* block comments */', () => {
    const raw = `{\n  /* block */\n  "a": 1\n}`;
    assert.equal(JSON.parse(stripJsonc(raw)).a, 1);
  });
  it('strips trailing commas', () => {
    const raw = `{"a": 1, "b": [1,2,],}`;
    const obj = JSON.parse(stripJsonc(raw));
    assert.deepEqual(obj, { a: 1, b: [1,2] });
  });
  it('preserves // inside strings', () => {
    const raw = `{"url": "https://example.com//path"}`;
    assert.equal(JSON.parse(stripJsonc(raw)).url, 'https://example.com//path');
  });
  it('preserves /* */ inside strings', () => {
    const raw = `{"s": "/* not a comment */"}`;
    assert.equal(JSON.parse(stripJsonc(raw)).s, '/* not a comment */');
  });
  it('handles mixed comments and trailing comma', () => {
    const raw = `{
      // plugin list
      "plugin": ["a.ts", // keep
      ], /* end */
    }`;
    const obj = JSON.parse(stripJsonc(raw));
    assert.deepEqual(obj.plugin, ['a.ts']);
  });
});

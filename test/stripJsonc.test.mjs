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
  it('preserves comma-bracket text and escaped quotes inside user values', () => {
    const value = 'keep , ] and , } plus a "quoted" value';
    const raw = '// comment\n' + JSON.stringify({ value, array: ['literal , ]'] });
    assert.deepEqual(JSON.parse(stripJsonc(raw)), { value, array: ['literal , ]'] });
  });
  it('rejects unterminated comments instead of accepting a truncated config', () => {
    assert.throws(() => stripJsonc('{"value":1} /* unterminated'), /Unterminated/);
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

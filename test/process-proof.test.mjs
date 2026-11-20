import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeProcessProof, splitCommandLine } from '../lib/process-proof.mjs';

const exe = String.raw`C:\Program Files\nodejs\node.exe`;
const entry = String.raw`C:\Users\O'Neil\xats\cli.js`;
const command = `"${exe}" "${entry}" daemon --db "C:\\Data files\\data.db"`;

test('Windows command-line parsing preserves spaces and literal apostrophes', () => {
  assert.deepEqual(splitCommandLine(command), [exe, entry, 'daemon', '--db', String.raw`C:\Data files\data.db`]);
  assert.throws(() => splitCommandLine('"unterminated'), /Unterminated/);
});

test('Windows proof queries the precise listening socket without the NetTCPIP cmdlet loader', () => {
  let called = false;
  const result = nativeProcessProof(12345, 19000, 'win32', (binary, args, options) => {
    called = true;
    assert.equal(binary, 'powershell.exe');
    assert.ok(args.includes('-NoProfile'));
    assert.equal(options.timeout, 20000);
    const script = args.at(-1);
    assert.match(script, /MSFT_NetTCPConnection/);
    assert.match(script, /LocalPort = 19000 AND OwningProcess = 12345 AND State = 2/);
    assert.doesNotMatch(script, /Get-NetTCPConnection/);
    return JSON.stringify({ exe, command });
  });
  assert.equal(called, true);
  assert.deepEqual(result.argv, [exe, entry, 'daemon', '--db', String.raw`C:\Data files\data.db`]);
});

test('macOS scope never comes from flattened argv/environment text', () => {
  const calls = [];
  const result = nativeProcessProof(12345, 19000, 'darwin', (binary, args) => {
    calls.push([binary, args]);
    if (binary === '/usr/sbin/lsof') return 'p12345\n';
    assert.ok(!args.includes('eww'), 'environment must not be inferred from ambiguous text');
    return '/usr/local/bin/node /Users/fixture/cli.js daemon --port 19000';
  });
  assert.equal(result.env, undefined);
  assert.equal(calls.length, 2);
  assert.equal(result.argv[2], 'daemon');
});

test('Windows proof propagates a failed native probe instead of inventing ownership', () => {
  const failure = Object.assign(new Error('fixture cold-provider timeout'), { code: 'ETIMEDOUT' });
  assert.throws(() => nativeProcessProof(12345, 19000, 'win32', () => { throw failure; }), error => error === failure);
});

test('Windows proof refuses missing socket evidence and executable mismatches', () => {
  assert.equal(nativeProcessProof(12345, 19000, 'win32', () => '{}'), null);
  assert.equal(nativeProcessProof(12345, 19000, 'win32', () => JSON.stringify({ exe: 'different-node.exe', command })), null);
});

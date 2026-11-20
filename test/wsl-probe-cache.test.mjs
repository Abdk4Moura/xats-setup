import test from 'node:test';
import assert from 'node:assert/strict';
import { wslInfo } from '../lib/platform.mjs';

const find = name => name === 'wsl.exe' ? 'fixture-wsl.exe' : null;

test('one WSL snapshot serves all installer components without repeating startup probes', () => {
  let calls = 0;
  const probe = (binary, args, options) => {
    calls++;
    assert.equal(binary, 'fixture-wsl.exe');
    assert.equal(options.timeout, 4000);
    assert.match(args.at(-1), /opencode:/);
    assert.match(args.at(-1), /daemon:/);
    assert.match(args.at(-1), /pi:/);
    assert.match(args.at(-1), /omp:/);
    return { ok: true, stdout: 'opencode:found\ndaemon:found\npi:found\nomp:found\nhostname:linux-sandbox\n' };
  };
  const first = wslInfo({ platform: 'win32', find, probe });
  first.pi = false; // A consumer must not mutate the shared snapshot.
  for (let component = 0; component < 4; component++) {
    const info = wslInfo({ platform: 'win32', find, probe });
    assert.equal(info.pi, true);
    assert.equal(info.omp, true);
    assert.equal(info.daemon, true);
    assert.equal(info.hostname, 'linux-sandbox');
  }
  assert.equal(calls, 1);
});

test('an unavailable WSL probe is bounded once, rather than repeated for every component', () => {
  let calls = 0;
  const probe = () => { calls++; throw Object.assign(new Error('fixture timeout'), { code: 'ETIMEDOUT' }); };
  for (let component = 0; component < 4; component++) {
    const info = wslInfo({ platform: 'win32', find, probe });
    assert.equal(info.hasWSL, true);
    assert.equal(info.pi, false);
    assert.equal(info.daemon, false);
  }
  assert.equal(calls, 1);
});

test('different WSL binaries are probed independently and non-Windows runs never probe', () => {
  let calls = 0;
  const probe = () => { calls++; return { ok: true, stdout: '' }; };
  wslInfo({ platform: 'win32', find: () => 'first-wsl.exe', probe });
  wslInfo({ platform: 'win32', find: () => 'second-wsl.exe', probe });
  assert.equal(calls, 2);
  assert.equal(wslInfo({ platform: 'linux', find, probe }), null);
  assert.equal(wslInfo({ platform: 'win32', find: () => null, probe }), null);
  assert.equal(calls, 2);
});

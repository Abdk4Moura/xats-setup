import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { readPort, writePort, isPortFree, pickPort, portFile } from '../lib/platform.mjs';

describe('portFile helpers', () => {
  let tmp;
  let paths;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xats-test-'));
    paths = { xatsRoot: tmp };
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('readPort returns fallback when no file', () => {
    assert.equal(readPort(paths, 9100), 9100);
    assert.equal(readPort(paths, null), 9100);
  });
  it('writePort + readPort roundtrip', () => {
    writePort(paths, 9123);
    assert.equal(readPort(paths), 9123);
    assert.ok(fs.existsSync(portFile(paths)));
  });
  it('ignores invalid port file', () => {
    fs.writeFileSync(portFile(paths), 'not-a-number\n');
    assert.equal(readPort(paths, 9100), 9100);
  });
});

describe('isPortFree / pickPort (smoke)', () => {
  it('isPortFree returns boolean quickly', async () => {
    const free = await isPortFree(54321);
    assert.equal(typeof free, 'boolean');
  });
  it('pickPort returns a number from candidates', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xats-test-'));
    const paths = { xatsRoot: tmp };
    // use high ports likely free, no actual bind needed for persisted case
    writePort(paths, 54322);
    const picked = await pickPort(paths, [54322, 54323, 54324]);
    assert.ok([54322,54323,54324].includes(picked));
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

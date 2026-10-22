import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTunlionDevices,
  parseTailscaleStatus,
  parseNetbirdStatus,
  parseStaticPeers,
  overlayCandidates,
  attachXatsOverlay,
  detectProvider,
  isDialablePeer,
} from '../lib/overlay-discovery.mjs';

/* Fixtures are trimmed real payloads. */

const TUNLION = {
  ok: true,
  schema: 2,
  data: {
    devices: [
      { name: 'dgmfa', mesh: 'dgmfa.mesh', address: 'fdf1:1af7::1', online: true, state: 'active' },
      { name: 'idle-box', mesh: 'idle-box.mesh', address: '', online: false },
      { name: 'dovm', mesh: 'dovm.mesh', address: '198.18.10.187', online: true },
    ],
  },
};

const TAILSCALE = {
  Self: { HostName: 'dovm', DNSName: 'dovm.tail1234.ts.net.' },
  Peer: {
    'nodekey:aaa': {
      HostName: 'dgmfa',
      DNSName: 'dgmfa.tail1234.ts.net.',
      TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1'],
      Online: true,
    },
    'nodekey:bbb': {
      HostName: 'offline-box',
      DNSName: 'offline-box.tail1234.ts.net.',
      TailscaleIPs: ['100.101.102.104'],
      Online: false,
    },
  },
};

const NETBIRD = {
  peers: {
    total: 2,
    details: [
      { fqdn: 'dgmfa.netbird.cloud', netbirdIp: '100.64.0.7', status: 'Connected' },
      { fqdn: 'stale.netbird.cloud', netbirdIp: '100.64.0.8', status: 'Disconnected' },
    ],
  },
};

test('tunlion: every device with a mesh name is a candidate', () => {
  const peers = parseTunlionDevices(TUNLION);
  assert.deepEqual(peers.map((p) => p.host), ['dgmfa.mesh', 'idle-box.mesh', 'dovm.mesh']);
});

test('tailscale: MagicDNS preferred over raw addresses', () => {
  const peers = parseTailscaleStatus(TAILSCALE);
  assert.equal(peers.length, 1);
  assert.equal(peers[0].host, 'dgmfa.tail1234.ts.net');
  assert.equal(peers[0].name, 'dgmfa');
});

test('tailscale: falls back to the 100.x address when MagicDNS is off', () => {
  const noDns = {
    Peer: { k: { HostName: 'peer-a', TailscaleIPs: ['100.64.1.2'], Online: true } },
  };
  const peers = parseTailscaleStatus(noDns);
  assert.equal(peers[0].host, '100.64.1.2');
});

test('tailscale: skips offline peers and this device', () => {
  assert.equal(parseTailscaleStatus(TAILSCALE, 'dgmfa.tail1234.ts.net').length, 0);
});

test('netbird: connected peers only', () => {
  const peers = parseNetbirdStatus(NETBIRD);
  assert.equal(peers.length, 1);
  assert.equal(peers[0].host, 'dgmfa.netbird.cloud');
});

test('static provider covers overlays with no CLI', () => {
  assert.deepEqual(parseStaticPeers('a.example, b=b.example'), [
    { name: 'a.example', host: 'a.example' },
    { name: 'b', host: 'b.example' },
  ]);
});

test('all providers emit the same candidate shape', () => {
  const candidates = overlayCandidates({
    peers: parseTailscaleStatus(TAILSCALE),
    port: 9110,
    now: () => 7,
    source: 'tailscale',
  });
  assert.deepEqual(candidates[0], {
    deviceId: 'dgmfa',
    endpoint: { host: 'dgmfa.tail1234.ts.net', port: 9110 },
    serviceName: 'dgmfa.tail1234.ts.net',
    protocolVersion: '1',
    discoveredAt: 7,
    source: 'tailscale',
    online: false,
    l3: null,
  });
});

test('attach works identically on tailscale', async () => {
  const seen = [];
  const handle = attachXatsOverlay({
    provider: 'tailscale',
    port: 9110,
    runCommand: async () => JSON.stringify(TAILSCALE),
    resolve: async () => ({ address: '100.101.102.103', family: 4 }),
    onCandidate: (c) => seen.push(c),
    autoScan: false,
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
  });
  await handle.scan();
  handle.stop();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].source, 'tailscale');
});

test('static provider needs no binary at all', async () => {
  const seen = [];
  const handle = attachXatsOverlay({
    provider: 'static',
    port: 9110,
    env: { XATS_OVERLAY_PEERS: 'peer-a,peer-b' },
    resolve: async () => ({ address: '10.0.0.1', family: 4 }),
    onCandidate: (c) => seen.push(c),
    autoScan: false,
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
  });
  await handle.scan();
  handle.stop();
  assert.deepEqual(seen.map((c) => c.deviceId), ['peer-a', 'peer-b']);
});

test('an unresolvable peer is dropped rather than offered', async () => {
  const seen = [];
  const errors = [];
  const handle = attachXatsOverlay({
    provider: 'static',
    port: 9110,
    env: { XATS_OVERLAY_PEERS: 'gone' },
    resolve: async () => {
      throw new Error('ENOTFOUND');
    },
    onCandidate: (c) => seen.push(c),
    onError: (e) => errors.push(e.message),
    autoScan: false,
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
  });
  await handle.scan();
  handle.stop();
  assert.equal(seen.length, 0);
  assert.equal(errors.length, 1);
});

test('a missing overlay CLI is an error, not a crash', async () => {
  const errors = [];
  const handle = attachXatsOverlay({
    provider: 'netbird',
    port: 9110,
    runCommand: async () => {
      throw new Error('spawn netbird ENOENT');
    },
    resolve: async () => ({ address: '1.2.3.4', family: 4 }),
    onCandidate: () => {},
    onError: (e) => errors.push(e.message),
    autoScan: false,
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
  });
  await handle.scan();
  handle.stop();
  assert.match(errors[0], /ENOENT/);
});

test('provider auto-detection prefers an installed overlay', () => {
  assert.equal(detectProvider({ which: (cmd) => (cmd === 'tunlion' ? '/usr/bin/tunlion' : null), env: {} }), 'tunlion');
  assert.equal(
    detectProvider({ which: (cmd) => (cmd === 'tailscale' ? '/usr/bin/tailscale' : null), env: {} }),
    'tailscale',
  );
  assert.equal(detectProvider({ which: () => null, env: { XATS_OVERLAY_PEERS: 'a' } }), 'static');
  assert.equal(detectProvider({ which: () => null, env: {} }), null);
  assert.equal(detectProvider({ which: () => '/x', env: { XATS_OVERLAY: 'tailscale' } }), 'tailscale');
});

test('emits each peer once and reports it lost when it disappears', async () => {
  let peers = 'a.example,b.example';
  const seen = [];
  const lost = [];
  const handle = attachXatsOverlay({
    provider: 'static',
    port: 9110,
    env: {
      get XATS_OVERLAY_PEERS() {
        return peers;
      },
    },
    resolve: async () => ({ address: '10.0.0.1', family: 4 }),
    onCandidate: (c) => seen.push(c.deviceId),
    onLost: (c) => lost.push(c.deviceId),
    autoScan: false,
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
  });

  await handle.scan();
  await handle.scan(); // repeated scans must not re-announce
  assert.deepEqual(seen, ['a.example', 'b.example']);

  peers = 'a.example';
  await handle.scan();
  assert.deepEqual(lost, ['b.example']);

  handle.stop();
  await handle.scan();
  assert.deepEqual(seen, ['a.example', 'b.example'], 'a stopped provider stops scanning');
});

test('whichInPath honours PATH and PATHEXT without the installer helpers', async () => {
  const { whichInPath } = await import('../lib/overlay-discovery.mjs');
  const path = await import('node:path');
  const isWin = process.platform === 'win32';

  // Build expectations with path.join: on Windows the separator is different and
  // PATHEXT appends .EXE, so a hardcoded POSIX string is a broken test, not a
  // broken implementation.
  const dir = isWin ? 'C:\\ov' : '/opt/ov';
  const target = path.join(dir, isWin ? 'tunlion.exe' : 'tunlion');
  const exists = (p) => p.toLowerCase() === target.toLowerCase();

  assert.equal(whichInPath('tunlion', { PATH: dir, PATHEXT: '.EXE' }, exists), target);
  assert.equal(whichInPath('nope', { PATH: dir, PATHEXT: '.EXE' }, exists), null);
});

test('every peer on the overlay is offered, with its l3 state as a hint only', () => {
  // Discovery answers "who is on this overlay". It must not filter on reported
  // reachability: those fields go stale (a peer reporting online:false answered
  // 401), and a stale field must never hide a candidate.
  const payload = {
    data: {
      devices: [
        { name: 'live', mesh: 'live.mesh', online: true, l3: { state: 'ready', mode: 'kernel' } },
        { name: 'dead', mesh: 'dead.mesh', online: true, l3: { state: 'down', mode: 'none', reason: 'l3_start_failed' } },
        { name: 'booting', mesh: 'booting.mesh', online: true, l3: { state: 'starting', mode: 'userspace' } },
      ],
    },
  };
  const peers = parseTunlionDevices(payload);
  const candidates = overlayCandidates({ peers, port: 9110, source: 'tunlion' });
  assert.deepEqual(candidates.map((c) => c.deviceId), ['live', 'dead', 'booting']);
  assert.equal(candidates[0].l3.state, 'ready');
  assert.equal(candidates[1].l3.reason, 'l3_start_failed');
});

test('builds without an l3 field keep working (back-compat)', () => {
  const peers = parseTunlionDevices({ data: { devices: [{ name: 'old', mesh: 'old.mesh', online: true }] } });
  assert.equal(overlayCandidates({ peers, port: 9110 }).length, 1);
});

test('isDialablePeer is a preference hint, not a filter', () => {
  assert.equal(isDialablePeer({ l3: { state: 'ready' } }), true);
  assert.equal(isDialablePeer({ l3: { state: 'down' } }), false);
  assert.equal(isDialablePeer({ l3: { state: 'starting' } }), false);
  assert.equal(isDialablePeer({}), true);
  assert.equal(isDialablePeer(null), false);
  // A peer with no address is still not a candidate, regardless of l3 state.
  assert.equal(overlayCandidates({ peers: [{ name: 'x', host: '' }], port: 9110 }).length, 0);
});

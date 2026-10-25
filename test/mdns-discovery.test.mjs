import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { attachXatsMdns, XATS_MDNS_TYPE, XATS_PEER_PROTOCOL_VERSION } from '../lib/mdns-discovery.mjs';

const own = 'a'.repeat(32);
const peer = 'b'.repeat(32);

function fakeBonjour() {
  const browser = new EventEmitter();
  browser.stop = () => { browser.stopped = true; };
  const service = new EventEmitter();
  service.stop = (done) => { service.stopped = true; done?.(); };
  return {
    browser,
    service,
    published: null,
    destroyed: false,
    find(options) { this.findOptions = options; return browser; },
    publish(options) { this.published = options; return service; },
    destroy(done) { this.destroyed = true; done?.(); },
  };
}

function announcement(overrides = {}) {
  return {
    type: XATS_MDNS_TYPE,
    protocol: 'tcp',
    port: 9211,
    name: `xats-${peer}`,
    txt: { xats_v: XATS_PEER_PROTOCOL_VERSION, xats_id: peer },
    addresses: ['192.168.1.22', 'fd00::22', '127.0.0.1', 'bad-address'],
    ...overrides,
  };
}

test('advertises only public peer metadata and reports discovered candidates without trusting them', async () => {
  const bonjour = fakeBonjour();
  const candidates = [];
  const errors = [];
  const discovery = attachXatsMdns({ bonjour, deviceId: own, port: 9123, onCandidate: (x) => candidates.push(x), onError: (e) => errors.push(e), now: () => 1234 });
  assert.deepEqual(bonjour.findOptions, { type: XATS_MDNS_TYPE });
  assert.deepEqual(bonjour.published, {
    name: `xats-${own}`,
    type: XATS_MDNS_TYPE,
    protocol: 'tcp',
    port: 9123,
    txt: { xats_v: '1', xats_id: own },
  });
  bonjour.browser.emit('up', announcement());
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map((c) => c.endpoint.host), ['192.168.1.22', 'fd00::22']);
  assert.equal(candidates[0].deviceId, peer);
  assert.equal(candidates[0].discoveredAt, 1234);
  assert.equal(discovery.candidates().length, 2);
  assert.deepEqual(errors, []);
  await discovery.close();
  assert.equal(bonjour.browser.stopped, true);
  assert.equal(bonjour.service.stopped, true);
  assert.equal(bonjour.destroyed, true);
});

test('rejects invalid, self, unsupported-version and malformed service records', async () => {
  const bonjour = fakeBonjour();
  const candidates = [];
  const discovery = attachXatsMdns({ bonjour, deviceId: own, port: 9123, onCandidate: (x) => candidates.push(x) });
  bonjour.browser.emit('up', announcement({ txt: { xats_v: '2', xats_id: peer } }));
  bonjour.browser.emit('up', announcement({ txt: { xats_v: '1', xats_id: own } }));
  bonjour.browser.emit('up', announcement({ port: 70000 }));
  bonjour.browser.emit('up', announcement({ type: 'http' }));
  bonjour.browser.emit('up', announcement({ txt: { xats_v: '1', xats_id: 'not-an-id' } }));
  assert.equal(candidates.length, 0);
  await discovery.close();
});

test('down event removes candidates for that service', async () => {
  const bonjour = fakeBonjour();
  const lost = [];
  const discovery = attachXatsMdns({ bonjour, deviceId: own, port: 9123, onCandidate() {}, onLost: (x) => lost.push(x) });
  bonjour.browser.emit('up', announcement());
  bonjour.browser.emit('down', announcement());
  assert.equal(discovery.candidates().length, 0);
  assert.equal(lost.length, 2);
  await discovery.close();
});

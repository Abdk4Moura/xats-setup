import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  defaultPeerConfig,
  normalizePeerConfig,
  loadPeerConfig,
  savePeerConfig,
  setPeerConfigValue,
  effectiveOverlay,
  policyAllowsAutoApprove,
} from '../lib/peer-config.mjs';

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xats-peercfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('defaults are conservative', () => {
  const cfg = defaultPeerConfig();
  assert.equal(cfg.autoApprove, 'manual');
  assert.equal(cfg.overlay, 'auto');
});

test('a corrupt or missing file never blocks startup', (t) => {
  const dir = tmp(t);
  assert.equal(loadPeerConfig(dir).autoApprove, 'manual');
  fs.writeFileSync(path.join(dir, 'config.json'), '{ not json');
  assert.equal(loadPeerConfig(dir).autoApprove, 'manual');
});

test('unknown policy values fall back to manual, not to permissive', () => {
  assert.equal(normalizePeerConfig({ autoApprove: 'yolo' }).autoApprove, 'manual');
  assert.equal(normalizePeerConfig({ autoApprove: 'shared' }).autoApprove, 'shared');
});

test('saved config round-trips through a private file', (t) => {
  const dir = tmp(t);
  savePeerConfig(dir, { autoApprove: 'shared', overlay: 'tunlion', overlayPeers: ['a.mesh'] });
  const loaded = loadPeerConfig(dir);
  assert.equal(loaded.autoApprove, 'shared');
  assert.equal(loaded.overlay, 'tunlion');
  assert.deepEqual(loaded.overlayPeers, ['a.mesh']);
  const mode = fs.statSync(path.join(dir, 'config.json')).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('dotted keys set individual values and reject nonsense', (t) => {
  const dir = tmp(t);
  assert.equal(setPeerConfigValue(dir, 'policy.autoApprove', 'shared').autoApprove, 'shared');
  assert.equal(setPeerConfigValue(dir, 'overlay', 'tailscale').overlay, 'tailscale');
  assert.equal(setPeerConfigValue(dir, 'port', '9115').port, 9115);
  assert.throws(() => setPeerConfigValue(dir, 'policy.autoApprove', 'openish'), /invalid policy/);
  assert.throws(() => setPeerConfigValue(dir, 'nope', 'x'), /unknown setting/);
});

test('env overrides the saved default for one run', () => {
  assert.equal(effectiveOverlay({ XATS_OVERLAY: 'static' }, { overlay: 'tunlion' }), 'static');
  assert.equal(effectiveOverlay({}, { overlay: 'tunlion' }), 'tunlion');
  assert.equal(effectiveOverlay({}, {}), 'auto');
});

test('permissiveness levels mean what they say', () => {
  const shared = { source: 'tunlion' };
  const trusted = { trustedOverlays: ['tunlion'] };
  assert.equal(policyAllowsAutoApprove('manual', shared, trusted), false);
  assert.equal(policyAllowsAutoApprove('shared', shared, trusted), true);
  assert.equal(policyAllowsAutoApprove('open', {}, trusted), true);
  // An unknown level must never be treated as permissive.
  assert.equal(policyAllowsAutoApprove(undefined, shared, trusted), false);
});

test('shared does not treat the whole mesh as trusted', () => {
  const onMesh = { source: 'tunlion' };
  // Nothing allowlisted yet: sharing an interface is not trust.
  assert.equal(policyAllowsAutoApprove('shared', onMesh, { trustedOverlays: [] }), false);
  assert.equal(policyAllowsAutoApprove('shared', onMesh, {}), false);
  // A different overlay is not covered by allowlisting one.
  assert.equal(policyAllowsAutoApprove('shared', onMesh, { trustedOverlays: ['tailscale'] }), false);
  // An untagged candidate never qualifies.
  assert.equal(policyAllowsAutoApprove('shared', {}, { trustedOverlays: ['tunlion'] }), false);
});

test('trustedOverlays round-trips as a setting', (t) => {
  const dir = tmp(t);
  assert.deepEqual(setPeerConfigValue(dir, 'trustedOverlays', 'xats, tunlion').trustedOverlays, ['xats', 'tunlion']);
  assert.deepEqual(loadPeerConfig(dir).trustedOverlays, ['xats', 'tunlion']);
});

// bridge.mjs — install the cross-machine relay bridge (Node port, no Python).
// Places bridge.mjs + a peers.json scaffold. Bringing the bridge ONTO the mesh
// (connecting to a specific remote peer over the tunnel) is a separate,
// coordinated step — the installer only lays it down and prints how.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { log, isDry, copyFile, ensureDir, writeFile } from './log.mjs';
import { nodeBin } from './platform.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ASSET = path.join(__dir, '..', 'assets', 'bridge', 'bridge.mjs');

export function installBridge(paths) {
  log.step('Bridge: install cross-machine relay (Node, no Python)');
  if (!fs.existsSync(ASSET)) {
    log.warn('bridge.mjs asset not present in this package build — skipping bridge component');
    return { skipped: true };
  }
  const dir = path.join(paths.xatsRoot, 'bridge');
  ensureDir(dir);
  const dest = path.join(dir, 'bridge.mjs');
  copyFile(ASSET, dest);

  const peers = path.join(dir, 'peers.json');
  if (!fs.existsSync(peers)) {
    writeFile(peers, JSON.stringify({ peers: [] }, null, 2) + '\n');
    log.info('wrote empty peers.json — add a peer, then bring the bridge up');
  } else {
    log.info('peers.json already present — left as-is');
  }

  log.ok(`bridge installed: ${dest}`);
  log.info('to bring it onto the mesh (coordinated with the remote peer):');
  log.info(`  ${nodeBin()} ${dest} up`);
  return { dir, dest, peers };
}

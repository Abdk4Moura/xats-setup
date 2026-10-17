// peer.mjs — install the Stage 1 direct xats peer runtime without starting a listener.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { log, isDry, ensureDir, copyFile, writeFile } from './log.mjs';
import { nodeBin, runNpm, npmBin } from './platform.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const VERSIONED_DEPS = ['bonjour-service@1.4.4', 'selfsigned@5.5.0'];
const RUNTIME_FILES = [
  'peer-identity.mjs',
  'peer-pairing.mjs',
  'peer-tls.mjs',
  'peer-transport.mjs',
  'mdns-discovery.mjs',
  'peer-runtime.mjs',
  'peer-federation.mjs',
  'peer-cli.mjs',
];

function installDependencies(dir) {
  if (!npmBin()) {
    log.err('npm not found — install Node.js/npm before enabling xats peer networking');
    throw new Error('npm missing');
  }
  const manifest = path.join(dir, 'package.json');
  const desired = {
    name: 'xats-peer-runtime',
    private: true,
    type: 'module',
    dependencies: { 'bonjour-service': '1.4.4', selfsigned: '5.5.0' },
  };
  const desiredText = `${JSON.stringify(desired, null, 2)}\n`;
  const manifestChanged = !fs.existsSync(manifest) || fs.readFileSync(manifest, 'utf8') !== desiredText;
  if (manifestChanged) writeFile(manifest, desiredText);
  const installed = VERSIONED_DEPS.every((spec) => {
    const [name, version] = spec.split('@');
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', name, 'package.json'), 'utf8'));
      return pkg.version === version;
    } catch { return false; }
  });
  if (installed) {
    log.info('peer runtime dependencies already installed at pinned versions');
    return manifestChanged;
  }
  if (isDry()) {
    log.dry(`npm install --prefix ${dir} --no-audit --no-fund`);
    return true;
  }
  log.info('installing pinned Bonjour and TLS certificate libraries for the peer runtime…');
  const result = runNpm(['install', '--prefix', dir, '--no-audit', '--no-fund'], { stdio: ['ignore', 'ignore', 'pipe'] });
  if (!result.ok) {
    log.err(`peer runtime dependency install failed (${result.code})`);
    if (result.stderr) log.info(result.stderr.split('\n').slice(-5).join('\n'));
    throw new Error('peer runtime dependencies unavailable');
  }
  return true;
}

export function installPeer(paths) {
  log.step('Peer: install secure Stage 1 network runtime');
  const sourceDir = path.join(__dir, '..');
  const dir = path.join(paths.xatsRoot, 'peer');
  ensureDir(dir);
  const libDir = path.join(dir, 'lib');
  ensureDir(libDir);
  let updated = false;
  for (const file of RUNTIME_FILES) {
    const source = path.join(sourceDir, 'lib', file);
    const destination = path.join(libDir, file);
    const changed = !fs.existsSync(destination) || !fs.readFileSync(source).equals(fs.readFileSync(destination));
    copyFile(source, destination);
    updated ||= changed;
  }
  const entry = path.join(dir, 'peer.mjs');
  const sourceEntry = path.join(sourceDir, 'assets', 'peer', 'peer.mjs');
  const entryChanged = !fs.existsSync(entry) || !fs.readFileSync(sourceEntry).equals(fs.readFileSync(entry));
  copyFile(sourceEntry, entry);
  updated ||= entryChanged;
  const dependenciesUpdated = installDependencies(dir);
  updated ||= dependenciesUpdated;
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
  log.ok(`Stage 1 peer runtime installed: ${entry}`);
  log.info('network listeners are not started by setup; explicitly run `xats peer run` to enable discovery');
  return { dir, entry, command: `${nodeBin()} ${entry}`, updated };
}

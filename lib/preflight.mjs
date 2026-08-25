// preflight.mjs — verify the host can host the daemon compiler-free, and
// decide an ABI-safe better-sqlite3 pin for the running Node.
//
// Why: cross-agent-teams-mcp floats better-sqlite3 @^12, whose latest 12.x has
// NO prebuilt binary for Node 20/23 — so a plain install there compiles from
// source (needs a C++ toolchain) on every OS. Node 22/24/25/26 LTS have full
// prebuild coverage. The native .node is ABI-locked to the Node major it is
// installed under, and our service runs the daemon with THIS same node, so
// install-node == run-node by construction.
import { log } from './log.mjs';
import { npmBin, summary, which } from './platform.mjs';

// Node majors that lack a prebuilt better-sqlite3 in the latest 12.x float.
// For these we pin the last release that still ships their ABI prebuild.
const NO_PREBUILD_MAJORS = new Set([20, 23]);
const FALLBACK_BSQLITE = '12.9.0';

export function betterSqlitePin() {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  return NO_PREBUILD_MAJORS.has(major) ? FALLBACK_BSQLITE : null;
}

export function preflight() {
  log.step('Preflight');
  const s = summary();
  log.info(`platform=${s.platform} arch=${s.arch} node=${s.node} host=${s.host}`);

  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 20) {
    log.err(`Node ${s.node} is too old — the daemon requires Node >=20 (Node 22 LTS recommended).`);
    throw new Error('node too old');
  }
  if (!npmBin()) {
    log.err('npm not found on PATH — install Node.js (which bundles npm) first.');
    throw new Error('npm missing');
  }

  const pin = betterSqlitePin();
  if (pin) {
    log.warn(`Node ${major} has no prebuilt better-sqlite3 in the current 12.x float.`);
    log.info(`→ will pin better-sqlite3@${pin} (last with a Node-${major} prebuild) to avoid a source compile.`);
    log.info('  For the cleanest install, consider Node 22 LTS (full prebuild coverage, all OSes).');
  } else {
    log.ok(`Node ${major}: better-sqlite3 prebuilds available — no compiler needed.`);
  }
  // Bridge mesh needs filament on PATH. Not fatal — installer still lays down bridge.mjs.
  if (!which('filament')) {
    log.warn('filament not found on PATH — bridge mesh (filament forward) will not work until you install it.');
    log.info('  Install: cargo install filament  or  see https://github.com/moshe-azaria/filament');
  } else {
    log.ok('filament found — bridge mesh ready');
  }
  // WSL probe is handled in install.mjs (needs paths); preflight just reports platform.
  return { major, betterSqlitePin: pin };
}

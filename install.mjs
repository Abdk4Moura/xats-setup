#!/usr/bin/env node
// xats-setup — one-command, OS-agnostic installer for the xats cross-agent bus.
//   npx xats-setup [options]
//
// Stands up (identical on Windows / macOS / Linux):
//   daemon   patched cross-agent-teams-mcp into ~/.xats/daemon (no sudo)
//   service  run at login/boot (systemd | launchd | Scheduled Task)
//   claude   SessionStart/SessionEnd hooks + MCP entry (pure-Node hook)
//   harness  opencode/mimocode plugins + xats skill
//   bridge   cross-machine relay (Node port; connect to mesh separately)
//
// Everything is idempotent — safe to re-run. Use --dry-run to preview.
import { log, setDry, isDry } from './lib/log.mjs';
import { paths as getPaths, summary } from './lib/platform.mjs';
import { preflight } from './lib/preflight.mjs';
import { installDaemon } from './lib/daemon.mjs';
import { installService } from './lib/service.mjs';
import { installClaude } from './lib/claude.mjs';
import { installHarnesses } from './lib/harness.mjs';
import { installBridge } from './lib/bridge.mjs';
import { restartDaemon } from './lib/service.mjs';
import { describeRun, writeManifest } from './lib/manifest.mjs';
import { BASE_URL } from './lib/constants.mjs';
import { ensureDir } from './lib/log.mjs';
import { readFileSync } from 'node:fs';

const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const ALL = ['daemon', 'service', 'claude', 'harness', 'bridge'];

function parseArgs(argv) {
  const o = { components: new Set(ALL), force: false, dry: false, label: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dry = true;
    else if (a === '--force') o.force = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--label') o.label = argv[++i];
    else if (a.startsWith('--only=')) o.components = new Set(a.slice(7).split(',').map((s) => s.trim()).filter(Boolean));
    else if (a.startsWith('--no-')) o.components.delete(a.slice(5));
    else log.warn(`ignoring unknown arg: ${a}`);
  }
  return o;
}

function help() {
  console.log(`xats-setup — OS-agnostic xats bus installer

Usage:
  npx xats-setup [options]

Options:
  --dry-run           preview every action, change nothing
  --force             reinstall the daemon base package
  --only=a,b,c        install only these components (${ALL.join(',')})
  --no-<component>    skip a component (e.g. --no-bridge, --no-harness)
  --label <name>      identity label for this box's agents
  -h, --help          show this help

Components: ${ALL.join(', ')}
`);
}

async function healthCheck() {
  for (let i = 0; i < 10; i++) {
    try {
      const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return await res.json();
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 700));
  }
  return null;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return help();
  setDry(opts.dry);
  if (opts.label) process.env.XATS_LABEL = opts.label;

  console.log(`\n  xats-setup v${VERSION} — full-peer install ${isDry() ? '(DRY RUN)' : ''}`);
  const paths = getPaths();
  ensureDir(paths.xatsRoot);

  // Detect a prior install so we can update it in place (idempotent + migrate).
  const { prior, mode } = describeRun(paths, VERSION);

  const pre = preflight();

  let lay = null;
  if (opts.components.has('daemon'))
    lay = installDaemon(paths, { force: opts.force, betterSqlitePin: pre.betterSqlitePin });
  else { const { daemonLayout } = await import('./lib/daemon.mjs'); lay = daemonLayout(paths); }

  if (opts.components.has('service')) installService(lay);
  // On an UPGRADE where the daemon build actually changed, the old daemon is
  // still running the old code — restart it so the update takes effect. (Fresh
  // installs already started the new build in the service step.)
  if (opts.components.has('daemon') && lay && lay.updated && mode !== 'fresh')
    restartDaemon(paths, lay.entry);

  if (opts.components.has('claude')) installClaude(paths);
  if (opts.components.has('harness')) installHarnesses(paths);
  if (opts.components.has('bridge')) installBridge(paths);

  // Verify
  log.step('Verify');
  if (isDry()) { log.dry(`would health-check ${BASE_URL}/health`); }
  else if (opts.components.has('daemon') || opts.components.has('service')) {
    const h = await healthCheck();
    if (h && h.ok) log.ok(`daemon healthy — v${h.version || '?'}, uptime ${Math.round(h.uptime_seconds || 0)}s`);
    else log.warn(`daemon not answering on ${BASE_URL}/health yet — check the service, then: curl ${BASE_URL}/health`);
  }

  // Record what we installed so a future run can detect + update this box.
  if (!isDry()) {
    writeManifest(paths, {
      version: VERSION,
      updatedAt: new Date().toISOString(),
      platform: process.platform,
      components: [...opts.components],
      daemonEntry: lay ? lay.entry : null,
    });
  }

  const s = summary();
  log.step('Done');
  console.log(`  Box:    ${s.host} (${s.platform}/${s.arch}, node ${s.node})`);
  console.log(`  Mode:   ${mode}${prior ? ` (was v${prior.version})` : ''} -> v${VERSION}`);
  console.log(`  Daemon: ${lay ? lay.entry : 'n/a'}`);
  console.log(`  Bus:    ${BASE_URL}`);
  console.log(`  Next:   restart Claude Code / opencode so they register on the bus.`);
  if (opts.components.has('bridge'))
    console.log(`  Bridge: add a peer to ~/.xats/bridge/peers.json, then \`node ~/.xats/bridge/bridge.mjs up\` (coordinate with the remote).`);
  console.log('');
}

main().catch((e) => { log.err(e.message || String(e)); process.exit(1); });

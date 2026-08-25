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
import { log, setDry, isDry, initLogFile, getLogFile, enableEphemeral, disableEphemeral, setEphemeralSteps, setStepStatus } from './lib/log.mjs';
import { paths as getPaths, summary, wslInfo, readLabelFile, writeLabelFile, readPort, writePort, pickPort } from './lib/platform.mjs';
import { preflight } from './lib/preflight.mjs';
import { installDaemon } from './lib/daemon.mjs';
import { installService } from './lib/service.mjs';
import { installClaude } from './lib/claude.mjs';
import { installOpencode, installMimocode, installHarnesses } from './lib/harness.mjs';
import { installPi, ensurePiLabel } from './lib/pi.mjs';
import { installBridge } from './lib/bridge.mjs';
import { restartDaemon } from './lib/service.mjs';
import { describeRun, writeManifest } from './lib/manifest.mjs';
import { reset } from './lib/reset.mjs';
import { BASE_URL as DEFAULT_BASE, PORT as DEFAULT_PORT } from './lib/constants.mjs';
import { ensureDir } from './lib/log.mjs';
import { readFileSync, existsSync } from 'node:fs';
import * as readline from 'node:readline';
import path from 'node:path';

const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const AGENTS = ['claude', 'pi', 'opencode', 'mimocode'];
const INFRA = ['daemon', 'service', 'bridge'];
const ALL = [...INFRA.slice(0, 2), ...AGENTS, ...INFRA.slice(2)]; // daemon,service,claude,pi,opencode,mimocode,bridge
const HARNESS_ALIAS = new Set(['opencode', 'mimocode', 'pi']); // back-compat: harness = opencode+mimocode+pi until removed

function normalizeComponents(set) {
  if (set.has('harness')) {
    log.warn('harness is deprecated — use opencode,mimocode,pi (claude is separate)');
    set.delete('harness');
    for (const k of HARNESS_ALIAS) set.add(k);
  }
  if (set.has('all')) { for (const k of ALL) set.add(k); set.delete('all'); }
  for (const k of [...set]) if (!ALL.includes(k) && k !== 'harness') log.warn(`unknown component: ${k}`);
  return set;
}

const EXCLUDE_VERBS = ['--without', '--except', '--exclude', '--skip', '--omit'];
function parseExcludeList(a, argv, i) {
  let raw = null;
  const eq = a.indexOf('=');
  if (eq !== -1) raw = a.slice(eq + 1);
  else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) raw = argv[++i];
  return { raw, nextI: i };
}
function applyExclude(raw, set) {
  for (const k of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (k === 'harness') for (const x of HARNESS_ALIAS) set.delete(x);
    else set.delete(k);
  }
}
function parseArgs(argv) {
  const o = { components: new Set(ALL), force: false, dry: false, label: null, reset: false, explicit: false, nonInteractive: false, interactive: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dry = true;
    else if (a === '--force') o.force = true;
    else if (a === '--yes' || a === '-y' || a === '--non-interactive') o.nonInteractive = true;
    else if (a === '--interactive' || a === '-i') o.interactive = true;
    else if (a === '--verbose' || a === '--no-ephemeral') o.verbose = true;
    else if (a === 'reset' || a === '--reset') o.reset = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--label') o.label = argv[++i];
    else if (a.startsWith('--only=')) { o.components = normalizeComponents(new Set(a.slice(7).split(',').map((s) => s.trim()).filter(Boolean))); o.explicit = true; }
    else if (a === '--only' && i + 1 < argv.length) { o.components = normalizeComponents(new Set(argv[++i].split(',').map((s) => s.trim()).filter(Boolean))); o.explicit = true; }
    else if (EXCLUDE_VERBS.some((v) => a === v || a.startsWith(v + '='))) {
      const { raw, nextI } = parseExcludeList(a, argv, i);
      i = nextI;
      if (!raw) { log.warn(`${a} needs a list e.g. ${a}=claude,pi`); continue; }
      applyExclude(raw, o.components);
      o.explicit = true;
    }
    else if (a.startsWith('--no-')) { const k = a.slice(5); if (k === 'harness') { for (const x of HARNESS_ALIAS) o.components.delete(x); } else o.components.delete(k); o.explicit = true; }
    else log.warn(`ignoring unknown arg: ${a}`);
  }
  if ([...o.components].some((k) => k === 'harness')) normalizeComponents(o.components);
  return o;
}

function help() {
  console.log(`xats-setup — OS-agnostic xats bus installer

Usage:
  npx xats-setup [options]

Options:
  --dry-run           preview every action, change nothing
  --force             reinstall the daemon base package
  --verbose           show live logs instead of ephemeral loader (also --no-ephemeral)
  -y, --yes, --non-interactive  skip interactive prompts (use defaults / --only/--no-)
  -i, --interactive   force interactive picker (default when TTY and no --only/--no-)
  reset, --reset       remove files, config entries, and service owned by xats-setup
                       (respects --only/--no-; e.g. reset --only=pi)
  --only=a,b,c        install only these components (${ALL.join(',')})
  --without=a,b,c     exclude components (verb form — same as --no-* but generic)
                      aliases: --except, --exclude, --skip, --omit
                      e.g. --without claude,pi  or  --except=bridge
  --no-<component>    skip one component (kept for compat, e.g. --no-pi)
  --label <name>      identity label for this box's agents
  -h, --help          show this help

Components: ${ALL.join(', ')}  (harness is deprecated alias for opencode,mimocode,pi)
Agents: ${AGENTS.join(', ')} — pick any subset (default: all). Example: --only=daemon,service,pi

Interactive: running npx xats-setup in a terminal with no --only/--no- opens an
  easy picker — press Enter to keep all (recommended, so agents can talk in and out),
  or pick “customize” to toggle each agent on/off per prompt.
`);
}

async function healthCheck(baseUrl = DEFAULT_BASE) {
  for (let i = 0; i < 10; i++) {
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return await res.json();
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 700));
  }
  return null;
}
async function verifyBus(baseUrl, components, paths) {
  const checks = [];
  // 1) ephemeral register probe
  try {
    const name = `probe-${Date.now().toString(36)}`;
    const reg = await fetch(`${baseUrl}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, team: 'default', role: 'probe', agent_type: 'probe' }), signal: AbortSignal.timeout(2000) });
    if (reg.ok) {
      const { agent_id } = await reg.json();
      const list = await fetch(`${baseUrl}/api/agents?team=default`, { signal: AbortSignal.timeout(1500) }).then((r) => r.json()).catch(() => ({}));
      await fetch(`${baseUrl}/api/deregister`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_id }), signal: AbortSignal.timeout(1500) }).catch(() => {});
      const found = JSON.stringify(list).includes(name);
      checks.push(found ? `bus probe ok (${name})` : 'bus probe: registered but not listed');
      log.ok(checks[checks.length - 1]);
    } else checks.push(`bus probe failed (${reg.status})`);
  } catch (e) { checks.push(`bus probe skipped: ${String(e).slice(0, 80)}`); log.warn(checks[checks.length - 1]); }
  // 2) component files
  if (components.has('pi') && !existsSync(paths.piExtensions + '/xats.ts') && !existsSync(path.join(paths.piExtensions, 'xats.ts'))) log.warn('Pi extension not found at ~/.pi/agent/extensions/xats.ts');
  else if (components.has('pi')) log.ok('Pi extension present');
  if (components.has('claude') && !existsSync(path.join(paths.claudeDir, 'skills', 'xats', 'SKILL.md'))) log.warn('Claude skill not found');
  else if (components.has('claude')) log.ok('Claude skill present');
  if (components.has('opencode') && !existsSync(path.join(path.dirname(paths.opencodePlugins), 'plugins', 'xats-register.ts'))) log.warn('opencode plugin not found');
  else if (components.has('opencode')) log.ok('opencode plugin present');
  return checks;
}

function isInteractiveTTY() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.env.CI);
}
function detectAgentFound(paths) {
  return {
    claude: existsSync(paths.claudeDir),
    pi: existsSync(paths.piDir),
    opencode: existsSync(paths.opencodePlugins) || existsSync(path.dirname(paths.opencodePlugins)),
    mimocode: existsSync(paths.mimocodePlugins),
    daemon: true,
    service: true,
    bridge: true,
  };
}
async function ask(rl, q) {
  return new Promise((res) => rl.question(q, (a) => res(a)));
}
async function promptInstallComponents(defaultSet, paths) {
  const found = detectAgentFound(paths);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('');
    console.log('  Customize install — all agents is recommended so peers can talk in and out.');
    console.log(`  Default: all components (${ALL.join(', ')})`);
    console.log('  Detected: ' + AGENTS.map((a) => `${a} ${found[a] ? 'found' : 'not found'}`).join(', '));
    console.log('');
    const first = (await ask(rl, '  Keep all? [Enter=all / c=customize / n=none / q=quit]: ')).trim().toLowerCase();
    if (first === 'q') { console.log('  aborted.'); process.exit(0); }
    if (first === '' || first === 'y' || first === 'yes' || first === 'all') return defaultSet;
    if (first === 'n' || first === 'none' || first === '0') return new Set();
    if (first !== 'c' && first !== 'custom' && first !== 'customize') {
      console.log('  Tip: type c to pick agents one by one, or run with --only=pi or --no-claude');
      const retry = (await ask(rl, '  Customize now? [y/N]: ')).trim().toLowerCase();
      if (retry !== 'y' && retry !== 'yes' && retry !== 'c') return defaultSet;
    }
    const next = new Set();
    console.log('');
    console.log('  Toggle each component — Enter = keep [Y], n = skip:');
    for (const c of ALL) {
      const tag = AGENTS.includes(c) ? 'agent' : 'infra';
      const f = found[c];
      const hint = AGENTS.includes(c) ? (f ? 'found' : 'not found') : '';
      const ans = (await ask(rl, `    ${c} (${tag}${hint ? ', ' + hint : ''}) [Y/n]: `)).trim().toLowerCase();
      if (ans === '' || ans === 'y' || ans === 'yes') next.add(c);
    }
    if (!next.size) console.log('  (no components selected — nothing to do)');
    else console.log(`  Selected: ${[...next].join(', ')}`);
    return next;
  } finally { rl.close(); }
}
async function promptResetConfirm(components, paths) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const list = [...components].join(', ') || '(none)';
    console.log('');
    console.log(`  Reset will remove xats-owned files/config for: ${list}`);
    const ans = (await ask(rl, '  Continue? [y/N]: ')).trim().toLowerCase();
    return ans === 'y' || ans === 'yes';
  } finally { rl.close(); }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return help();
  setDry(opts.dry);
  if (opts.label) process.env.XATS_LABEL = opts.label;
  // ephemeral log: file always, loader only on TTY and not --verbose/--dry-run
  const logPath = initLogFile();
  const useEphemeral = !opts.verbose && !isDry() && process.stdout.isTTY && !process.env.CI;

  console.log(`\n  xats-setup v${VERSION} — full-peer install ${isDry() ? '(DRY RUN)' : ''}`);
  if (logPath) console.log(`  log ${logPath}`);
  const paths = getPaths();
  const shouldPromptInstall = opts.interactive || (!opts.explicit && !opts.nonInteractive && isInteractiveTTY());
  const shouldPromptReset = opts.interactive || (!opts.explicit && !opts.nonInteractive && isInteractiveTTY());
  if (opts.reset) {
    if (shouldPromptReset) {
      // Let user pick which bits to reset, or confirm full wipe
      const picked = await promptInstallComponents(opts.components, paths);
      // If user customized, honor it; otherwise confirm the full list
      if (picked.size !== opts.components.size || [...picked].some((k) => !opts.components.has(k))) {
        opts.components = picked;
      } else {
        const ok = await promptResetConfirm(opts.components, paths);
        if (!ok) { console.log('  reset aborted.'); return; }
      }
    } else if (!opts.nonInteractive && isInteractiveTTY() && !opts.explicit) {
      const ok = await promptResetConfirm(opts.components, paths);
      if (!ok) { console.log('  reset aborted.'); return; }
    }
    if (useEphemeral) { setEphemeralSteps(opts.components); enableEphemeral(); }
    try { reset(paths, opts.components); } finally { disableEphemeral(); }
    const lf = getLogFile();
    if (lf) console.log(`  log ${lf} — cat for verbose output`);
    return;
  }
  if (shouldPromptInstall) {
    opts.components = await promptInstallComponents(opts.components, paths);
  }
  if (useEphemeral && !opts.reset) { setEphemeralSteps(opts.components); enableEphemeral(); }
  setEphemeralSteps(opts.components);
  ensureDir(paths.xatsRoot);
  // Dynamic port: pick free 9100-9104, persist to ~/.xats/port, use for service + health.
  let port = readPort(paths, DEFAULT_PORT);
  if (opts.components.has('daemon') || opts.components.has('service')) {
    const picked = await pickPort(paths, [9100, 9101, 9102, 9103, 9104]);
    if (picked !== port) log.info(`port :${port} busy or not persisted → using :${picked}`);
    port = picked;
    if (!isDry()) writePort(paths, port);
    else log.dry(`would persist port ${port} to ${paths.xatsRoot}/port`);
  }
  const BASE_URL = `http://127.0.0.1:${port}`;

  // Stable Pi identity: persist XATS_LABEL to ~/.xats/label (+ setx on Windows).
  // Do this before wiring so the extension can read it even if env is unset.
  let labelToPersist = opts.label || process.env.XATS_LABEL || readLabelFile(paths) || null;
  if (opts.components.has('pi')) {
    if (!labelToPersist) {
      // prompts only if TTY, otherwise auto-derives from username/host
      await ensurePiLabel(paths, opts.label);
    } else if (!readLabelFile(paths) && !isDry()) {
      writeLabelFile(paths, labelToPersist);
      if (!process.env.XATS_LABEL) process.env.XATS_LABEL = labelToPersist;
    } else if (!process.env.XATS_LABEL) {
      process.env.XATS_LABEL = labelToPersist;
    }
  }

  // WSL duality: Windows and WSL are separate loopback buses. Surface it early.
  if (paths.home && summary().platform === 'win32') {
    const w = wslInfo();
    if (w?.hasWSL) {
      log.step('WSL check (Windows ↔ WSL are separate buses)');
      if (w.opencode) {
        log.info('WSL has opencode (~/.config/opencode found inside distro).');
        if (opts.components.has('opencode')) log.warn('Windows opencode plugin will be wired but WSL opencode needs its own setup: run  wsl -- npx xats-setup --only=opencode,pi,daemon,service  inside WSL');
        else log.info('Tip: to wire WSL opencode, run  wsl -- npx xats-setup --only=opencode  inside WSL');
      }
      if (w.daemon || w.pi) log.info(`WSL has${w.daemon ? ' daemon' : ''}${w.daemon && w.pi ? ' +' : ''}${w.pi ? ' Pi' : ''} — these are separate from Windows until bridged.`);
      if (!w.filament && opts.components.has('bridge')) log.warn('WSL filament not found — Windows↔WSL bridge will need filament on both sides (cargo install filament).');
      if (w.opencode || w.daemon) log.info('Bridge Windows↔WSL: add the WSL peer to C:\\Users\\...\\.xats\\bridge\\peers.json and the Windows peer to ~/.xats/bridge/peers.json, then `bridge up` on both (needs filament).');
    }
  }

  // Detect a prior install so we can update it in place (idempotent + migrate).
  const { prior, mode } = describeRun(paths, VERSION);

  const pre = preflight();

  let lay = null;
  if (opts.components.has('daemon')) { setStepStatus('daemon','running','installing'); lay = installDaemon(paths, { force: opts.force, betterSqlitePin: pre.betterSqlitePin }); setStepStatus('daemon','done','done'); }
  else { const { daemonLayout } = await import('./lib/daemon.mjs'); lay = daemonLayout(paths); setStepStatus('daemon','skip','skipped'); }

  if (opts.components.has('service')) { setStepStatus('service','running','registering'); installService(lay, { port }); setStepStatus('service','done','done'); } else setStepStatus('service','skip','skipped');
  // On an UPGRADE where the daemon build actually changed, the old daemon is
  // still running the old code — restart it so the update takes effect. (Fresh
  // installs already started the new build in the service step.)
  if (opts.components.has('daemon') && lay && lay.updated && mode !== 'fresh')
    restartDaemon(paths, lay.entry, port);

  if (opts.components.has('claude')) { setStepStatus('claude','running','wiring'); installClaude(paths); setStepStatus('claude','done','done'); } else setStepStatus('claude','skip','skipped');
  if (opts.components.has('pi')) { setStepStatus('pi','running','wiring'); installPi(paths); setStepStatus('pi','done','done'); } else setStepStatus('pi','skip','skipped');
  if (opts.components.has('opencode')) { setStepStatus('opencode','running','wiring'); installOpencode(paths); setStepStatus('opencode','done','done'); } else setStepStatus('opencode','skip','skipped');
  if (opts.components.has('mimocode')) { setStepStatus('mimocode','running','wiring'); installMimocode(paths); setStepStatus('mimocode','done','done'); } else setStepStatus('mimocode','skip','skipped');
  if (opts.components.has('harness')) { installHarnesses(paths); }
  if (opts.components.has('bridge')) {
    setStepStatus('bridge','running','installing');
    const br = installBridge(paths);
    // Auto-bridge Windows ↔ WSL: if WSL has a daemon and we have bridge+filament, seed peers.json for both sides
    try {
      const w2 = wslInfo();
      if (w2?.hasWSL && w2.daemon) {
        const peersPath = br?.peers || path.join(paths.xatsRoot, 'bridge', 'peers.json');
        const wslHost = w2.hostname || 'wsl';
        // Windows side
        if (existsSync(peersPath)) {
          try {
            const cur = JSON.parse(readFileSync(peersPath, 'utf8') || '{"peers":[]}');
            const has = (cur.peers||[]).some((p)=> (p.name===wslHost || p.bridge_host===`${wslHost}.mesh`));
            if (!has) {
              cur.peers = [...(cur.peers||[]), { name: wslHost, bridge_host: `${wslHost}.mesh`, bridge_port: 9101 }];
              if (!isDry()) {
                const fs2 = await import('node:fs');
                fs2.default.writeFileSync(peersPath, JSON.stringify(cur, null, 2)+'\n');
                log.ok(`bridge: auto-added WSL peer ${wslHost}.mesh to peers.json`);
              } else log.dry(`would add WSL peer ${wslHost} to ${peersPath}`);
            }
          } catch {}
        }
        // WSL side (best-effort via wsl.exe)
        const wslPeersPath = '~/.xats/bridge/peers.json';
        const winHost = summary().host;
        const wslCmd = `mkdir -p ~/.xats/bridge && if [ -f ~/.xats/bridge/peers.json ]; then cat ~/.xats/bridge/peers.json; else echo '{"peers":[]}'; fi`;
        const { which, run } = await import('./lib/platform.mjs');
        const wslBin = which('wsl.exe') || which('wsl');
        if (wslBin && !isDry()) {
          const existingRaw = run(wslBin, ['-e','sh','-lc', wslCmd], { timeout: 3000 }).stdout || '{"peers":[]}';
          try {
            const wcur = JSON.parse(existingRaw);
            const hasWin = (wcur.peers||[]).some((p)=> p.name===winHost);
            if (!hasWin) {
              wcur.peers = [...(wcur.peers||[]), { name: winHost, bridge_host: `${winHost}.mesh`, bridge_port: 9101 }];
              const tmp = JSON.stringify(wcur);
              run(wslBin, ['-e','sh','-lc', `cat > ${wslPeersPath} <<'EOS'\n${tmp}\nEOS`], { timeout: 3000 });
              log.ok(`bridge: auto-added Windows peer ${winHost} to WSL peers.json`);
            }
          } catch {}
        }
      }
    } catch {}
    setStepStatus('bridge','done','done');
  } else setStepStatus('bridge','skip','skipped');

  // Verify
  setStepStatus('verify','running','checking');
  log.step('Verify');
  if (isDry()) { log.dry(`would health-check ${BASE_URL}/health`); setStepStatus('verify','skip','dry-run'); }
  else if (opts.components.has('daemon') || opts.components.has('service')) {
    const h = await healthCheck(BASE_URL);
    if (h && h.ok) {
      log.ok(`daemon healthy — v${h.version || '?'}, uptime ${Math.round(h.uptime_seconds || 0)}s on :${port}`);
      await verifyBus(BASE_URL, opts.components, paths);
      setStepStatus('verify','done','ok');
    } else { log.warn(`daemon not answering on ${BASE_URL}/health yet — check the service, then: curl ${BASE_URL}/health (Windows Firewall may need allow)`); setStepStatus('verify','error','unreachable'); }
  } else if (!isDry()) {
    // Even without daemon, verify component files are present
    await verifyBus(BASE_URL, opts.components, paths);
    setStepStatus('verify','done','ok');
  }

  // Record what we installed so a future run can detect + update this box.
  if (!isDry()) {
    writeManifest(paths, {
      version: VERSION,
      updatedAt: new Date().toISOString(),
      platform: process.platform,
      components: [...opts.components],
      daemonEntry: lay ? lay.entry : null,
      port,
      label: readLabelFile(paths),
    });
  }

  disableEphemeral();
  const s = summary();
  log.step('Done');
  console.log(`  Box:    ${s.host} (${s.platform}/${s.arch}, node ${s.node})`);
  console.log(`  Mode:   ${mode}${prior ? ` (was v${prior.version})` : ''} -> v${VERSION}`);
  console.log(`  Daemon: ${lay ? lay.entry : 'n/a'}`);
  console.log(`  Bus:    ${BASE_URL}`);
  console.log(`  Next:   restart Claude Code / Pi (/reload) / opencode so they register on the bus.`);
  if (opts.components.has('bridge'))
    console.log(`  Bridge: add a peer to ~/.xats/bridge/peers.json, then \`node ~/.xats/bridge/bridge.mjs up\` (coordinate with the remote).`);
  const lf2 = getLogFile();
  if (lf2) console.log(`  Log:    ${lf2} — cat for verbose output`);
  console.log('');
}

main().catch((e) => { try { disableEphemeral(); } catch {} log.err(e.message || String(e)); const lf = getLogFile(); if (lf) console.log(`  log ${lf}`); process.exit(1); });

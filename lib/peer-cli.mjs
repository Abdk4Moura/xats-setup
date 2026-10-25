import fs from 'node:fs';
import path from 'node:path';
import { loadPeerConfig, setPeerConfigValue, PEER_POLICIES } from './peer-config.mjs';
import { startPeerRuntime, callPeerControl, pairUsingInvite } from './peer-runtime.mjs';
import { purgePeerShadows } from './peer-federation.mjs';

function parseArgs(args) {
  const result = { positional: [], options: {} };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 2) result.options[arg.slice(2, eq)] = arg.slice(eq + 1);
      else {
        const name = arg.slice(2);
        const next = args[i + 1];
        if (next && !next.startsWith('--')) { result.options[name] = next; i++; }
        else result.options[name] = true;
      }
    } else result.positional.push(arg);
  }
  return result;
}

function formatCandidates(candidates = []) {
  if (!candidates.length) return 'No xats peers discovered on multicast-enabled networks.';
  return candidates.map((candidate) => `- ${candidate.deviceId} at ${candidate.endpoint.host}:${candidate.endpoint.port} (untrusted candidate)`).join('\n');
}

async function control(stateDir, endpoint, method = 'GET', body = null) {
  return callPeerControl({ stateDir, endpoint, method, body });
}

async function readInviteInput(source) {
  if (!source || source === '-') {
    if (process.stdin.isTTY) throw new Error('Provide an invite file path or pipe the invite code on stdin.');
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  return fs.readFileSync(path.resolve(source), 'utf8').trim();
}

function writeInvite(code, outputPath) {
  if (!outputPath) {
    process.stdout.write(`${code}\n`);
    return;
  }
  const dest = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(dest, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, `${code}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  console.log(`Invite saved to ${dest} (keep private; expires shortly).`);
}

export async function mainPeer(args = process.argv.slice(2), { stateDir } = {}) {
  if (!stateDir) throw new Error('peer_state_dir_required');
  const command = args[0] || 'help';
  const parsed = parseArgs(args.slice(1));
  const positional = parsed.positional;
  const options = parsed.options;

  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(`xats peer — secure Stage 1 xats networking

Commands:
  run                               Start peer HTTPS + mDNS in foreground
  status                            Show listener, candidates, and paired peers
  candidates                        List untrusted mDNS candidates
  invite --endpoint URL [--out F]   Create a short-lived routed-peer invite
  pair --invite-file FILE           Accept an invite (use '-' for stdin)
  pair DEVICE_ID                    Request pairing with a discovered LAN candidate
  pending                           List incoming requests awaiting approval
  approve PENDING_ID [--label NAME] Approve and trust a candidate
  deny PENDING_ID                   Reject and burn its invite
  peers                             List paired peers
  revoke DEVICE_ID                  Revoke a paired peer immediately
  stop                              Stop the foreground peer service

The peer service starts only when explicitly run. The local daemon remains loopback-only.

Service lifecycle (through xats-setup):
  xats-setup peer enable    opt in to a user service at login
  xats-setup peer start|stop|restart
  xats-setup peer disable   stop and remove the autostart service`);
    return;
  }

  if (command === 'run') {
    const port = options.port ? Number(options.port) : null;
    const runtime = await startPeerRuntime({
      stateDir,
      host: options.bind || '::',
      port,
      mdns: options['no-mdns'] !== true,
    });
    console.log(`xats peer service running: ${runtime.identity.deviceId} on :${runtime.peerPort}; local control :${runtime.controlPort}`);
    const close = async () => {
      await runtime.close();
      process.exit(0);
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    return new Promise(() => {});
  }

  if (command === 'stop') {
    let result;
    try { result = await control(stateDir, '/exit', 'POST', {}); }
    catch (error) {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') {
        console.log('Peer service is not running.');
        return;
      }
      throw error;
    }
    if (!result.ok) throw new Error('peer_service_stop_failed');
    console.log('Peer service stopping.');
    return;
  }

  if (command === 'clean-shadows') {
    let daemonPort = 9100;
    try {
      const saved = Number(fs.readFileSync(path.join(path.dirname(stateDir), 'port'), 'utf8').trim());
      if (Number.isInteger(saved) && saved > 0 && saved <= 65535) daemonPort = saved;
    } catch { /* default daemon port */ }
    const removed = await purgePeerShadows({ daemonPort });
    console.log(`Removed ${removed} xats peer shadow agents from the local bus.`);
    return;
  }

  if (command === 'status') {
    let result;
    try { result = await control(stateDir, '/status'); }
    catch (error) {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') {
        const configured = fs.existsSync(path.join(stateDir, 'service.json'));
        console.log(`Peer service is not running${configured ? ' (autostart is configured)' : ''}. Start it with "xats-setup peer start" or "xats-setup peer run".`);
        return;
      }
      throw error;
    }
    console.log(`Device: ${result.deviceId}\nPeer listener: [::]:${result.peerPort}\nmDNS: ${result.mdns ? 'active' : 'unavailable'}\nLocal daemon: ${result.federation?.daemonAvailable ? 'available' : 'unavailable'}\nPaired peers: ${result.peers.length}\nPending approvals: ${result.pending.length}`);
    const connectionStates = result.federation?.peers || [];
    for (const peer of result.peers) {
      const state = connectionStates.find((item) => item.deviceId === peer.deviceId);
      const connection = state?.connected ? 'connected' : state ? 'unavailable' : 'not checked yet';
      console.log(`- ${peer.label || peer.deviceId}: ${connection}${state ? `; agents=${state.remoteAgentCount || 0}` : ''}${state?.lastError ? `; ${state.lastError}` : ''}`);
    }
    if (result.endpoints.length) console.log(`Endpoints:\n${result.endpoints.map((endpoint) => `- ${endpoint.interface}: ${endpoint.url}`).join('\n')}`);
    console.log(formatCandidates(result.candidates));
    return;
  }

  if (command === 'config') {
    const [key, value] = positional;
    if (!key) {
      const cfg = loadPeerConfig(stateDir);
      console.log(JSON.stringify(cfg, null, 2));
      console.log(`\nSaved policy values: ${PEER_POLICIES.join(' | ')} (default manual)`);
      console.log('Current runtime always requires manual peer approval; shared/open are not enforced yet.');
      console.log('Set with: xats peer config <policy|overlay|overlayPeers|port> <value>');
      return;
    }
    if (!value) throw new Error('usage: xats peer config <key> <value>');
    const next = setPeerConfigValue(stateDir, key, value);
    console.log(`saved: autoApprove=${next.autoApprove} overlay=${next.overlay}${next.overlayPeers.length ? ` peers=${next.overlayPeers.join(',')}` : ''}`);
    if (next.autoApprove !== 'manual') console.log('warning: the current runtime still requires manual approval; shared/open are saved but not enforced.');
    console.log('restart the peer runtime for overlay changes: xats peer stop && xats-setup peer start');
    return;
  }

  if (command === 'candidates') {
    const result = await control(stateDir, '/candidates');
    console.log(formatCandidates(result.candidates));
    return;
  }

  if (command === 'pending') {
    const result = await control(stateDir, '/pending');
    if (!result.pending.length) console.log('No pending pairing requests.');
    else for (const item of result.pending) console.log(`${item.pendingId}  ${item.deviceId}  ${item.mode}  received ${new Date(item.receivedAt).toLocaleString()}`);
    return;
  }

  if (command === 'peers') {
    const result = await control(stateDir, '/peers');
    if (!result.peers.length) console.log('No paired peers.');
    else {
      const status = await control(stateDir, '/status');
      for (const peer of result.peers) {
        const state = status.federation?.peers?.find((item) => item.deviceId === peer.deviceId);
        console.log(`${peer.deviceId}  ${peer.label || '(unlabeled)'}  ${state?.connected ? 'connected' : state ? 'unavailable' : 'not checked yet'}  ${peer.endpoint}`);
      }
    }
    return;
  }

  if (command === 'approve') {
    if (!positional[0]) throw new Error('usage: xats peer approve <pending-id> [--label name]');
    const result = await control(stateDir, '/approve', 'POST', { pendingId: positional[0], label: options.label || null });
    console.log(`Paired ${result.peer.deviceId}${result.peer.label ? ` as ${result.peer.label}` : ''}.`);
    return;
  }

  if (command === 'deny') {
    if (!positional[0]) throw new Error('usage: xats peer deny <pending-id>');
    const result = await control(stateDir, '/deny', 'POST', { pendingId: positional[0] });
    if (!result.ok) throw new Error('pending_pairing_not_found');
    console.log('Pairing denied; invite invalidated.');
    return;
  }

  if (command === 'revoke') {
    if (!positional[0]) throw new Error('usage: xats peer revoke <device-id>');
    const result = await control(stateDir, '/revoke', 'POST', { deviceId: positional[0] });
    if (!result.ok) throw new Error('peer_not_found');
    console.log(`Revoked ${positional[0]}.`);
    return;
  }

  if (command === 'invite') {
    const status = await control(stateDir, '/status');
    const endpoint = options.endpoint || (status.endpoints.length === 1 ? status.endpoints[0].url : null);
    if (!endpoint) {
      const choices = status.endpoints.map((item) => `- ${item.interface}: ${item.url}`).join('\n');
      throw new Error(`Choose the endpoint reachable by the other machine with --endpoint URL. Available:\n${choices || '(no non-loopback address found)'}`);
    }
    const result = await control(stateDir, '/invite', 'POST', { endpoint, ttlMs: options.ttl ? Number(options.ttl) * 1000 : undefined });
    writeInvite(result.code, options.out || null);
    return;
  }

  if (command === 'pair') {
    if (options['invite-file'] || positional[0] === '-') {
      const code = await readInviteInput(options['invite-file'] || positional[0]);
      const result = await pairUsingInvite({ stateDir, code, endpoint: options.endpoint || null, label: options.label || null });
      console.log(`Paired with ${result.deviceId} at ${result.endpoint}.`);
      return;
    }
    const deviceId = positional[0];
    if (!deviceId) throw new Error('usage: xats peer pair <device-id> or --invite-file FILE');
    const status = await control(stateDir, '/status');
    const endpoint = options.endpoint || (status.endpoints.length === 1 ? status.endpoints[0].url : null);
    if (!endpoint) throw new Error('Choose a local endpoint with --endpoint URL for this peer.');
    const result = await control(stateDir, '/pair', 'POST', { deviceId, endpoint, label: options.label || null });
    console.log(`Paired with ${result.deviceId} at ${result.endpoint}.`);
    return;
  }

  throw new Error(`unknown_peer_command: ${command} (run "xats peer help")`);
}

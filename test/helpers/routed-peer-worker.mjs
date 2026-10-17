import readline from 'node:readline';
import { startPeerRuntime } from '../../lib/peer-runtime.mjs';

const [stateDir, daemonPortText, host] = process.argv.slice(2);
if (!stateDir || !daemonPortText || !host) throw new Error('worker_arguments_required');
const daemonPort = Number(daemonPortText);
if (!Number.isInteger(daemonPort) || daemonPort < 1 || daemonPort > 65535) throw new Error('invalid_daemon_port');

const runtime = await startPeerRuntime({
  stateDir,
  host,
  port: 0,
  mdns: false,
  federationEnabled: true,
  daemonPort,
  onLog() {},
});
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let stopping = false;
async function close() {
  if (stopping) return;
  stopping = true;
  await runtime.close();
}
process.once('SIGTERM', () => { close().finally(() => process.exit(0)); });
process.once('SIGINT', () => { close().finally(() => process.exit(0)); });
emit({ type: 'ready', deviceId: runtime.identity.deviceId, peerPort: runtime.peerPort });

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  let request;
  try { request = JSON.parse(line); }
  catch { emit({ id: null, ok: false, error: 'invalid_json' }); continue; }
  try {
    let result;
    if (request.op === 'sync') {
      await runtime.federation.syncOnce();
      result = runtime.status().federation;
    } else if (request.op === 'status') {
      result = runtime.status();
    } else if (request.op === 'api') {
      const response = await fetch(`http://127.0.0.1:${daemonPort}${request.path}`, {
        method: request.method || 'GET',
        headers: request.body ? { 'content-type': 'application/json' } : undefined,
        body: request.body ? JSON.stringify(request.body) : undefined,
        signal: AbortSignal.timeout(5000),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `daemon_http_${response.status}`);
      result = data;
    } else if (request.op === 'stop') {
      await close();
      emit({ id: request.id, ok: true });
      break;
    } else {
      throw new Error('unknown_worker_operation');
    }
    emit({ id: request.id, ok: true, result });
  } catch (error) {
    emit({ id: request.id, ok: false, error: error?.message || String(error) });
  }
}
await close();

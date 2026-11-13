// Regression: an opencode plugin must not block the host's first paint.
//
// A user reported a blank TUI after installing xats. The plugin awaited
// registration against the local daemon during init, and opencode waits for
// every plugin's init before it renders anything. With no daemon listening,
// the editor sat on an alt-screen painting nothing.
//
// This test loads the real plugin source with a fake host module and no daemon,
// then asserts that init returns immediately instead of waiting on the network.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pluginSource = path.join(repo, 'assets', 'plugins', 'xats-register.ts');

// A daemon that accepts the socket but never answers. This is the case a user
// actually hit: registration hung, so the editor opened an alt-screen and
// painted nothing.
async function hungServer() {
  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    // never reply
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    port,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}

test('plugin init returns without waiting for the daemon', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xats-plugin-init-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // Fake host module. tool() records the definition; tool.schema is chainable.
  const hostDir = path.join(root, 'node_modules', '@opencode-ai', 'plugin');
  fs.mkdirSync(hostDir, { recursive: true });
  fs.writeFileSync(path.join(hostDir, 'package.json'), JSON.stringify({ name: '@opencode-ai/plugin', type: 'module', main: 'index.mjs' }));
  fs.writeFileSync(path.join(hostDir, 'index.mjs'), [
    'const schema = new Proxy({}, { get: () => () => schema });',
    'export const tool = (def) => def;',
    'tool.schema = schema;',
  ].join('\n'));

  const built = path.join(root, 'plugin.mjs');
  const out = await esbuild.build({
    entryPoints: [pluginSource],
    bundle: true,
    format: 'esm',
    platform: 'node',
    external: ['@opencode-ai/plugin', 'bun:sqlite'],
    write: false,
    logLevel: 'silent',
  });
  fs.writeFileSync(built, out.outputFiles[0].text);

  const hung = await hungServer();
  t.after(() => hung.close());
  process.env.XATS_BASE_URL = `http://127.0.0.1:${hung.port}`;
  process.env.XATS_PORT = String(hung.port);
  process.env.XATS_AGENT_KIND = 'opencode';
  // Keep the background retries short so the test does not linger.
  process.env.XATS_REGISTER_TIMEOUT_MS = '3000';
  process.env.XATS_BOOT_ATTEMPTS = '1';

  const client = {
    session: {
      list: async () => ({ data: [] }),
      promptAsync: async () => ({}),
    },
  };

  const mod = await import(pathToFileURL(built).href);
  const plugin = mod.default;

  const started = Date.now();
  // The old code awaited registration here, so it never resolved while the
  // daemon hung. Racing against a short deadline is what makes this a test.
  const hooks = await Promise.race([
    plugin({ client, directory: root, worktree: root }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('plugin init blocked on the daemon')), 1500)),
  ]);
  const elapsed = Date.now() - started;

  assert.ok(hooks && typeof hooks === 'object', 'plugin returns its hooks object');
  assert.ok(hooks.tool && hooks.tool.xats_send, 'tools are available immediately');
  assert.ok(hooks.tool.xats_whoami, 'identity tool is available immediately');
  assert.ok(
    elapsed < 1500,
    `init should not wait for the daemon, took ${elapsed}ms`,
  );

  // Give boot a moment to fail against the hung port; it must not throw.
  await new Promise((r) => setTimeout(r, 300));
});

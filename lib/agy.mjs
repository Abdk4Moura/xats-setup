// agy.mjs — install the native Google Antigravity plugin bundle.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { log, isDry } from './log.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = path.join(__dir, '..', 'assets', 'agy');

export function installAgy(paths, { port = 9100 } = {}) {
  const dest = paths.agyPlugin;
  log.step('agy: Antigravity plugin + MCP tools + skill');
  if (isDry()) {
    log.dry(`copy Antigravity plugin ${ASSET_DIR} -> ${dest}`);
    log.dry(`set xats MCP port to ${port}`);
    return dest;
  }

  // This directory is owned by xats-setup. Replace it as a unit so upgrades
  // cannot leave stale plugin assets behind.
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(ASSET_DIR, dest, { recursive: true });

  const configPath = path.join(dest, 'mcp_config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.mcpServers.bus.env.XATS_PORT = String(port);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  log.ok(`agy: plugin installed at ${dest}`);
  log.info('Restart Antigravity to load the plugin; use /mcp in the CLI to inspect the connection.');
  return dest;
}

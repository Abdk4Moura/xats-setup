// Install the native Google Antigravity plugin without erasing local additions.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { log, isDry, readConfigJson, writeConfigJson, copyConfigTree, isConfigObject, configError } from './log.mjs';
import { nodeBin, readLabelFile, IS_WIN } from './platform.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = path.join(__dir, '..', 'assets', 'agy');
const BRIDGE_DIR = path.join(__dir, '..', 'mcp-stdio', 'src');

// One durable Antigravity identity per box. agy exposes no session id to a
// plugin, so a per-session suffix could not be stable; a pinned name is.
export function agyIdentityName(paths) {
  const clean = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  const host = clean(os.hostname().split('.')[0]) || 'host';
  const label = clean(process.env.XATS_LABEL) || clean(readLabelFile(paths)) || clean(os.userInfo().username) || 'antigravity';
  return `agy-${host}-${label}`;
}

/** Local stdio bridge with pinned identity, so agy does not depend on npx or
 *  on the model inventing a stable name each session. */
function installBridge(paths) {
  const dir = path.join(paths.xatsRoot, 'mcp');
  const entry = path.join(dir, 'xats-mcp.mjs');
  if (isDry()) {
    log.dry(`write pinned stdio bridge -> ${entry}`);
    return entry;
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(BRIDGE_DIR, 'index.mjs'), entry);
  fs.copyFileSync(path.join(BRIDGE_DIR, 'identity.mjs'), path.join(dir, 'identity.mjs'));
  // Resolve the MCP SDK from the daemon runtime we already installed.
  const deps = path.join(paths.xatsRoot, 'daemon', 'node_modules');
  const link = path.join(dir, 'node_modules');
  if (fs.existsSync(deps) && !fs.existsSync(link)) {
    try { fs.symlinkSync(deps, link, IS_WIN ? 'junction' : 'dir'); }
    catch (error) { log.warn(`agy: could not link the bridge to daemon dependencies (${error.code || error.message})`); }
  }
  return entry;
}

export function preflightAgyConfig(paths) {
  const file = path.join(paths.agyPlugin, 'mcp_config.json');
  const config = readConfigJson(file, {});
  if ('mcpServers' in config && !isConfigObject(config.mcpServers)) throw configError(file, 'invalid mcpServers structure');
  const bus = config.mcpServers?.bus;
  if (bus !== undefined && !isConfigObject(bus)) throw configError(file, 'invalid bus server structure');
  if (bus && 'env' in bus && !isConfigObject(bus.env)) throw configError(file, 'invalid bus environment structure');
  return config;
}

export function installAgy(paths, { port = 9100 } = {}) {
  const dest = paths.agyPlugin;
  log.step('agy: Antigravity plugin + MCP tools + skill');
  const current = preflightAgyConfig(paths);
  const templateFile = path.join(ASSET_DIR, 'mcp_config.json');
  const template = JSON.parse(fs.readFileSync(templateFile, 'utf8'));
  const entry = installBridge(paths);
  const pinned = agyIdentityName(paths);
  const config = {
    ...template, ...current,
    mcpServers: {
      ...template.mcpServers, ...current.mcpServers,
      bus: {
        ...current.mcpServers?.bus, ...template.mcpServers.bus,
        command: nodeBin(),
        args: [entry],
        env: { ...current.mcpServers?.bus?.env, ...template.mcpServers.bus.env,
          XATS_PORT: String(port), XATS_NAME: pinned },
      },
    },
  };
  if (isDry()) {
    log.dry(`update Antigravity plugin ${ASSET_DIR} -> ${dest}, preserving local additions`);
    log.dry(`set xats MCP port to ${port} with pinned identity ${pinned}`);
    return dest;
  }
  // Render the desired port before writing; copying the default config first
  // would create two unnecessary backups on every nondefault-port rerun.
  copyConfigTree(ASSET_DIR, dest, { skip: new Set([templateFile]) });
  writeConfigJson(path.join(dest, 'mcp_config.json'), config);
  log.ok(`agy: plugin installed at ${dest}`);
  log.info(`agy: pinned identity ${pinned} (same agent_id every session)`);
  log.info('Restart Antigravity to load the plugin; use /mcp in the CLI to inspect the connection.');
  return dest;
}

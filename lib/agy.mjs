// Install the native Google Antigravity plugin without erasing local additions.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { log, isDry, readConfigJson, writeConfigJson, copyConfigTree, isConfigObject, configError } from './log.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = path.join(__dir, '..', 'assets', 'agy');

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
  const config = {
    ...template, ...current,
    mcpServers: {
      ...template.mcpServers, ...current.mcpServers,
      bus: {
        ...current.mcpServers?.bus, ...template.mcpServers.bus,
        env: { ...current.mcpServers?.bus?.env, ...template.mcpServers.bus.env, XATS_PORT: String(port) },
      },
    },
  };
  if (isDry()) {
    log.dry(`update Antigravity plugin ${ASSET_DIR} -> ${dest}, preserving local additions`);
    log.dry(`set xats MCP port to ${port}`);
    return dest;
  }
  // Render the desired port before writing; copying the default config first
  // would create two unnecessary backups on every nondefault-port rerun.
  copyConfigTree(ASSET_DIR, dest, { skip: new Set([templateFile]) });
  writeConfigJson(path.join(dest, 'mcp_config.json'), config);
  log.ok(`agy: plugin installed at ${dest}`);
  log.info('Restart Antigravity to load the plugin; use /mcp in the CLI to inspect the connection.');
  return dest;
}

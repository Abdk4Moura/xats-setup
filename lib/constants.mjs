// constants.mjs — single source of tunable knobs.
export const DAEMON_PKG = 'cross-agent-teams-mcp';
// Pin the stock base whose native node_modules (better-sqlite3 prebuilds) we
// install, then overlay with the patched cli.js. Matches do-vm's base.
// (Finalized against the cross-OS prebuild audit.)
export const DAEMON_PIN = '0.7.4';
export const PORT = 9100;
export const BASE_URL = `http://127.0.0.1:${PORT}`;
export const TEAM = 'default';
export const SERVICE_NAME = 'xats-daemon';

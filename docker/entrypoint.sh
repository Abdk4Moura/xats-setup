#!/bin/sh
set -eu

port="${XATS_PORT:-9100}"
export XATS_MCP_URL="${XATS_MCP_URL:-http://127.0.0.1:${port}/mcp}"
daemon_cli=/usr/local/lib/node_modules/xats-setup/daemon/dist/cli.js
bridge_cli=/usr/local/lib/node_modules/xats-mcp/src/index.mjs

node "$daemon_cli" daemon \
  --port "$port" \
  --device glama \
  --db /tmp/xats-glama.db \
  --pid-file /tmp/xats-daemon.pid \
  --no-loopback-companion \
  >/tmp/xats-daemon.log 2>&1 &
daemon_pid=$!

cleanup() {
  kill "$daemon_pid" 2>/dev/null || true
  wait "$daemon_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Poll without curl/wget so the runtime image stays self-contained.
if ! node --input-type=module - "$port" <<'NODE'
const port = process.argv[2]
for (let i = 0; i < 100; i++) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(500),
    })
    if (response.ok) process.exit(0)
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 100))
}
process.exit(1)
NODE
then
  echo "xats-container: daemon failed health check on port $port" >&2
  cat /tmp/xats-daemon.log >&2 || true
  exit 1
fi

# Bridge stdout is the MCP stdio transport.
node "$bridge_cli"

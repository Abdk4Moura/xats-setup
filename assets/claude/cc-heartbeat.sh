#!/usr/bin/env bash
# Optional liveness helper for a manually adopted Claude Code identity on Unix.
# Usage: cc-heartbeat.sh <name> <team> <claude-pid> <agent-id>
# Normal session identities are kept alive by the Claude xats mod. This helper
# does not silently re-register after a reap: the MCP client would still hold
# the old agent id, so the agent must explicitly re-register in that session.
set -u
if [ "$#" -ne 4 ] || [ -z "$1" ] || [ -z "$2" ]; then
  echo 'usage: cc-heartbeat.sh <name> <team> <claude-pid> <agent-id>' >&2
  exit 2
fi
case "$3" in ''|*[!0-9]*) echo 'invalid Claude PID' >&2; exit 2;; esac
case "$4" in ''|*[!a-fA-F0-9-]*) echo 'invalid agent ID' >&2; exit 2;; esac
command -v curl >/dev/null || { echo 'curl required' >&2; exit 2; }
pid=$3
agent_id=$4
started=$(ps -o lstart= -p "$pid" 2>/dev/null | xargs)
[ -n "$started" ] || { echo "Claude PID $pid not running" >&2; exit 2; }
if [ -n "${XATS_BASE:-}" ]; then
  base=${XATS_BASE%/}
else
  port=$(cat "${HOME}/.xats/port" 2>/dev/null || echo 9100)
  case "$port" in ''|*[!0-9]*) port=9100;; esac
  base="http://127.0.0.1:${port}"
fi
body="{\"agent_id\":\"${agent_id}\"}"
while [ "$(ps -o lstart= -p "$pid" 2>/dev/null | xargs)" = "$started" ]; do
  code=$(curl -sS -m 5 -o /dev/null -w '%{http_code}' -X POST \
    -H 'Content-Type: application/json' -d "$body" \
    "$base/api/heartbeat" 2>/dev/null || true)
  if [ "$code" = 404 ]; then
    echo "xats agent $1 ($agent_id) was reaped; call register_agent in this Claude session" >&2
    exit 1
  fi
  sleep 30
done
# Only deregister on confirmed process exit/replacement; transient bus failure
# is harmless and will be retried on the next heartbeat instead.
curl -fsS -m 5 -o /dev/null -X POST -H 'Content-Type: application/json' \
  -d "$body" "$base/api/deregister" 2>/dev/null || true

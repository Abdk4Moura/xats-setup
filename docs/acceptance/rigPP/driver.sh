#!/usr/bin/env bash
set -uo pipefail
K=/root/.cache/xats-tasks/rigPP; REPO=/root/Projects/xats-setup
CLAUDE_BIN=/root/.cache/xats-host-tools/claude-2.1.295/node_modules/.bin/claude
HOLD=/root/.cache/xats-tasks/hold-wait.mjs
GUARD=/root/.cache/xats-tasks/rig-guard.mjs
TOKEN_FILE="${CLAUDE_TOKEN_FILE:?set CLAUDE_TOKEN_FILE to your host OAuth token file}"
rm -rf "$K"; mkdir -p "$K/project" "$K/state"; rm -f /root/.xats/tick.log
PORT=$(python3 -c "import socket;s=socket.socket();s.bind(('127.0.0.1',0));print(s.getsockname()[1]);s.close()")
BASE="http://127.0.0.1:$PORT"; DB="$K/state/data.db"
say(){ echo "[$(date -u +%H:%M:%S)] $*"; }
q(){ python3 - "$DB" "$@" <<'PY'
import sqlite3,sys
c=sqlite3.connect(f"file:{sys.argv[1]}?mode=ro",uri=True,timeout=3)
print(c.execute(sys.argv[2],tuple(sys.argv[3:])).fetchall())
PY
}
CU(){ q "select last_processed_event_id from agents where agent_type='claude-code'" | python3 -c "import sys,ast;r=ast.literal_eval(sys.stdin.read());print(r[0][0] if r else None)"; }
start(){ cd "$REPO" && CROSS_AGENT_TEAMS_MCP_HOME="$K/state" XATS_LOCAL_DELIVERY=1 setsid nohup node daemon/dist/cli.js daemon --port "$PORT" --host 127.0.0.1 --db "$DB" --pid-file "$K/state/daemon.pid" --no-loopback-companion >> "$K/daemon.log" 2>&1 </dev/null & for _ in $(seq 1 60); do curl -sf --max-time 1 "$BASE/health" >/dev/null && return 0; sleep 0.5; done; return 1; }
tok(){ python3 - "$1" <<'PY'
import glob,json,sys,os
agent=sys.argv[1]; best=None
for f in glob.glob('/root/.xats/sessions/*.delivery.json'):
    try: d=json.load(open(f))
    except Exception: continue
    if d.get('agent_id')==agent and isinstance(d.get('token'),str) and d.get('version')==1:
        if best is None or os.path.getmtime(f)>best[0]: best=(os.path.getmtime(f),d['token'])
print(best[1] if best else '')
PY
}
send(){ curl -s --max-time 5 -X POST "$BASE/api/send" -H 'Content-Type: application/json' -d "$1"; }
start || { say FAIL daemon; exit 1; }
curl -s --max-time 5 -X POST "$BASE/api/register" -H 'Content-Type: application/json' -d '{"name":"pp-sender","team":"default","agent_type":"custom"}' >/dev/null
HOOK="$REPO/assets/claude/xats-hook.mjs"
SET=$(python3 - "$HOOK" "$GUARD" <<'PY'
import json,sys
print(json.dumps({"hooks":{
  "SessionStart":[{"matcher":"","hooks":[{"type":"command","command":f'"/usr/bin/node" "{sys.argv[1]}" start'}]}],
  "UserPromptSubmit":[{"matcher":"","hooks":[{"type":"command","command":f'"/usr/bin/node" "{sys.argv[2]}"'}]}],
}}))
PY
)
tmux kill-session -t rigPP 2>/dev/null
tmux new-session -d -s rigPP -x 220 -y 50 -c "$K/project" "env RIGK=$K CLAUDE_CODE_OAUTH_TOKEN=$(cat "$TOKEN_FILE") XATS_BASE=$BASE XATS_LOCAL_DELIVERY=1 XATS_DEBUG_TICK=1 XATS_LABEL=pp CROSS_AGENT_TEAMS_MCP_HOME=$K/state $CLAUDE_BIN --setting-sources '' --settings '$SET' --plugin-dir $REPO/assets/claude/mod --strict-mcp-config --mcp-config '{\"mcpServers\":{\"cross-agent-teams\":{\"type\":\"http\",\"url\":\"$BASE/mcp\"}}}' --allowedTools 'mcp__cross-agent-teams__*'"
tmux pipe-pane -t rigPP -o "cat >> $K/pane.log"
say "waiting for the real model to bind…"
for i in $(seq 1 90); do L=$(q "select count(*) from local_delivery_leases where revoked_at is null"); [ "$L" != "[(0,)]" ] && break; sleep 1; done
T=$(curl -s --max-time 5 "$BASE/api/agents/all" | python3 -c "import json,sys;r=[a for a in json.load(sys.stdin)['agents'] if a['agent_type']=='claude-code'];print(r[0]['agent_id'] if r else '')")
say "bound=$([ -n "$T" ] && echo yes) lease=$(q "select generation from local_delivery_leases where revoked_at is null") host=$($CLAUDE_BIN --version)"
say "pane0=$(tmux capture-pane -pt rigPP 2>/dev/null | grep -aoE '✦ xats[^\[]*' | tail -1)"

### C4: aged recipient (no model needed)
curl -s --max-time 5 -X POST "$BASE/api/register" -H 'Content-Type: application/json' -d '{"name":"pp-stale","team":"default","agent_type":"custom"}' >/dev/null
ST=$(curl -s --max-time 5 "$BASE/api/agents/all" | python3 -c "import json,sys;r=[a for a in json.load(sys.stdin)['agents'] if a['name']=='pp-stale'];print(r[0]['agent_id'] if r else '')")
python3 - "$DB" "$ST" <<'PY'
import sqlite3,sys,datetime
db=sqlite3.connect(sys.argv[1]); old=(datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(seconds=300)).isoformat()
db.execute("UPDATE agents SET last_seen_at=? WHERE agent_id=?",(old,sys.argv[2])); db.commit()
PY
C4=$(send "{\"from\":{\"team\":\"default\",\"name\":\"pp-sender\"},\"to\":{\"agent_id\":\"$ST\"},\"body\":\"PP-C4-reply-payload\"}")
say "C4 queued_unreachable=$(printf %s "$C4" | python3 -c "import json,sys;d=json.load(sys.stdin);print((d.get('queued_unreachable'),d.get('unreachable_seconds')))")"
say "C4 retrievable=$(curl -s --max-time 5 "$BASE/api/inbox?team=default&name=pp-stale&since_event_id=0" | python3 -c "import json,sys;d=json.load(sys.stdin);print([m.get('body') for m in d.get('messages',[])])")"

### C1: real host refusal, then a real implicit inbox read
touch "$K/block-on"
R=$(send "{\"from\":{\"team\":\"default\",\"name\":\"pp-sender\"},\"to\":{\"agent_id\":\"$T\"},\"body\":\"PP-refused\",\"auto_poke\":false}")
RID=$(printf %s "$R" | python3 -c "import json,sys;print(json.load(sys.stdin).get('message_id',''))")
for i in $(seq 1 40); do sleep 1; RS=$(q "select status from local_delivery_outbox where message_id=?" "$RID"); [ "$RS" = "[('refused',)]" ] && break; done
say "C1 after host refusal: $RS facts=$(q "select group_concat(stage) from local_delivery_facts f join local_delivery_attempts a using(attempt_id) where a.message_id=?" "$RID")"
rm -f "$K/block-on"
N=$(send "{\"from\":{\"team\":\"default\",\"name\":\"pp-sender\"},\"to\":{\"agent_id\":\"$T\"},\"body\":\"PP-trigger-read\",\"auto_poke\":false}")
NID=$(printf %s "$N" | python3 -c "import json,sys;print(json.load(sys.stdin).get('message_id',''))")
for i in $(seq 1 45); do sleep 2; NS=$(q "select status from local_delivery_outbox where message_id=?" "$NID"); case "$NS" in *"inbox-consumed"*) break;; esac; done
say "C1 trigger row=$NS"
say "C1 AFTER implicit read: refused-row=$(q "select status from local_delivery_outbox where message_id=?" "$RID") facts=$(q "select group_concat(stage) from local_delivery_facts f join local_delivery_attempts a using(attempt_id) where a.message_id=?" "$RID")"

### C2: auto_poke:false single owner
CUR0=$(CU)
M=$(send "{\"from\":{\"team\":\"default\",\"name\":\"pp-sender\"},\"to\":{\"agent_id\":\"$T\"},\"body\":\"PP-single-owner\",\"auto_poke\":false}")
MID=$(printf %s "$M" | python3 -c "import json,sys;print(json.load(sys.stdin).get('message_id',''))")
BAND=""
for i in $(seq 1 60); do B=$(tmux capture-pane -pt rigPP 2>/dev/null | grep -aoE '✦ xats[^\[]*' | tail -1); case "$B" in *pending*) BAND="$B"; break;; esac; sleep 0.25; done
say "C2 pane-while-pending=${BAND:-none}"
for i in $(seq 1 45); do sleep 2; MS=$(q "select status,generation from local_delivery_outbox where message_id=?" "$MID"); case "$MS" in *"inbox-consumed"*|*"host-queued"*) break;; esac; done
CUR1=$(CU)
say "C2 poked=$(printf %s "$M" | python3 -c "import json,sys;print(json.load(sys.stdin).get('poked'))") row=$MS cursor $CUR0->$CUR1"
say "C2 attempts=$(q "select count(*) from local_delivery_attempts where message_id=?" "$MID") facts=$(q "select group_concat(stage) from local_delivery_facts f join local_delivery_attempts a using(attempt_id) where a.message_id=?" "$MID")"

### C3: pending row claimed but unacked across a daemon restart
TOK=$(tok "$T")
rm -f "$K/h.stop" "$K/h.ack" "$K/h.hints" "$K/h.pid"
setsid nohup node "$HOLD" "$BASE" "$TOK" "$K/h.hints" "$K/h.stop" "$K/h.ack" "$K/h.pid" >/dev/null 2>&1 </dev/null &
for i in $(seq 1 150); do grep -q '"acquired"' "$K/h.hints" 2>/dev/null && break; sleep 0.2; done
say "C3 holder acquired=$(grep -c '\"acquired\"' "$K/h.hints" 2>/dev/null || echo 0)"
P=$(send "{\"from\":{\"team\":\"default\",\"name\":\"pp-sender\"},\"to\":{\"agent_id\":\"$T\"},\"body\":\"PP-pending-across-restart\",\"auto_poke\":false}")
PID_=$(printf %s "$P" | python3 -c "import json,sys;print(json.load(sys.stdin).get('message_id',''))")
for i in $(seq 1 30); do grep -q "$PID_" "$K/h.hints" 2>/dev/null && break; sleep 0.5; done
say "C3 AT KILL: $(q "select status,generation from local_delivery_outbox where message_id=?" "$PID_")"
CUR2=$(CU)
touch "$K/h.stop"; [ -f "$K/h.pid" ] && kill "$(cat "$K/h.pid")" 2>/dev/null
DPID=$(python3 -c "import json;print(json.load(open('$K/state/daemon.pid'))['pid'])"); kill -9 "$DPID" 2>/dev/null
for _ in $(seq 1 40); do ss -tln 2>/dev/null | grep -q ":$PORT " || break; sleep 0.5; done
say "C3 daemon down; row=$(q "select status,generation from local_delivery_outbox where message_id=?" "$PID_")"
start || { say FAIL restart; exit 1; }
say "C3 AFTER RESTART: $(q "select status,generation from local_delivery_outbox where message_id=?" "$PID_") lease=$(q "select generation,revoked_at is null from local_delivery_leases")"
for i in $(seq 1 45); do sleep 2; L3=$(q "select status,generation from local_delivery_outbox where message_id=?" "$PID_"); echo "t+$((i*2))s $L3" >> "$K/timeline"; case "$L3" in *"inbox-consumed"*) break;; esac; done
CUR3=$(CU)
say "C3 TIMELINE:"; cat "$K/timeline"
say "C3 facts=$(q "select group_concat(stage) from local_delivery_facts f join local_delivery_attempts a using(attempt_id) where a.message_id=?" "$PID_")"
say "C3 cursor $CUR2 -> $CUR3"
say "C3 rebinds=$(grep -ac 'lazy rebind' "$K/daemon.log")"
say "C3 pane=$(tmux capture-pane -pt rigPP | grep -aoE '✦ xats[^\[]*' | tail -1)"
say "C3 /mcp in pane=$(tmux capture-pane -pt rigPP | grep -ac '/mcp')"
tmux capture-pane -pt rigPP > "$K/pane-final.txt" 2>/dev/null
cp "$DB" "$K/data-snapshot.db" 2>/dev/null
say "prod roster rig names=$(curl -s --max-time 3 http://127.0.0.1:9100/api/agents/all | python3 -c 'import json,sys;d=json.load(sys.stdin);a=d.get("agents",d);print([x.get("name") for x in a if "pp-" in (x.get("name") or "")])' 2>/dev/null || echo bus-down)"
tmux kill-session -t rigPP 2>/dev/null
DPID2=$(python3 -c "import json;print(json.load(open('$K/state/daemon.pid'))['pid'])" 2>/dev/null || true); [ -n "${DPID2:-}" ] && kill "$DPID2" 2>/dev/null
say done

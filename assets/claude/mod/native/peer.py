#!/usr/bin/env python3
"""Linux native peer adapter for a single, explicitly bound Claude session.

The xats daemon remains the mailbox authority. This process supplies native IPC
endpoints, verifies Linux peer credentials, and journals external dispatch before
writing. It never writes Claude's session registry or changes recipient settings.
Only the owning Claude process can send to these endpoints. Credentials stay in
the inherited environment, never in the journal, tool listing, or stdout.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import signal
import socket
import sqlite3
import stat
import struct
import sys
import time
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
import uuid

MAX_FRAME = 1024 * 1024
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.I)
STAGES = {'transport-written', 'host-queued', 'inbox-consumed', 'held', 'refused', 'expired', 'failed', 'unknown'}
TERMINAL = {'refused', 'expired', 'failed'}


def process_start(pid):
    raw = Path(f'/proc/{pid}/stat').read_bytes()
    return raw.rsplit(b')', 1)[1].split()[19].decode('ascii')


def peer_identity(connection):
    pid, uid, _ = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    return pid, uid, process_start(pid)


def private_directory(path):
    path = Path(path)
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('private_directory_required')
    return path


def atomic_json(path, value):
    temporary = path.with_name(path.name + '.tmp')
    with open(temporary, 'w', encoding='utf8', opener=lambda p, f: os.open(p, f, 0o600)) as stream:
        json.dump(value, stream, separators=(',', ':'))
        stream.write('\n')
    os.replace(temporary, path)


def owner_lock(directory):
    fd = os.open(directory / 'owner.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except Exception:
        os.close(fd)
        raise
    return fd


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('redirect_refused')


class Bus:
    def __init__(self, base):
        parsed = urlsplit(base)
        if (parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost')
                or not parsed.port or parsed.username or parsed.password
                or parsed.path not in ('', '/') or parsed.query or parsed.fragment):
            raise ValueError('loopback_bus_required')
        self.base = base.rstrip('/')
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    def request(self, pathname, body=None):
        encoded = None if body is None else json.dumps(body).encode()
        request = Request(self.base + pathname, data=encoded, headers={'Content-Type': 'application/json'})
        with self.opener.open(request, timeout=4) as response:
            data = response.read(MAX_FRAME + 1)
            if len(data) > MAX_FRAME:
                raise ValueError('bus_response_too_large')
            return json.loads(data)


class Journal:
    def __init__(self, path):
        if path.is_symlink():
            raise ValueError('journal_symlink_refused')
        self.db = sqlite3.connect(path)
        path.chmod(0o600)
        self.db.executescript('''
          CREATE TABLE IF NOT EXISTS outgoing (
            attempt TEXT PRIMARY KEY, message TEXT NOT NULL, generation INTEGER NOT NULL,
            event INTEGER NOT NULL, digest TEXT NOT NULL, state TEXT NOT NULL,
            wire_status TEXT, wire_detail TEXT, admission_source TEXT);
          CREATE TABLE IF NOT EXISTS incoming (
            key TEXT PRIMARY KEY, target TEXT NOT NULL, digest TEXT NOT NULL,
            state TEXT NOT NULL, xats_id TEXT);
        ''')
        # Crash after the intent is durable is ambiguous. Never resend it.
        self.db.execute("UPDATE outgoing SET state='unknown' WHERE state='dispatching'")
        self.db.execute("UPDATE incoming SET state='unknown' WHERE state='dispatching'")
        self.db.commit()

    def prepare_outgoing(self, request):
        aid = request.get('attempt_id')
        if not isinstance(aid, str) or not UUID.fullmatch(aid):
            raise ValueError('invalid_attempt_id')
        if (not UUID.fullmatch(str(request.get('message_id', '')))
                or type(request.get('generation')) is not int or request['generation'] < 1
                or type(request.get('event_id')) is not int or request['event_id'] < 1
                or not isinstance(request.get('text'), str) or not request['text']
                or len(request['text'].encode()) > MAX_FRAME // 2):
            raise ValueError('invalid_native_request')
        digest = hashlib.sha256(json.dumps(request, sort_keys=True).encode()).hexdigest()
        existing = self.db.execute('SELECT digest,state FROM outgoing WHERE attempt=?', (aid,)).fetchone()
        if existing:
            if existing[0] != digest:
                raise ValueError('attempt_reused_with_different_input')
            return existing[1] == 'prepared', existing[1]
        # A replacement lease must not replay a prior refusal, hold, or uncertain
        # write of the same durable mailbox message.
        previous = self.db.execute('SELECT state FROM outgoing WHERE message=? ORDER BY rowid DESC LIMIT 1',
                                   (request['message_id'],)).fetchone()
        fresh = previous is None or previous[0] == 'prepared'
        state = 'prepared' if fresh else previous[0]
        with self.db:
            if previous and previous[0] == 'prepared':
                self.db.execute("UPDATE outgoing SET state='superseded' WHERE message=? AND state='prepared'", (request['message_id'],))
            self.db.execute('INSERT INTO outgoing VALUES(?,?,?,?,?,?,NULL,NULL,NULL)',
                            (aid, request['message_id'], request['generation'], request['event_id'], digest, state))
        return fresh, state

    def begin_write(self, attempt):
        with self.db:
            return self.db.execute("UPDATE outgoing SET state='dispatching' WHERE attempt=? AND state='prepared'",
                                   (attempt,)).rowcount == 1

    def outgoing_fact(self, attempt):
        row = self.db.execute('SELECT generation,event,state,wire_status,wire_detail,admission_source FROM outgoing WHERE attempt=?',
                              (attempt,)).fetchone()
        if not row:
            return None
        return dict(kind='receipt', attempt_id=attempt, generation=row[0], event_id=row[1],
                    stage='unknown' if row[2] == 'superseded' else row[2], wire_status=row[3], wire_detail=row[4],
                    admission_source=row[5])

    def record_outgoing(self, attempt, stage, raw=None, detail=None, admission=None):
        if stage not in STAGES:
            raise ValueError('invalid_stage')
        old = self.outgoing_fact(attempt)
        if not old:
            return None
        if old['stage'] in TERMINAL or old['stage'] == 'inbox-consumed':
            return old
        if old['stage'] == 'host-queued' and stage not in TERMINAL and stage not in ('host-queued', 'inbox-consumed'):
            return old
        with self.db:
            self.db.execute('UPDATE outgoing SET state=?,wire_status=?,wire_detail=?,admission_source=? WHERE attempt=?',
                            (stage, old['wire_status'] if raw is None else raw,
                             old['wire_detail'] if raw is None else detail,
                             admission or old['admission_source'], attempt))
        return self.outgoing_fact(attempt)

    def forward_incoming(self, frame, target, observed, expected, reply_path, route):
        if observed != expected or frame.get('from') != 'uds:' + str(reply_path):
            raise ValueError('unbound_native_sender')
        mid = frame.get('msg_id')
        content = frame.get('message', {}).get('content') if isinstance(frame.get('message'), dict) else None
        if (type(frame.get('msgV')) is not int or frame['msgV'] != 1 or frame.get('type') != 'user'
                or not isinstance(mid, str) or not UUID.fullmatch(mid)
                or not isinstance(content, str) or not content or len(content.encode()) > MAX_FRAME):
            raise ValueError('invalid_native_message')
        key = hashlib.sha256(f'{observed[0]}:{observed[2]}:{mid}'.encode()).hexdigest()
        digest = hashlib.sha256(content.encode()).hexdigest()
        old = self.db.execute('SELECT target,digest,state,xats_id FROM incoming WHERE key=?', (key,)).fetchone()
        if old:
            if old[:2] != (target, digest):
                raise ValueError('native_message_reused')
            return old[2], old[3]
        with self.db:
            self.db.execute("INSERT INTO incoming VALUES(?,?,?,'dispatching',NULL)", (key, target, digest))
        try:
            xid = route(target, content)
            if not isinstance(xid, str) or not UUID.fullmatch(xid):
                raise ValueError('unverified_mailbox_commit')
            state = 'stored'
        except Exception:
            state, xid = 'unknown', None
        with self.db:
            self.db.execute('UPDATE incoming SET state=?,xats_id=? WHERE key=?', (state, xid, key))
        return state, xid


class Bridge:
    def __init__(self, args):
        if sys.platform != 'linux' or not hasattr(socket, 'SO_PEERCRED'):
            raise ValueError('native_peer_platform_unsupported')
        self.root = private_directory(args.state_dir)
        # Kernel lock enforces one native worker per session, including reloads
        # and helper restarts. Another worker never races external dispatch.
        self.lock = owner_lock(self.root)
        self.requests = private_directory(self.root / 'requests')
        self.responses = private_directory(self.root / 'responses')
        self.admissions = private_directory(self.root / 'admissions')
        self.owner_socket = Path(args.socket)
        info = self.owner_socket.lstat()
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
            raise ValueError('native_owner_socket_unverified')
        self.owner_pid = int(self.owner_socket.stem)
        self.owner = self.owner_pid, os.getuid(), process_start(self.owner_pid)
        parent = self.owner_socket.parent.lstat()
        if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.getuid() or parent.st_mode & 0o022:
            raise ValueError('native_socket_directory_unverified')
        # Keep sockets near the already viable native socket, not under a long
        # HOME/state path that can exceed Unix's 108-byte address limit.
        self.sockets = private_directory(self.owner_socket.parent / f'xats-{self.owner_pid}-{os.getpid()}')
        self.agent = args.agent_id
        self.bus = Bus(args.base)
        self.journal = Journal(self.root / 'journal.db')
        self.selector = selectors.DefaultSelector()
        self.endpoints = {}
        self.source = None
        self.running = True
        self.token = os.environ.get('CLAUDE_CODE_MESSAGING_TOKEN', '')

    def emit(self, value):
        print(json.dumps(value, separators=(',', ':')), flush=True)

    def endpoint(self, agent_id):
        if agent_id in self.endpoints:
            return self.endpoints[agent_id][1]
        # One real process, separate endpoints per durable xats mailbox.
        folder = private_directory(self.sockets / hashlib.sha256(agent_id.encode()).hexdigest()[:12])
        path = folder / f'{os.getpid()}.sock'
        if len(os.fsencode(path)) > 103:
            raise ValueError('native_socket_path_too_long')
        listener = socket.socket(socket.AF_UNIX)
        listener.bind(str(path))
        path.chmod(0o600)
        listener.listen(8)
        listener.setblocking(False)
        self.selector.register(listener, selectors.EVENT_READ, agent_id)
        self.endpoints[agent_id] = listener, path
        return path

    def refresh(self):
        agents = self.bus.request('/api/agents/all').get('agents', [])
        self.source = next((a for a in agents if a.get('agent_id') == self.agent), None)
        if not self.source:
            raise ValueError('bound_xats_identity_missing')
        peers = []
        for agent in agents:
            if (agent.get('agent_id') == self.agent or agent.get('agent_type') == 'claude-code'
                    or not agent.get('online')):
                continue
            if len(peers) >= 128:
                break
            aid = agent.get('agent_id')
            if not isinstance(aid, str) or not UUID.fullmatch(aid):
                continue
            path = self.endpoint(aid)
            peers.append(dict(agent_id=aid, name=agent.get('name', aid), ref=agent.get('ref'),
                              agent_type=agent.get('agent_type_name') or agent.get('agent_type', 'custom'),
                              address='uds:' + str(path)))
        self.emit(dict(kind='peers', peers=peers))

    def write_native(self, frame, reply_path):
        info = self.owner_socket.lstat()
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != self.owner[1]:
            raise ValueError('owner_socket_changed')
        frame = dict(frame, msgV=1, msg_id=frame.get('msg_id') or str(uuid.uuid4()), **{'from': 'uds:' + str(reply_path)})
        encoded = (json.dumps(frame, separators=(',', ':')) + '\n').encode()
        if len(encoded) > MAX_FRAME:
            raise ValueError('native_frame_too_large')
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(2)
            connection.connect(str(self.owner_socket))
            if peer_identity(connection) != self.owner:
                raise ValueError('owner_process_changed')
            # Public hook token, inherited from this session, never extracted.
            if self.token:
                connection.sendall((json.dumps({'type': 'auth', 'token': self.token}) + '\n').encode())
            connection.sendall(encoded)
            connection.shutdown(socket.SHUT_WR)

    def response(self, fact):
        atomic_json(self.responses / (fact['attempt_id'] + '.json'), fact)
        self.emit(fact)

    def dispatch(self, request):
        fresh, state = self.journal.prepare_outgoing(request)
        aid = request['attempt_id']
        if not fresh:
            self.response(self.journal.outgoing_fact(aid))
            return
        try:
            cursor = self.bus.request('/api/cursor?agent_id=' + self.agent).get('last_processed_event_id')
        except Exception:
            # Definitely before native I/O. A daemon outage here is retryable,
            # unlike a lost response after writing to the native host.
            fact = dict(self.journal.outgoing_fact(aid), kind='pre-admission', stage='busy')
            atomic_json(self.responses / (aid + '.json'), fact)
            return
        if type(cursor) is int and cursor >= request['event_id']:
            self.response(self.journal.record_outgoing(aid, 'inbox-consumed'))
            return
        source = request.get('source_agent_id')
        if not isinstance(source, str) or not UUID.fullmatch(source):
            self.response(self.journal.record_outgoing(aid, 'failed'))
            return
        try:
            reply_path = self.endpoint(source)
        except Exception:
            self.response(self.journal.record_outgoing(aid, 'failed'))
            return
        if not self.journal.begin_write(aid):
            self.response(self.journal.outgoing_fact(aid))
            return
        try:
            frame = dict(type='user', msg_id=aid, uuid=str(uuid.uuid4()), from_plugin='xats',
                         priority='next', message=dict(role='user', content=request['text']))
            self.write_native(frame, reply_path)
            fact = self.journal.record_outgoing(aid, 'transport-written')
        except Exception:
            # The journal precedes all external I/O. Even a partial write is
            # uncertainty, not permission to send another copy through a plugin.
            fact = self.journal.record_outgoing(aid, 'unknown')
        self.response(fact)

    def scan_requests(self):
        for path in self.requests.iterdir():
            if path.suffix != '.json' or not UUID.fullmatch(path.stem) or path.is_symlink():
                continue
            try:
                if path.stat().st_size > MAX_FRAME:
                    raise ValueError('request_too_large')
                request = json.loads(path.read_text())
                if request.get('attempt_id') != path.stem:
                    raise ValueError('request_id_mismatch')
            except (ValueError, OSError):
                continue  # The mod's file write may not have finished yet.
            self.dispatch(request)
            path.unlink(missing_ok=True)

    def scan_admissions(self):
        # Direct accepts do not have a native positive wire callback. The mod
        # reports the documented session.receive result, correlated with the
        # exact outstanding text, attempt, event and generation.
        for path in self.admissions.iterdir():
            if path.suffix != '.json' or not UUID.fullmatch(path.stem) or path.is_symlink():
                continue
            try:
                if path.stat().st_size > 16384:
                    continue
                fact = json.loads(path.read_text())
            except (ValueError, OSError):
                continue
            old = self.journal.outgoing_fact(path.stem)
            if (old and fact.get('attempt_id') == path.stem and fact.get('generation') == old['generation']
                    and fact.get('event_id') == old['event_id'] and fact.get('stage') == 'host-queued'
                    and fact.get('admission_source') == 'session.receive'):
                self.response(self.journal.record_outgoing(path.stem, 'host-queued', admission='session.receive'))
            path.unlink(missing_ok=True)

    def route(self, target, content):
        result = self.bus.request('/api/send', dict(
            **{'from': dict(name=self.source['name'], team=self.source['team'])},
            to=dict(agent_id=target), body=content, auto_poke=False))
        if target not in result.get('recipients', []):
            raise ValueError('mailbox_recipient_mismatch')
        return result.get('message_id')

    def receive(self, listener, target):
        connection, _ = listener.accept()
        with connection:
            connection.settimeout(0.5)
            observed = peer_identity(connection)
            if observed != self.owner:
                return
            data = bytearray()
            while len(data) <= MAX_FRAME:
                chunk = connection.recv(min(65536, MAX_FRAME + 1 - len(data)))
                if not chunk:
                    break
                data.extend(chunk)
            if len(data) > MAX_FRAME:
                return
        for line in data.splitlines():
            try:
                frame = json.loads(line)
                if type(frame.get('msgV')) is not int or frame['msgV'] != 1:
                    continue
                if frame.get('type') == 'control' and frame.get('action') == 'peer_message_status':
                    aid = frame.get('orig_msg_id')
                    raw = frame.get('status')
                    detail = frame.get('status_detail')
                    stage = {'delivered': 'host-queued', 'held': 'held', 'refused': 'refused',
                             'denied': 'refused', 'expired': 'expired', 'dropped': 'failed'}.get(raw)
                    if raw == 'expired' and detail == 'refused':
                        stage = 'refused'
                    if stage and isinstance(aid, str) and UUID.fullmatch(aid):
                        fact = self.journal.record_outgoing(aid, stage, raw, detail)
                        if fact:
                            self.response(fact)
                elif frame.get('type') == 'user':
                    state, _ = self.journal.forward_incoming(frame, target, observed, self.owner,
                                                              self.owner_socket, self.route)
                    self.write_native(dict(type='control', action='peer_message_status',
                                           orig_msg_id=frame['msg_id'],
                                           status='delivered' if state == 'stored' else 'held'),
                                      self.endpoint(target))
            except Exception:
                # No frames or body text in diagnostics. A failed dispatch is
                # retained by the journal and never relayed a second time.
                self.emit(dict(kind='diagnostic', reason='native_frame_not_committed'))

    def run(self):
        self.refresh()
        self.emit(dict(kind='ready', state_dir=str(self.root), socket_root=str(self.sockets), pid=os.getpid()))
        next_refresh = time.monotonic() + 5
        next_alive = time.monotonic() + 1
        while (self.running and not (self.root / f'stop-{os.getpid()}').exists()
               and process_start(self.owner_pid) == self.owner[2]):
            for key, _ in self.selector.select(0.05):
                try:
                    self.receive(key.fileobj, key.data)
                except (OSError, ValueError):
                    self.emit(dict(kind='diagnostic', reason='native_connection_rejected'))
            self.scan_requests()
            self.scan_admissions()
            now = time.monotonic()
            if now >= next_refresh:
                try:
                    self.refresh()
                except Exception:
                    self.emit(dict(kind='diagnostic', reason='roster_temporarily_unavailable'))
                next_refresh = now + 5
            if now >= next_alive:
                self.emit(dict(kind='alive'))  # Broken stdout stops an unloaded mod's helper.
                next_alive = now + 1

    def close(self):
        for listener, path in self.endpoints.values():
            self.selector.unregister(listener)
            listener.close()
            path.unlink(missing_ok=True)
            try:
                path.parent.rmdir()
            except OSError:
                pass
        try:
            self.sockets.rmdir()
        except OSError:
            pass
        self.selector.close()
        (self.root / f'stop-{os.getpid()}').unlink(missing_ok=True)
        self.journal.db.close()
        os.close(self.lock)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    for name in ('state-dir', 'base', 'agent-id', 'socket'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    bridge = None
    try:
        bridge = Bridge(args)
        signal.signal(signal.SIGTERM, lambda *_: setattr(bridge, 'running', False))
        signal.signal(signal.SIGINT, lambda *_: setattr(bridge, 'running', False))
        bridge.run()
    except (BrokenPipeError, ProcessLookupError, FileNotFoundError):
        pass
    except Exception as error:
        print(json.dumps(dict(kind='unavailable', reason=type(error).__name__)), flush=True)
        return 2
    finally:
        if bridge:
            bridge.close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

"""Experimental native-to-xats routing journal, not an enabled delivery adapter.

Bindings come from an explicitly authorized session, never peer message text.
Unknown forwarding outcomes are held for reconciliation, not retried blindly.
"""
from dataclasses import asdict, dataclass
import hashlib
import json
import os
from pathlib import Path
import sqlite3
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
from wire import MAX_FRAME_BYTES, PeerIdentity, UUID


@dataclass(frozen=True)
class Binding:
    peer: PeerIdentity
    reply_path: str
    sender_id: str
    sender_team: str
    sender_name: str
    target_id: str

    def __post_init__(self):
        if not isinstance(self.peer, PeerIdentity) or not all(isinstance(v, str) and v for v in
                (self.sender_id, self.sender_team, self.sender_name, self.target_id)):
            raise ValueError('incomplete_authorized_binding')
        path = Path(self.reply_path)
        if not path.is_absolute() or '..' in path.parts or path.suffix != '.sock':
            raise ValueError('invalid_bound_reply_path')

    def fingerprint(self):
        return hashlib.sha256(json.dumps(asdict(self), sort_keys=True).encode()).hexdigest()


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('xats_redirect_refused')


def route_local(base, binding, body):
    """Experimental lifeboat API client, restricted to an explicit loopback bus.

    The fixtures use freshly registered, live sender/target IDs. Production
    integration still needs a first-class authenticated sender-binding contract.
    """
    url = urlsplit(base)
    if (url.scheme != 'http' or url.hostname != '127.0.0.1' or not url.port
            or url.username or url.password or url.path not in ('', '/')
            or url.query or url.fragment):
        raise ValueError('explicit_loopback_bus_required')
    base = base.rstrip('/')
    opener = build_opener(ProxyHandler({}), NoRedirect())
    def request(path, value=None):
        data = json.dumps(value).encode() if value is not None else None
        req = Request(base + path, data=data, headers={'Content-Type': 'application/json'})
        with opener.open(req, timeout=3) as response:
            if response.status != 200:
                raise ValueError('xats_response_not_success')
            raw = response.read(MAX_FRAME_BYTES + 1)
            if len(raw) > MAX_FRAME_BYTES:
                raise ValueError('xats_response_too_large')
            return json.loads(raw)
    rows = request('/api/agents?' + urlencode({'team': binding.sender_team})).get('agents', [])
    sender = next((row for row in rows if row.get('agent_id') == binding.sender_id), None)
    target = next((row for row in rows if row.get('agent_id') == binding.target_id), None)
    if (not sender or not target or not sender.get('online') or not target.get('online')
            or sender.get('name') != binding.sender_name or sender.get('team') != binding.sender_team):
        raise ValueError('xats_binding_no_longer_current')
    result = request('/api/send', {'from': {'team': binding.sender_team, 'name': binding.sender_name},
                                 'to': {'agent_id': binding.target_id}, 'body': body, 'auto_poke': False})
    if binding.target_id not in result.get('recipients', []):
        raise ValueError('xats_commit_recipient_mismatch')
    return result.get('message_id')


class Spool:
    """Private experimental journal. The real mailbox authority remains xats.

    The parent directory must already be private. This is not a security
    boundary against a malicious process with the same OS user identity.
    """
    def __init__(self, path):
        path = Path(path)
        parent = path.parent.stat()
        if (path.is_symlink() or parent.st_uid != os.getuid() or parent.st_mode & 0o077
                or (path.exists() and path.stat().st_uid != os.getuid())):
            raise ValueError('spool_requires_private_directory')
        self.db = sqlite3.connect(path)
        path.chmod(0o600)
        self.db.execute('''CREATE TABLE IF NOT EXISTS incoming (
            key TEXT PRIMARY KEY, binding TEXT NOT NULL, body TEXT NOT NULL,
            state TEXT NOT NULL, xats_id TEXT)''')
        # Crash after external dispatch is ambiguous, never an automatic retry.
        self.db.execute("UPDATE incoming SET state='unknown' WHERE state='inflight'")
        self.db.commit()

    def close(self):
        self.db.close()

    def accept(self, frame, binding, observed_peer):
        if not isinstance(binding, Binding) or binding.peer != observed_peer:
            raise ValueError('unverified_native_sender')
        if (not isinstance(frame, dict) or type(frame.get('msgV')) is not int
                or frame.get('msgV') != 1 or frame.get('type') != 'user'):
            raise ValueError('unsupported_native_frame')
        if frame.get('from') != 'uds:' + binding.reply_path:
            raise ValueError('reply_address_not_bound')
        mid = frame.get('msg_id')
        body = frame.get('message', {}).get('content') if isinstance(frame.get('message'), dict) else None
        if not isinstance(mid, str) or not UUID.fullmatch(mid):
            raise ValueError('invalid_native_message_id')
        if not isinstance(body, str) or not body or len(body.encode()) > MAX_FRAME_BYTES:
            raise ValueError('invalid_native_body')
        key = hashlib.sha256(f'{binding.peer.pid}:{binding.peer.start_token}:{mid}'.encode()).hexdigest()
        fingerprint = binding.fingerprint()
        with self.db:
            old = self.db.execute('SELECT binding, body FROM incoming WHERE key=?', (key,)).fetchone()
            if old and old != (fingerprint, body):
                raise ValueError('message_id_reused_or_binding_changed')
            self.db.execute('INSERT OR IGNORE INTO incoming VALUES(?,?,?,\'stored\',NULL)',
                            (key, fingerprint, body))
        return key

    def fact(self, key):
        row = self.db.execute('SELECT state,xats_id FROM incoming WHERE key=?', (key,)).fetchone()
        if row is None:
            raise ValueError('unknown_native_message')
        state, xats_id = row
        return {'state': state, 'xats_message_id': xats_id,
                'native_receipt': 'delivered' if state == 'forwarded' else 'held',
                'observation': 'xats-mailbox-stored' if state == 'forwarded' else state}

    def forward_once(self, key, binding, route):
        """route(binding, body) returns a verified xats message UUID after commit.

        Set inflight durably BEFORE the external request. Any lost response,
        exception or malformed success remains unknown, even after restart.
        """
        row = self.db.execute('SELECT binding,body FROM incoming WHERE key=?', (key,)).fetchone()
        if row is None or row[0] != binding.fingerprint():
            raise ValueError('forward_binding_mismatch')
        with self.db:
            changed = self.db.execute("UPDATE incoming SET state='inflight' WHERE key=? AND state='stored'", (key,)).rowcount
        if not changed:
            return self.fact(key)
        try:
            xats_id = route(binding, row[1])
            if not isinstance(xats_id, str) or not UUID.fullmatch(xats_id):
                raise ValueError('unverified_xats_commit_response')
        except Exception:
            with self.db:
                self.db.execute("UPDATE incoming SET state='unknown' WHERE key=?", (key,))
            return self.fact(key)
        with self.db:
            self.db.execute("UPDATE incoming SET state='forwarded', xats_id=? WHERE key=?", (xats_id, key))
        return self.fact(key)

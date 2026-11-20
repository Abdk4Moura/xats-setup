"""Owned ephemeral xats backend for acceptance only. Never attaches to a live bus."""
import json
from pathlib import Path
import re
import selectors
import shutil
import signal
import subprocess
import time
from urllib.parse import urlencode
from urllib.request import ProxyHandler, Request, build_opener
from bridge import NoRedirect


class Backend:
    def __init__(self, root, entry, env):
        self.root = Path(root)
        self.entry = Path(entry).resolve(strict=True)
        self.node = shutil.which('node')
        if not self.node:
            raise ValueError('Node executable required for owned backend acceptance')
        self.env = {key: env[key] for key in ('PATH', 'HOME', 'USERPROFILE', 'TMPDIR') if key in env}
        self.env['CROSS_AGENT_TEAMS_MCP_HOME'] = str(self.root)
        self.command = [self.node, str(self.entry), 'daemon', '--port', '0', '--host', '127.0.0.1',
                        '--db', str(self.root / 'mail.db'), '--pid-file', str(self.root / 'daemon.pid'),
                        '--no-loopback-companion']
        self.process = None
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    def start(self):
        self.process = subprocess.Popen(self.command, env=self.env, cwd=self.root,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                        start_new_session=True)
        selector = selectors.DefaultSelector()
        selector.register(self.process.stdout, selectors.EVENT_READ)
        deadline = time.monotonic() + 12
        buffer = b''
        try:
            while time.monotonic() < deadline and self.process.poll() is None:
                for key, _ in selector.select(0.05):
                    import os
                    buffer += os.read(key.fileobj.fileno(), 4096)
                    match = re.search(rb'listening on 127\.0\.0\.1:(\d+)', buffer)
                    if match:
                        self.base = 'http://127.0.0.1:' + match[1].decode()
                        return self.base
            raise RuntimeError('Owned backend did not become ready')
        finally:
            selector.close()

    def stop(self):
        if not self.process:
            return
        if self.process.poll() is None:
            import os
            os.killpg(self.process.pid, signal.SIGTERM)
            try:
                self.process.wait(timeout=4)
            except subprocess.TimeoutExpired:
                os.killpg(self.process.pid, signal.SIGKILL)
                self.process.wait()
        self.process.stdout.close()
        self.process.stderr.close()
        self.process = None

    def request(self, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        request = Request(self.base + path, data=data, headers={'Content-Type': 'application/json'})
        with self.opener.open(request, timeout=3) as response:
            if response.status != 200:
                raise RuntimeError('Owned backend request failed')
            raw = response.read(1048577)
            if len(raw) > 1048576:
                raise RuntimeError('Owned backend response too large')
            return json.loads(raw)

    def register(self, name):
        result = self.request('/api/register', {'name': name, 'team': 'native-fixture',
                              'agent_type': 'custom', 'agent_type_name': 'native-protocol-fixture'})
        return result['agent_id']

    def inbox(self, name):
        return self.request('/api/inbox?' + urlencode({'team': 'native-fixture', 'name': name, 'since_event_id': 0}))

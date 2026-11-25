import importlib.util
import json
import os
from pathlib import Path
import socket
import tempfile
import unittest
import uuid

SOURCE = Path(__file__).resolve().parents[2] / 'assets/claude/mod/native/peer.py'
spec = importlib.util.spec_from_file_location('xats_native_peer', SOURCE)
peer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(peer)


class JournalTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='xats-native-unit-')
        self.path = Path(self.temporary.name) / 'journal.db'
        self.journal = peer.Journal(self.path)
        self.request = dict(attempt_id=str(uuid.uuid4()), message_id=str(uuid.uuid4()),
                            generation=1, event_id=7, source_agent_id=str(uuid.uuid4()), text='notice')
        self.identity = (os.getpid(), os.getuid(), peer.process_start(os.getpid()))
        self.reply = Path(self.temporary.name) / f'{os.getpid()}.sock'
        self.frame = dict(msgV=1, type='user', msg_id=str(uuid.uuid4()),
                          **{'from': 'uds:' + str(self.reply)}, message=dict(content='native message'))
        self.target = str(uuid.uuid4())

    def tearDown(self):
        self.journal.db.close()
        self.temporary.cleanup()

    def test_outgoing_is_durable_before_external_write(self):
        self.assertEqual(self.journal.prepare_outgoing(self.request), (True, 'prepared'))
        self.assertTrue(self.journal.begin_write(self.request['attempt_id']))
        self.journal.db.close()
        self.journal = peer.Journal(self.path)
        self.assertEqual(self.journal.prepare_outgoing(self.request), (False, 'unknown'))

    def test_no_external_write_yet_is_retryable_across_restart_and_generation(self):
        self.assertEqual(self.journal.prepare_outgoing(self.request), (True, 'prepared'))
        self.journal.db.close()
        self.journal = peer.Journal(self.path)
        self.assertEqual(self.journal.prepare_outgoing(self.request), (True, 'prepared'))
        replacement = dict(self.request, generation=2, attempt_id=str(uuid.uuid4()))
        self.assertEqual(self.journal.prepare_outgoing(replacement), (True, 'prepared'))
        self.assertFalse(self.journal.begin_write(self.request['attempt_id']))
        self.assertTrue(self.journal.begin_write(replacement['attempt_id']))

    def test_refusal_survives_replay_and_replacement_generation(self):
        self.journal.prepare_outgoing(self.request)
        self.journal.record_outgoing(self.request['attempt_id'], 'refused', 'expired', 'refused')
        replacement = dict(self.request, attempt_id=str(uuid.uuid4()), generation=2)
        self.assertEqual(self.journal.prepare_outgoing(replacement), (False, 'refused'))
        fact = self.journal.record_outgoing(self.request['attempt_id'], 'host-queued', 'delivered')
        self.assertEqual(fact['stage'], 'refused')
        self.assertEqual(fact['wire_status'], 'expired')
        self.assertEqual(fact['wire_detail'], 'refused')

    def test_host_approval_receipt_can_release_a_hold(self):
        self.journal.prepare_outgoing(self.request)
        self.journal.record_outgoing(self.request['attempt_id'], 'held', 'held')
        self.assertEqual(self.journal.record_outgoing(self.request['attempt_id'], 'host-queued', 'delivered')['stage'], 'host-queued')
        self.assertEqual(self.journal.record_outgoing(self.request['attempt_id'], 'transport-written')['stage'], 'host-queued')

    def test_host_api_admission_is_distinct_from_a_wire_receipt(self):
        self.journal.prepare_outgoing(self.request)
        self.journal.begin_write(self.request['attempt_id'])
        self.journal.record_outgoing(self.request['attempt_id'], 'transport-written')
        fact = self.journal.record_outgoing(self.request['attempt_id'], 'host-queued', admission='session.receive')
        self.assertEqual(fact['admission_source'], 'session.receive')
        self.assertIsNone(fact['wire_status'], 'do not fabricate a delivered wire packet')
        fact = self.journal.record_outgoing(self.request['attempt_id'], 'host-queued', raw='delivered')
        self.assertEqual(fact['wire_status'], 'delivered')
        self.assertEqual(fact['admission_source'], 'session.receive')

    def test_attempt_id_cannot_be_reused_with_changed_body(self):
        self.journal.prepare_outgoing(self.request)
        with self.assertRaisesRegex(ValueError, 'different_input'):
            self.journal.prepare_outgoing(dict(self.request, text='different'))

    def test_unmatched_receipt_cannot_acknowledge_any_attempt(self):
        self.assertIsNone(self.journal.record_outgoing(str(uuid.uuid4()), 'host-queued'))

    def test_native_send_commits_once_and_duplicate_is_not_forwarded(self):
        calls = []
        def route(target, body):
            calls.append((target, body))
            return str(uuid.uuid4())
        result = self.journal.forward_incoming(self.frame, self.target, self.identity, self.identity, self.reply, route)
        self.assertEqual(result[0], 'stored')
        self.assertEqual(self.journal.forward_incoming(self.frame, self.target, self.identity, self.identity, self.reply, route), result)
        self.assertEqual(calls, [(self.target, 'native message')])

    def test_lost_commit_response_is_unknown_and_never_retried(self):
        calls = []
        def uncertain(*args):
            calls.append(args)
            raise TimeoutError()
        self.assertEqual(self.journal.forward_incoming(self.frame, self.target, self.identity, self.identity, self.reply, uncertain), ('unknown', None))
        self.journal.db.close()
        self.journal = peer.Journal(self.path)
        self.assertEqual(self.journal.forward_incoming(self.frame, self.target, self.identity, self.identity, self.reply, uncertain), ('unknown', None))
        self.assertEqual(len(calls), 1)

    def test_target_change_cannot_reuse_native_message_id(self):
        route = lambda *_: str(uuid.uuid4())
        self.journal.forward_incoming(self.frame, self.target, self.identity, self.identity, self.reply, route)
        with self.assertRaisesRegex(ValueError, 'reused'):
            self.journal.forward_incoming(self.frame, str(uuid.uuid4()), self.identity, self.identity, self.reply, route)

    def test_kernel_identity_and_reply_binding_both_required(self):
        route = lambda *_: self.fail('unverified sender reached mailbox')
        for identity in [(1, self.identity[1], self.identity[2]),
                         (self.identity[0], self.identity[1] + 1, self.identity[2]),
                         (self.identity[0], self.identity[1], 'different-start')]:
            with self.assertRaisesRegex(ValueError, 'unbound_native_sender'):
                self.journal.forward_incoming(self.frame, self.target, identity, self.identity, self.reply, route)
        changed = dict(self.frame, **{'from': 'uds:/tmp/other.sock'})
        with self.assertRaisesRegex(ValueError, 'unbound_native_sender'):
            self.journal.forward_incoming(changed, self.target, self.identity, self.identity, self.reply, route)

    def test_wire_version_and_message_identity_are_not_guessed(self):
        for change in [dict(msgV=True), dict(msgV=2), dict(msg_id='not-a-uuid'), dict(message={})]:
            with self.assertRaisesRegex(ValueError, 'invalid_native_message'):
                self.journal.forward_incoming(dict(self.frame, **change), self.target,
                    self.identity, self.identity, self.reply, lambda *_: self.fail('invalid frame routed'))

    def test_journal_and_control_directory_are_private(self):
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        folder = peer.private_directory(Path(self.temporary.name) / 'private')
        self.assertEqual(folder.stat().st_mode & 0o777, 0o700)
        bad = Path(self.temporary.name) / 'public'
        bad.mkdir(mode=0o755)
        with self.assertRaisesRegex(ValueError, 'private_directory'):
            peer.private_directory(bad)

    def test_loopback_client_rejects_remote_and_credential_urls(self):
        for url in ['https://127.0.0.1:9100', 'http://example.com:9100', 'http://a:b@127.0.0.1:9100',
                    'http://127.0.0.1:9100/mcp', 'http://127.0.0.1:9100/?token=secret']:
            with self.assertRaisesRegex(ValueError, 'loopback_bus'):
                peer.Bus(url)

    def test_only_one_helper_can_own_a_session_journal(self):
        folder = Path(self.temporary.name)
        first = peer.owner_lock(folder)
        try:
            with self.assertRaises(BlockingIOError):
                peer.owner_lock(folder)
        finally:
            os.close(first)
        second = peer.owner_lock(folder)
        os.close(second)

    def test_full_body_uses_native_peer_envelope_without_faking_claude_or_permission_mode(self):
        request = dict(self.request, delivery='body', source_name='Pi "worker"', text='Full native reply body')
        content = peer.native_content(request, self.reply)
        self.assertIn('from-name="xats:Pi &quot;worker&quot;"', content)
        self.assertIn('Full native reply body', content)
        self.assertIn('from="uds:' + str(self.reply) + '"', content)
        self.assertNotIn('from-mode=', content)
        self.assertNotIn('get_inbox', content)
        self.assertEqual(peer.native_content(dict(request, delivery='notice'), self.reply), request['text'])

    def test_mailbox_sockets_are_vetted_siblings_and_cleanup_keeps_host_namespace(self):
        # Short socket paths, with the durable journal on the test's disk root.
        with tempfile.TemporaryDirectory(prefix='xn-', dir='/tmp') as scratch:
            namespace = Path(scratch) / 'r'
            namespace.mkdir(mode=0o700)
            owner_path = namespace / f'{os.getpid()}.sock'
            owner = socket.socket(socket.AF_UNIX)
            owner.bind(str(owner_path))
            bridge = None
            try:
                args = peer.argparse.Namespace(state_dir=Path(self.temporary.name) / 'bridge',
                    socket=owner_path, agent_id=str(uuid.uuid4()), base='http://127.0.0.1:9')
                bridge = peer.Bridge(args)
                endpoint = bridge.endpoint(self.target)
                self.assertEqual(endpoint.parent, owner_path.parent,
                    'native policy callbacks do not accept nested socket directories')
                expected = f'xats-{os.getpid()}-{self.target.replace("-", "")[:12]}.sock'
                self.assertEqual(endpoint.name, expected,
                    'the address must survive a helper restart, so it cannot carry the helper pid')
                self.assertEqual(endpoint.stat().st_mode & 0o777, 0o600)
                owner.close()
                owner_path.unlink()
                bridge.close()
                bridge = None
                self.assertTrue(namespace.is_dir(), 'the helper must never delete Claude\'s namespace')
                self.assertFalse(endpoint.exists())
            finally:
                if bridge:
                    bridge.close()
                owner.close()

    def test_real_unix_socket_reports_the_connecting_process(self):
        path = str(Path(self.temporary.name) / 'test.sock')
        with socket.socket(socket.AF_UNIX) as listener, socket.socket(socket.AF_UNIX) as client:
            listener.bind(path)
            listener.listen(1)
            client.connect(path)
            connection, _ = listener.accept()
            with connection:
                self.assertEqual(peer.peer_identity(connection), self.identity)


if __name__ == '__main__':
    unittest.main()

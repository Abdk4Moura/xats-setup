import json
from pathlib import Path
import tempfile
import unittest
import uuid
from bridge import Binding, Spool, route_local
from wire import PeerIdentity, encode_peer_message


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'spool.db'
        self.peer = PeerIdentity(456, 1000, 'start-a')
        self.binding = Binding(self.peer, '/private/cc-socks/456.sock', 'sender-id', 'test', 'sender', 'target-id')
        _, raw = encode_peer_message('owned fixture', self.binding.reply_path, sender_pid=456)
        self.frame = json.loads(raw)
        self.spool = Spool(self.path)
        self.addCleanup(lambda: self.spool.close() if self.spool else None)

    def test_identity_and_reply_binding_precede_storage(self):
        with self.assertRaises(ValueError):
            self.spool.accept(self.frame, self.binding, PeerIdentity(999, 1000, 'start-a'))
        with self.assertRaises(ValueError):
            self.spool.accept({**self.frame, 'from': 'uds:/someone-else.sock'}, self.binding, self.peer)
        key = self.spool.accept(self.frame, self.binding, self.peer)
        self.assertEqual(self.spool.fact(key)['native_receipt'], 'held')

    def test_one_commit_and_no_duplicate_route_after_receipt_loss_or_restart(self):
        key = self.spool.accept(self.frame, self.binding, self.peer)
        calls = []
        xats_id = str(uuid.uuid4())
        def route(binding, body):
            calls.append(body)
            return xats_id
        result = self.spool.forward_once(key, self.binding, route)
        self.assertEqual(result['xats_message_id'], xats_id)
        self.assertEqual(result['observation'], 'xats-mailbox-stored')
        self.assertEqual(result['native_receipt'], 'delivered')
        self.assertEqual(self.spool.accept(self.frame, self.binding, self.peer), key)
        self.spool.close(); self.spool = Spool(self.path)
        self.spool.forward_once(key, self.binding, route)
        self.assertEqual(calls, ['owned fixture'])

    def test_lost_external_ack_stays_unknown_without_blind_retries(self):
        key = self.spool.accept(self.frame, self.binding, self.peer)
        calls = []
        def lost_ack(binding, body):
            calls.append(body)
            raise TimeoutError('fixture: request may already have committed')
        self.assertEqual(self.spool.forward_once(key, self.binding, lost_ack)['state'], 'unknown')
        self.spool.close(); self.spool = Spool(self.path)
        result = self.spool.forward_once(key, self.binding, lost_ack)
        self.assertEqual(result['native_receipt'], 'held')
        self.assertEqual(len(calls), 1)

    def test_crash_after_dispatch_does_not_resend(self):
        key = self.spool.accept(self.frame, self.binding, self.peer)
        with self.spool.db:
            self.spool.db.execute("UPDATE incoming SET state='inflight' WHERE key=?", (key,))
        self.spool.close(); self.spool = Spool(self.path)
        def forbidden(*args):
            self.fail('uncertain dispatch must never be replayed automatically')
        self.assertEqual(self.spool.forward_once(key, self.binding, forbidden)['state'], 'unknown')

    def test_same_message_id_cannot_change_body_or_destination(self):
        key = self.spool.accept(self.frame, self.binding, self.peer)
        with self.assertRaises(ValueError):
            self.spool.accept({**self.frame, 'message': {'role': 'user', 'content': 'changed'}}, self.binding, self.peer)
        other = Binding(self.peer, self.binding.reply_path, 'sender-id', 'test', 'sender', 'different-target')
        with self.assertRaises(ValueError):
            self.spool.accept(self.frame, other, self.peer)
        with self.assertRaises(ValueError):
            self.spool.forward_once(key, other, lambda *_: str(uuid.uuid4()))

    def test_nonloopback_bus_is_rejected_before_network_access(self):
        for url in ['http://example.invalid', 'https://127.0.0.1:1234', 'http://localhost:1234', 'http://127.0.0.1:1234/other', 'http://user:pass@127.0.0.1:1234']:
            with self.assertRaises(ValueError):
                route_local(url, self.binding, 'fixture')


if __name__ == '__main__':
    unittest.main()

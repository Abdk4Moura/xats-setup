import json
import unittest
import uuid
from wire import MAX_FRAME_BYTES, PeerIdentity, decode_receipt, encode_peer_message


class WireTests(unittest.TestCase):
    def setUp(self):
        self.peer = PeerIdentity(456, 1000, 'start-a')
        self.mid = str(uuid.uuid4())

    def receipt(self, status='held', **extra):
        return {'msgV': 1, 'type': 'control', 'action': 'peer_message_status',
                'msg_id': str(uuid.uuid4()), 'orig_msg_id': self.mid,
                'status': status, **extra}

    def decode(self, frame, peer=None):
        return decode_receipt(frame, message_id=self.mid, expected_peer=self.peer,
                              observed_peer=peer or self.peer)

    def test_external_frame_has_version_and_uuid_without_forged_session(self):
        mid, data = encode_peer_message('hello', '/private/cc-socks/123.sock', sender_pid=123)
        frame = json.loads(data)
        self.assertEqual(frame['msgV'], 1)
        self.assertEqual(frame['msg_id'], mid)
        self.assertEqual(frame['from_plugin'], 'xats-experiment')
        self.assertNotIn('session_id', frame)
        self.assertNotIn('from_mode', frame)
        self.assertTrue(data.endswith(b'\n'))

    def test_rejects_unowned_shape_and_unbounded_payload(self):
        for path in ['relative.sock', '/cc-socks/999.sock', '/cc-socks/x\n/123.sock', '/cc-socks/../123.sock']:
            with self.assertRaises(ValueError):
                encode_peer_message('hello', path, sender_pid=123)
        with self.assertRaisesRegex(ValueError, 'too_large'):
            encode_peer_message('x' * MAX_FRAME_BYTES, '/cc-socks/123.sock', sender_pid=123)
        with self.assertRaises(ValueError):
            encode_peer_message('hello', '/cc-socks/123.sock', sender_pid=123, message_id='not-a-uuid')

    def test_normalizes_observed_refusal_without_erasing_raw_encoding(self):
        result = self.decode(self.receipt('expired', status_detail='refused'))
        self.assertEqual(result['status'], 'refused')
        self.assertEqual(result['wire_status'], 'expired')
        self.assertEqual(self.decode(self.receipt('expired'))['status'], 'expired')
        self.assertEqual(self.decode(self.receipt('held'))['status'], 'held')

    def test_native_delivered_means_queue_admission_not_model_reading(self):
        result = self.decode(self.receipt('delivered'))
        self.assertEqual(result['observation'], 'host-queued')
        self.assertNotIn('read', result)
        self.assertNotIn('replied', result)

    def test_rejects_unrelated_ids_and_claimed_identity_without_kernel_evidence(self):
        with self.assertRaisesRegex(ValueError, 'uncorrelated'):
            self.decode(self.receipt(orig_msg_id=str(uuid.uuid4())))
        for peer in [PeerIdentity(999, 1000, 'start-a'), PeerIdentity(456, 1001, 'start-a'), PeerIdentity(456, 1000, 'recycled')]:
            with self.assertRaisesRegex(ValueError, 'unverified'):
                self.decode(self.receipt(), peer)
        with self.assertRaises(ValueError):
            self.decode(self.receipt(msgV=2))
        with self.assertRaises(ValueError):
            self.decode(self.receipt('made-up-success'))
        with self.assertRaises(ValueError):
            self.decode(self.receipt({}))
        with self.assertRaises(ValueError):
            self.decode(self.receipt(msgV=True))
        with self.assertRaises(ValueError):
            decode_receipt(self.receipt(), message_id=self.mid, expected_peer=None, observed_peer=None)


if __name__ == '__main__':
    unittest.main()

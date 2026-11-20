"""Independent, experimental Claude 2.1.295 peer-wire codec.

Not a production transport. Kernel identity and endpoint ownership must be
verified by the caller. A plugin label is attribution, not authentication.
"""
from dataclasses import dataclass
import json
from pathlib import PurePosixPath
import re
import uuid

VERSION = '2.1.295'
WIRE_VERSION = 1
MAX_FRAME_BYTES = 65536
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.I)
STATUSES = frozenset({'held', 'denied', 'expired', 'delivered', 'refused', 'dropped'})

@dataclass(frozen=True)
class PeerIdentity:
    pid: int
    uid: int
    start_token: str

    def __post_init__(self):
        if (type(self.pid) is not int or self.pid <= 1 or type(self.uid) is not int
                or self.uid < 0 or not isinstance(self.start_token, str) or not self.start_token):
            raise ValueError('incomplete_peer_identity')


def encode_peer_message(body, reply_path, *, sender_pid, message_id=None):
    """Build an honest external peer frame, never a Claude session identity."""
    path = PurePosixPath(reply_path)
    if (not path.is_absolute() or '..' in path.parts or path.name != f'{sender_pid}.sock'
            or any(c in str(path) for c in '\x00\r\n') or sender_pid <= 1):
        raise ValueError('invalid_owned_reply_path')
    if not isinstance(body, str) or not body:
        raise ValueError('empty_peer_body')
    message_id = str(uuid.uuid4()) if message_id is None else message_id
    if not isinstance(message_id, str) or not UUID.fullmatch(message_id):
        raise ValueError('invalid_message_id')
    frame = {'msgV': WIRE_VERSION, 'msg_id': message_id, 'type': 'user',
             'uuid': str(uuid.uuid4()), 'from': 'uds:' + str(path),
             'from_plugin': 'xats-experiment', 'priority': 'next',
             'message': {'role': 'user', 'content': body}}
    encoded = (json.dumps(frame, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8')
    if len(encoded) > MAX_FRAME_BYTES:
        raise ValueError('peer_frame_too_large')
    return message_id, encoded


def decode_receipt(frame, *, message_id, expected_peer, observed_peer):
    """Validate correlation and independently supplied kernel process evidence.

    A failed/unknown write is never implicitly retried by this codec. Callers
    retain unknown outcomes until actual observations establish more facts.
    """
    if (not isinstance(expected_peer, PeerIdentity) or not isinstance(observed_peer, PeerIdentity)
            or observed_peer != expected_peer):
        raise ValueError('unverified_receipt_peer')
    if (not isinstance(frame, dict) or type(frame.get('msgV')) is not int
            or frame.get('msgV') != WIRE_VERSION):
        raise ValueError('unsupported_receipt_frame')
    if frame.get('type') != 'control' or frame.get('action') != 'peer_message_status':
        raise ValueError('not_a_peer_receipt')
    if (not UUID.fullmatch(str(frame.get('msg_id', '')))
            or not UUID.fullmatch(str(message_id)) or frame.get('orig_msg_id') != message_id):
        raise ValueError('uncorrelated_receipt')
    raw = frame.get('status')
    if not isinstance(raw, str) or raw not in STATUSES:
        raise ValueError('unknown_receipt_status')
    detail = frame.get('status_detail')
    # Observed compatibility encoding on the pinned CLI. Preserve raw evidence.
    status = 'refused' if raw == 'expired' and detail == 'refused' else raw
    return {'wire_status': raw, 'wire_status_detail': detail, 'status': status,
            'observation': 'host-queued' if status == 'delivered' else status,
            'message_id': message_id}

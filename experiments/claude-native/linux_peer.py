"""Linux-only experimental kernel process evidence, not claimed wire identity."""
from pathlib import Path
import socket
import struct
from wire import PeerIdentity


def process_start(pid):
    if type(pid) is not int or pid <= 1:
        raise ValueError('invalid_peer_pid')
    with (Path('/proc') / str(pid) / 'stat').open('rb') as stream:
        raw = stream.read(16384)
    # comm can contain spaces and parentheses; fields after its final ')' start
    # at field 3. starttime is field 22, therefore index 19 in this suffix.
    fields = raw.rsplit(b')', 1)[1].split()
    token = fields[19].decode('ascii')
    if not token.isdecimal():
        raise ValueError('unverifiable_process_start')
    return token


def socket_peer(connection):
    if not hasattr(socket, 'SO_PEERCRED'):
        raise ValueError('unsupported_kernel_peer_credentials')
    pid, uid, _ = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    return PeerIdentity(pid, uid, process_start(pid))

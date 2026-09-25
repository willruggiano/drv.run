"""Test-only Ethernet relay: real owner-bound Host TAP <-> namespace TAP.

Both endpoints use the kernel IP stack. No bridges or substitute firewall rules
are installed on the Host. The Host-side TUNSETIFF always runs as the owner.
"""

import errno
import fcntl
import os
import pwd
import select
import struct
import sys


def attach(name: str) -> int:
    fd = os.open("/dev/net/tun", os.O_RDWR)
    try:
        # IFF_TAP | IFF_NO_PI | IFF_VNET_HDR | IFF_MULTI_QUEUE
        fcntl.ioctl(fd, 0x400454CA, struct.pack("16sH", name.encode(), 0x5102))
    except BaseException:
        os.close(fd)
        raise
    return fd


def main() -> None:
    mode, tap, *args = sys.argv[1:]
    if mode in ("allowed", "denied"):
        # Assert opening the device works, so denial is at TUNSETIFF, not DAC.
        os.close(os.open("/dev/net/tun", os.O_RDWR))
        try:
            fd = attach(tap)
        except PermissionError as error:
            assert mode == "denied" and error.errno == errno.EPERM
        else:
            os.close(fd)
            assert mode == "allowed"
        return

    assert mode == "relay"
    namespace, owner = args
    account = pwd.getpwnam(owner)
    original = os.open("/proc/self/ns/net", os.O_RDONLY)
    target = os.open(f"/run/netns/{namespace}", os.O_RDONLY)
    os.setns(target, os.CLONE_NEWNET)
    peer = attach("eth0")
    os.setns(original, os.CLONE_NEWNET)
    os.close(original)
    os.close(target)
    os.setgroups([])
    os.setgid(account.pw_gid)
    os.setuid(account.pw_uid)
    host = attach(tap)
    while True:
        readable, _, _ = select.select([host, peer], [], [])
        for source in readable:
            packet = os.read(source, 65536)
            assert packet
            destination = peer if source == host else host
            assert os.write(destination, packet) == len(packet)


if __name__ == "__main__":
    main()

import asyncio
import os
import ssl
import tempfile
import unittest
from collections.abc import Callable
from contextlib import suppress
from pathlib import Path
from typing import cast
from unittest.mock import patch

from main import HOST, Policy, create_master
from mitmproxy.addons.proxyserver import Proxyserver

from .fixture import Fixture, certificate
from .proxy_test import ALICE, BOB, basic


class Ready:
    def __init__(self) -> None:
        self.event: asyncio.Event = asyncio.Event()

    def running(self) -> None:
        self.event.set()


class TransportTest(unittest.IsolatedAsyncioTestCase):
    async def test_git_and_streaming(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = Fixture(root)
            upstream = await asyncio.start_server(
                fixture.handle, "127.0.0.1", 0, ssl=certificate(root / "tls")
            )
            upstream_port = cast(tuple[str, int], upstream.sockets[0].getsockname())[1]
            self.addAsyncCleanup(upstream.wait_closed)
            self.addCleanup(upstream.close)
            master = create_master(
                root / "proxy", 0, {ALICE: "alice_token", BOB: "bob_token"}
            )
            master.options.set(
                "ssl_verify_upstream_trusted_ca="
                + str(root / "tls/upstream-ca-cert.pem")
            )
            get_addon = cast(Callable[[str], object], master.addons.get)
            policy = cast(Policy, get_addon("policy"))

            async def resolve() -> str:
                return "93.184.216.34"

            policy.resolve = resolve
            ready = Ready()
            cast(Callable[[Ready], None], master.addons.add)(ready)
            task = asyncio.create_task(master.run())
            _ = await asyncio.wait_for(ready.event.wait(), 10)
            proxyserver = cast(Proxyserver, get_addon("proxyserver"))
            port = proxyserver.listen_addrs()[0][1]
            original = asyncio.open_connection

            async def routed(
                host: str, port: int, *, local_addr: tuple[str, int] | None = None
            ) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
                # Emulate an isolated routed network without weakening Policy's
                # address checks or adding a production localhost exception.
                if (host, port) == ("93.184.216.34", 443):
                    host, port = "127.0.0.1", upstream_port
                return await original(host, port, local_addr=local_addr)

            environment = {
                **os.environ,
                "HOME": str(root / "home"),
                "GH_TOKEN": ALICE,
                "GH_TELEMETRY": "false",
                "GIT_TERMINAL_PROMPT": "0",
                "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_CONFIG_GLOBAL": str(root / "gitconfig"),
                "GIT_AUTHOR_NAME": "Test",
                "GIT_AUTHOR_EMAIL": "test@example.test",
                "GIT_COMMITTER_NAME": "Test",
                "GIT_COMMITTER_EMAIL": "test@example.test",
            }
            (root / "home").mkdir()
            _ = (root / "gitconfig").write_text(
                '[http "https://github.com/"]\n'
                + f"proxy = http://127.0.0.1:{port}\n"
                + f"sslCAInfo = {root}/proxy/mitmproxy-ca-cert.pem\n"
                + '[credential "https://github.com"]\n'
                + "helper = !gh auth git-credential\n"
            )

            async def git(*arguments: str, succeeds: bool = True) -> None:
                process = await asyncio.create_subprocess_exec(
                    "git",
                    *arguments,
                    env=environment,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=None,
                )
                try:
                    code = await asyncio.wait_for(process.wait(), 30)
                finally:
                    if process.returncode is None:
                        process.kill()
                        _ = await process.wait()
                self.assertEqual(code == 0, succeeds, arguments)

            try:
                with patch("asyncio.open_connection", routed):
                    for owner in ("alice", "bob"):
                        await git(
                            "init",
                            "--bare",
                            "--initial-branch=main",
                            str(root / owner / "repo.git"),
                        )
                    work = root / "work"
                    await git("clone", "https://github.com/alice/repo.git", str(work))
                    _ = (work / "value").write_text("initial")
                    await git("-C", str(work), "add", "value")
                    await git("-C", str(work), "commit", "-m", "initial")
                    await git("-C", str(work), "push", "origin", "main")
                    self.assertEqual(
                        (work / ".git/refs/heads/main").read_bytes(),
                        (root / "alice/repo.git/refs/heads/main").read_bytes(),
                    )
                    peer = root / "peer"
                    await git("clone", "https://github.com/alice/repo.git", str(peer))
                    _ = (peer / "value").write_text("upstream")
                    # Incompressible payload exercises chunked Git uploads.
                    _ = (peer / "large").write_bytes(os.urandom(3 * 1024 * 1024))
                    await git("-C", str(peer), "add", ".")
                    await git("-C", str(peer), "commit", "-m", "upstream")
                    await git("-C", str(peer), "push", "origin", "main")
                    await git("-C", str(work), "pull", "--ff-only")
                    self.assertEqual(
                        (work / "value").read_bytes(), (peer / "value").read_bytes()
                    )
                    self.assertEqual(
                        (work / "large").read_bytes(), (peer / "large").read_bytes()
                    )
                    await git(
                        "ls-remote", "https://github.com/bob/repo.git", succeeds=False
                    )
                    environment["GH_TOKEN"] = BOB
                    await git("ls-remote", "https://github.com/bob/repo.git")
                    environment["GH_TOKEN"] = "unknown"
                    count = len(fixture.requests)
                    await git(
                        "ls-remote", "https://github.com/alice/repo.git", succeeds=False
                    )
                    self.assertEqual(len(fixture.requests), count)
                    environment["GH_TOKEN"] = ALICE
                    await git(
                        "ls-remote",
                        "https://github.com/alice/redirect.git",
                        succeeds=False,
                    )

                    # Prove streaming by withholding the second body chunk until
                    # the fixture has received the first, not by timing a push.
                    reader, writer = await asyncio.open_connection("127.0.0.1", port)
                    writer.write(
                        b"CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\n"
                    )
                    await writer.drain()
                    _ = await reader.readuntil(b"\r\n\r\n")
                    context = ssl.create_default_context(
                        cafile=str(root / "proxy/mitmproxy-ca-cert.pem")
                    )
                    await writer.start_tls(context, server_hostname=HOST)
                    fixture.received.clear()
                    writer.write(
                        (
                            "POST /alice/stream.git/git-receive-pack HTTP/1.1\r\nHost: github.com\r\nAuthorization: "
                            + basic(ALICE)
                            + "\r\nContent-Length: 2\r\n\r\na"
                        ).encode()
                    )
                    await writer.drain()
                    _ = await asyncio.wait_for(fixture.received.wait(), 5)
                    writer.write(b"b")
                    await writer.drain()
                    _ = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 5)
                    writer.close()
                    # The proxy may reset the TLS socket after Connection: close.
                    with suppress(ConnectionResetError):
                        await writer.wait_closed()
                    self.assertEqual(fixture.streamed, b"ab")
                    self.assertEqual(fixture.errors, [])

                    # Do not trust an unrelated upstream CA.
                    unrelated = root / "unrelated"
                    _ = certificate(unrelated)
                    master.options.set(
                        "ssl_verify_upstream_trusted_ca="
                        + str(unrelated / "upstream-ca-cert.pem")
                    )
                    count = len(fixture.requests)
                    await git(
                        "ls-remote", "https://github.com/alice/repo.git", succeeds=False
                    )
                    self.assertEqual(len(fixture.requests), count)
            finally:
                master.shutdown()
                await asyncio.wait_for(task, 10)
                _ = await proxyserver.servers.update([])
            await git("ls-remote", "https://github.com/alice/repo.git", succeeds=False)


if __name__ == "__main__":
    _ = unittest.main()

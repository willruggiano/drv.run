import asyncio
import json
import os
import ssl
import tempfile
import unittest
from collections.abc import AsyncGenerator, Callable
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import cast
from unittest.mock import patch
from urllib.parse import parse_qs

from auth import Account, Authorization, GitHub
from main import HOST, Owner, Policy, create_master, prepare
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.tools.dump import DumpMaster
from tornado.httpclient import HTTPRequest, HTTPResponse

from .fixture import Fixture, certificate, certificate_authority
from .oauth import Clock, OAuth, enroll, github
from .proxy_test import ALICE, BOB, basic


class Ready:
    def __init__(self) -> None:
        self.event: asyncio.Event = asyncio.Event()

    def running(self) -> None:
        self.event.set()


class TransportTest(unittest.IsolatedAsyncioTestCase):
    @asynccontextmanager
    async def proxy(
        self, root: Path, authorization: Authorization, fixture: Fixture
    ) -> AsyncGenerator[tuple[DumpMaster, int]]:
        ca = certificate_authority(root / "ca-source")
        (root / "state").mkdir(exist_ok=True)
        for name, placeholder in [("alice", ALICE), ("bob", BOB)]:
            _ = (root / "state" / ("placeholder-" + name)).write_text(placeholder)
        with patch("main.os.chown"):
            prepare(
                root / "state",
                root / "public",
                [Owner("alice", 1000, 1), Owner("bob", 1001, 2)],
                999,
                ca,
                root / "proxy",
            )
        upstream = await asyncio.start_server(
            fixture.handle, "127.0.0.1", 0, ssl=certificate(root / "tls")
        )
        upstream_port = cast(tuple[str, int], upstream.sockets[0].getsockname())[1]
        master = create_master(
            root / "proxy",
            0,
            {ALICE: Account("alice", 1), BOB: Account("bob", 2)},
            authorization,
        )
        master.options.set(
            "ssl_verify_upstream_trusted_ca=" + str(root / "tls/upstream-ca-cert.pem")
        )
        get_addon = cast(Callable[[str], object], master.addons.get)
        policy = cast(Policy, get_addon("policy"))

        async def resolve() -> str:
            return "93.184.216.34"

        policy.resolve = resolve
        ready = Ready()
        cast(Callable[[Ready], None], master.addons.add)(ready)
        task = asyncio.create_task(master.run())
        proxyserver = cast(Proxyserver, get_addon("proxyserver"))
        original = asyncio.open_connection

        async def routed(
            host: str, port: int, *, local_addr: tuple[str, int] | None = None
        ) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
            # Emulate an isolated routed network without weakening Policy's
            # address checks or adding a production localhost exception.
            if (host, port) == ("93.184.216.34", 443):
                host, port = "127.0.0.1", upstream_port
            return await original(host, port, local_addr=local_addr)

        try:
            _ = await asyncio.wait_for(ready.event.wait(), 10)
            with patch("asyncio.open_connection", routed):
                yield master, proxyserver.listen_addrs()[0][1]
        finally:
            master.shutdown()
            await asyncio.wait_for(task, 10)
            _ = await proxyserver.servers.update([])
            upstream.close()
            await upstream.wait_closed()

    @asynccontextmanager
    async def upload(
        self, root: Path, port: int, size: int
    ) -> AsyncGenerator[tuple[asyncio.StreamReader, asyncio.StreamWriter]]:
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        try:
            writer.write(
                b"CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\n"
            )
            await writer.drain()
            _ = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 5)
            context = ssl.create_default_context(
                cafile=str(root / "ca-source/fixture-ca-cert.pem")
            )
            await writer.start_tls(context, server_hostname=HOST)
            writer.write(
                (
                    "POST /alice/stream.git/git-receive-pack HTTP/1.1\r\nHost: github.com\r\nAuthorization: "
                    + basic(ALICE)
                    + f"\r\nContent-Length: {size}\r\n\r\n"
                ).encode()
            )
            await writer.drain()
            yield reader, writer
        finally:
            # Also clean up a sender blocked by backpressure or a cancelled hook.
            writer.transport.abort()
            with suppress(ConnectionError):
                await asyncio.wait_for(writer.wait_closed(), 5)

    async def test_overlapping_uploads_outlive_lock_acquisition_timeout(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            clock = Clock()
            oauth = OAuth(clock)
            authorization = Authorization(root / "auth", github(oauth, clock))
            await enroll(authorization, oauth, Account("alice", 1))
            fixture = Fixture(root, oauth)
            async with self.proxy(root, authorization, fixture) as (_, port):
                async with self.upload(root, port, 2) as (first_reader, first_writer):
                    first_writer.write(b"a")
                    await first_writer.drain()
                    _ = await asyncio.wait_for(fixture.received.wait(), 5)
                    fixture.received.clear()
                    async with self.upload(root, port, 2) as (
                        second_reader,
                        second_writer,
                    ):
                        second_writer.write(b"c")
                        await second_writer.drain()
                        _ = await asyncio.wait_for(fixture.received.wait(), 5)
                        # Both transfers remain active longer than locked()'s
                        # real 30-second acquisition timeout. Neither is renewed.
                        await asyncio.sleep(31)
                        async with asyncio.timeout(5):
                            self.assertEqual(
                                (await authorization.status(Account("alice", 1))).state,
                                "usable",
                            )
                        self.assertIsNone(fixture.streamed)
                        first_writer.write(b"b")
                        await first_writer.drain()
                        _ = await asyncio.wait_for(
                            first_reader.readuntil(b"\r\n\r\n"), 5
                        )
                        self.assertEqual(fixture.streamed, b"ab")
                        second_writer.write(b"d")
                        await second_writer.drain()
                        _ = await asyncio.wait_for(
                            second_reader.readuntil(b"\r\n\r\n"), 5
                        )
                        self.assertEqual(fixture.streamed, b"cd")
                self.assertEqual(len(fixture.requests), 2)
                self.assertEqual(fixture.errors, [])
                await asyncio.wait_for(authorization.logout(Account("alice", 1)), 5)

    async def test_stalled_refresh_backpressures_upload(self) -> None:
        await self.stalled_refresh("success")

    async def test_failed_refresh_closes_upload(self) -> None:
        await self.stalled_refresh("failure")

    async def test_cancelled_refresh_closes_upload(self) -> None:
        await self.stalled_refresh("cancel")

    async def stalled_refresh(self, outcome: str) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            clock = Clock()
            oauth = OAuth(clock)
            entered, resume = asyncio.Event(), asyncio.Event()

            async def fetch(request: HTTPRequest) -> HTTPResponse:
                if parse_qs((request.body or b"").decode()).get("grant_type") == [
                    "refresh_token"
                ]:
                    entered.set()
                    _ = await resume.wait()
                    if outcome == "failure":
                        raise OSError("refresh unavailable")
                    if outcome == "cancel":
                        raise asyncio.CancelledError
                return await oauth.fetch(request)

            authorization = Authorization(
                root / "auth", GitHub("test-app", fetch, clock, clock.sleep)
            )
            await enroll(authorization, oauth, Account("alice", 1))
            clock.now += 28800
            fixture = Fixture(root, oauth)
            size = 16 * 1024 * 1024
            async with self.proxy(root, authorization, fixture) as (_, port):
                async with self.upload(root, port, size) as (reader, writer):
                    _ = await asyncio.wait_for(entered.wait(), 5)

                    async def send() -> None:
                        for _ in range(size // 32768):
                            writer.write(b"x" * 32768)
                            await writer.drain()

                    sending = asyncio.create_task(send())
                    try:
                        # The producer must stall at the socket, not finish
                        # into mitmproxy's paused HTTP-event queue. No private
                        # layer/buffer introspection is used by this check.
                        with self.assertRaises(TimeoutError):
                            await asyncio.wait_for(asyncio.shield(sending), 1)
                        self.assertEqual(fixture.requests, [])
                        resume.set()
                        if outcome == "success":
                            await asyncio.wait_for(sending, 15)
                            _ = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 5)
                            self.assertEqual(fixture.streamed, b"x" * size)
                        else:
                            with suppress(ConnectionError):
                                self.assertEqual(
                                    await asyncio.wait_for(reader.read(1), 5), b""
                                )
                            writer.transport.abort()
                            with self.assertRaises(ConnectionError):
                                await asyncio.wait_for(sending, 5)
                            self.assertEqual(fixture.requests, [])
                    finally:
                        resume.set()
                        _ = sending.cancel()
                        _ = await asyncio.gather(sending, return_exceptions=True)
                # Failure/cancellation cannot strand the account or socket
                # gate. A fresh enrollment and upload must still work.
                await asyncio.wait_for(
                    enroll(authorization, oauth, Account("alice", 1)), 5
                )
                async with self.upload(root, port, 2) as (reader, writer):
                    writer.write(b"ok")
                    await writer.drain()
                    _ = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 5)
                    self.assertEqual(fixture.streamed, b"ok")
                self.assertEqual(fixture.errors, [])

    async def test_git_and_streaming(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            clock = Clock()
            oauth = OAuth(clock)
            authorization = Authorization(root / "auth", github(oauth, clock))
            for account in [Account("alice", 1), Account("bob", 2)]:
                await enroll(authorization, oauth, account)
            fixture = Fixture(root, oauth)
            async with self.proxy(root, authorization, fixture) as (master, port):
                environment = {
                    **os.environ,
                    "HOME": str(root / "home"),
                    "GH_CONFIG_DIR": str(root / "public/alice"),
                    "GH_TOKEN": "must-not-override-seeded-config",
                    "GITHUB_TOKEN": "must-not-override-seeded-config",
                    "GH_TELEMETRY": "false",
                    "GH_NO_UPDATE_NOTIFIER": "1",
                    "HTTPS_PROXY": f"http://127.0.0.1:{port}",
                    "SSL_CERT_FILE": str(root / "ca-source/fixture-ca-cert.pem"),
                    "NO_PROXY": "",
                    "no_proxy": "",
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
                    + f"sslCAInfo = {root}/ca-source/fixture-ca-cert.pem\n"
                    + '[credential "https://github.com"]\n'
                    + "helper = !env -u GH_TOKEN -u GITHUB_TOKEN gh auth git-credential\n"
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

                for owner in ("alice", "bob", "company", "readonly"):
                    await git(
                        "init",
                        "--bare",
                        "--initial-branch=main",
                        str(root / owner / "repo.git"),
                    )
                work = root / "work"
                await git("clone", "https://github.com/alice/repo.git", str(work))
                _ = (work / "value").write_text("initial")
                (work / ".github/workflows").mkdir(parents=True)
                _ = (work / ".github/workflows/check.yml").write_text(
                    "name: check\non: push\njobs: {}\n"
                )
                await git("-C", str(work), "add", ".github")
                await git("-C", str(work), "add", "value")
                await git("-C", str(work), "commit", "-m", "initial")
                await git("-C", str(work), "push", "origin", "main")
                self.assertEqual(
                    (work / ".git/refs/heads/main").read_bytes(),
                    (root / "alice/repo.git/refs/heads/main").read_bytes(),
                )
                await git(
                    "-C",
                    str(work),
                    "push",
                    "https://github.com/company/repo.git",
                    "main",
                )
                self.assertEqual(
                    (work / ".git/refs/heads/main").read_bytes(),
                    (root / "company/repo.git/refs/heads/main").read_bytes(),
                )
                await git(
                    "clone",
                    "https://github.com/company/repo.git",
                    str(root / "company-work"),
                )
                self.assertEqual(
                    (work / ".github/workflows/check.yml").read_bytes(),
                    (root / "company-work/.github/workflows/check.yml").read_bytes(),
                )
                # GitHub permission denial does not revoke the user token.
                del oauth.grants[1]["company"]
                await git(
                    "ls-remote",
                    "https://github.com/company/repo.git",
                    succeeds=False,
                )
                await git("ls-remote", "https://github.com/alice/repo.git")
                oauth.grants[1]["company"] = True
                # Access-token renewal needs neither a new helper nor a guest restart.
                clock.now += 28800
                await git("ls-remote", "https://github.com/company/repo.git")
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
                environment["GH_CONFIG_DIR"] = str(root / "public/bob")
                await git("ls-remote", "https://github.com/bob/repo.git")
                await git("ls-remote", "https://github.com/readonly/repo.git")
                await git(
                    "-C",
                    str(work),
                    "push",
                    "https://github.com/readonly/repo.git",
                    "main",
                    succeeds=False,
                )
                self.assertFalse((root / "readonly/repo.git/refs/heads/main").exists())
                (root / "unknown").mkdir()
                _ = (root / "unknown/config.yml").write_bytes(
                    (root / "public/alice/config.yml").read_bytes()
                )
                _ = (root / "unknown/hosts.yml").write_text(
                    json.dumps({"github.com": {"oauth_token": "unknown"}})
                )
                environment["GH_CONFIG_DIR"] = str(root / "unknown")
                count = len(fixture.requests)
                await git(
                    "ls-remote", "https://github.com/alice/repo.git", succeeds=False
                )
                self.assertEqual(len(fixture.requests), count)
                environment["GH_CONFIG_DIR"] = str(root / "public/alice")
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
                    cafile=str(root / "ca-source/fixture-ca-cert.pem")
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
                await authorization.logout(Account("alice", 1))
                await git(
                    "ls-remote", "https://github.com/alice/repo.git", succeeds=False
                )
                await enroll(authorization, oauth, Account("alice", 1))
                await git("ls-remote", "https://github.com/alice/repo.git")
                oauth.revoke(1)
                await git("-C", str(work), "push", "origin", "main", succeeds=False)
                await enroll(authorization, oauth, Account("alice", 1))
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
                master.options.set(
                    "ssl_verify_upstream_trusted_ca="
                    + str(root / "tls/upstream-ca-cert.pem")
                )
                # A failed upstream connection must release the credential lease.
                await git("ls-remote", "https://github.com/alice/repo.git")
            await git("ls-remote", "https://github.com/alice/repo.git", succeeds=False)


if __name__ == "__main__":
    _ = unittest.main()

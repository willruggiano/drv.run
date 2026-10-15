import asyncio
import io
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from typing import cast
from unittest.mock import patch
from urllib.parse import parse_qs

from auth import Account, AuthError, Authorization, Device, GitHub, http_client
from tornado.httpclient import HTTPRequest, HTTPResponse
from tornado.simple_httpclient import SimpleAsyncHTTPClient

from .fixture import Fixture, certificate
from .oauth import Clock, OAuth, enroll, github

ALICE = Account("alice", 1)
BOB = Account("bob", 2)


class AuthorizationTest(unittest.IsolatedAsyncioTestCase):
    def __init__(self, methodName: str = "runTest") -> None:
        super().__init__(methodName)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory: Path = Path(temporary.name) / "auth"
        self.clock: Clock = Clock()
        self.oauth: OAuth = OAuth(self.clock)
        self.authorization: Authorization = self.reopen()

    def reopen(self) -> Authorization:
        return Authorization(self.directory, github(self.oauth, self.clock))

    async def test_device_and_refresh_protocol_over_verified_tls(self) -> None:
        root = self.directory.parent
        fixture = Fixture(root, self.oauth)
        server = await asyncio.start_server(
            fixture.handle, "127.0.0.1", 0, ssl=certificate(root / "tls")
        )
        self.addAsyncCleanup(server.wait_closed)
        self.addCleanup(server.close)
        port = cast(tuple[str, int], server.sockets[0].getsockname())[1]
        client = SimpleAsyncHTTPClient(
            force_instance=True,
            hostname_mapping={
                ("github.com", 443): ("127.0.0.1", port),
                ("api.github.com", 443): ("127.0.0.1", port),
            },
            defaults={"ca_certs": str(root / "tls/upstream-ca-cert.pem")},
        )
        self.addCleanup(client.close)

        async def fetch(request: HTTPRequest) -> HTTPResponse:
            return await client.fetch(request, raise_error=False)

        authorization = Authorization(
            self.directory, GitHub("test-app", fetch, self.clock, self.clock.sleep)
        )
        await authorization.login(ALICE, lambda _: None)
        async with authorization.lease(ALICE) as token:
            self.assertTrue(self.oauth.permitted(token, "company", True))
        self.clock.now += 28800
        async with authorization.lease(ALICE) as renewed:
            self.assertTrue(self.oauth.permitted(renewed, "alice", True))
            self.assertFalse(self.oauth.permitted(token, "alice", True))
        self.assertEqual(fixture.errors, [])

    async def test_enrollment_restart_and_logout(self) -> None:
        self.assertEqual((await self.authorization.status(ALICE)).state, "not-enrolled")
        await enroll(self.authorization, self.oauth, ALICE)
        restarted = self.reopen()
        status = await restarted.status(ALICE)
        self.assertEqual(status.state, "usable")
        self.assertEqual(status.user_id, 1)
        self.assertEqual(status.expires_at, self.clock() + 28800)
        async with restarted.lease(ALICE) as token:
            self.assertTrue(self.oauth.permitted(token, "alice", True))
            self.assertTrue(self.oauth.permitted(token, "company", True))
            self.assertFalse(self.oauth.permitted(token, "bob", False))
        self.assertEqual((await restarted.status(BOB)).state, "not-enrolled")
        self.assertEqual(stat.S_IMODE(self.directory.stat().st_mode), 0o700)
        for path in self.directory.iterdir():
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        await restarted.logout(ALICE)
        with self.assertRaises(AuthError):
            async with self.authorization.lease(ALICE):
                self.fail("logged out credentials admitted")
        self.assertEqual((await self.authorization.status(ALICE)).state, "not-enrolled")

    async def test_polling_obeys_pending_and_slowdown(self) -> None:
        self.oauth.poll_errors.extend(["authorization_pending", "slow_down"])
        await enroll(self.authorization, self.oauth, ALICE)
        self.assertEqual(self.clock.sleeps, [1, 1, 6])
        self.assertEqual((await self.authorization.status(ALICE)).state, "usable")
        for request in self.oauth.requests:
            self.assertFalse(request.follow_redirects)
            self.assertIsNotNone(request.request_timeout)

    async def test_failed_enrollment_does_not_replace_working_identity(self) -> None:
        await enroll(self.authorization, self.oauth, ALICE)
        before = await self.authorization.status(ALICE)
        for error in ["access_denied", "expired_token", "device_flow_disabled"]:
            self.oauth.poll_errors.append(error)
            with self.assertRaises(AuthError):
                await enroll(self.authorization, self.oauth, ALICE)
            self.assertEqual(await self.authorization.status(ALICE), before)
        self.oauth.identity = 2
        with self.assertRaises(AuthError):
            await self.authorization.login(ALICE, lambda _: None)
        self.assertEqual(await self.authorization.status(ALICE), before)
        with self.assertRaises(AuthError):
            async with self.authorization.lease(Account("alice", 2)):
                self.fail("different GitHub identity admitted")
        other_app = Authorization(
            self.directory,
            GitHub("other-app", self.oauth.fetch, self.clock, self.clock.sleep),
        )
        with self.assertRaises(AuthError):
            async with other_app.lease(ALICE):
                self.fail("different app admitted")

    async def test_cancelled_or_expired_device_preserves_existing_login(self) -> None:
        await enroll(self.authorization, self.oauth, ALICE)
        before = await self.authorization.status(ALICE)

        def cancel(_: Device) -> None:
            raise asyncio.CancelledError

        with self.assertRaises(asyncio.CancelledError):
            await self.authorization.login(ALICE, cancel)
        self.assertEqual(await self.authorization.status(ALICE), before)

        def expire(device: Device) -> None:
            self.clock.now = device.expires_at

        with self.assertRaises(AuthError):
            await self.authorization.login(ALICE, expire)
        self.assertEqual(await self.authorization.status(ALICE), before)

    async def test_one_refresh_for_concurrent_requests_and_restart(self) -> None:
        await enroll(self.authorization, self.oauth, ALICE)
        self.clock.now += 28800

        async def access(authorization: Authorization) -> str:
            async with authorization.lease(ALICE) as token:
                self.assertTrue(self.oauth.permitted(token, "company", True))
                return token

        tokens = await asyncio.gather(*(access(self.reopen()) for _ in range(5)))
        self.assertEqual(len(set(tokens)), 1)
        refresh_requests = [
            request
            for request in self.oauth.requests
            if parse_qs((request.body or b"").decode()).get("grant_type")
            == ["refresh_token"]
        ]
        self.assertEqual(len(refresh_requests), 1)
        self.assertEqual(await access(self.reopen()), tokens[0])

    async def test_valid_leases_and_status_share_the_same_generation(self) -> None:
        await enroll(self.authorization, self.oauth, ALICE)
        async with self.authorization.lease(ALICE) as first:
            async with asyncio.timeout(2):
                async with self.reopen().lease(ALICE) as second:
                    self.assertEqual(first, second)
                    self.assertEqual(
                        (await self.reopen().status(ALICE)).state, "usable"
                    )
        self.assertTrue(self.oauth.permitted(first, "alice", True))

    async def test_rejection_waits_for_readers_and_ignores_replaced_tokens(
        self,
    ) -> None:
        await enroll(self.authorization, self.oauth, ALICE)
        async with self.authorization.lease(ALICE) as token:
            rejected = asyncio.create_task(self.reopen().reject(ALICE, token))
            try:
                await asyncio.sleep(0)
                self.assertFalse(rejected.done())
            except BaseException:
                _ = rejected.cancel()
                _ = await asyncio.gather(rejected, return_exceptions=True)
                raise
        await asyncio.wait_for(rejected, 2)
        self.assertEqual(
            (await self.reopen().status(ALICE)).state, "reauthorization-required"
        )
        await enroll(self.authorization, self.oauth, ALICE)
        await self.reopen().reject(ALICE, token)
        async with self.authorization.lease(ALICE) as replacement:
            self.assertNotEqual(token, replacement)
            self.assertTrue(self.oauth.permitted(replacement, "alice", True))
        await self.authorization.logout(ALICE)
        await self.reopen().reject(ALICE, replacement)
        self.assertEqual((await self.authorization.status(ALICE)).state, "not-enrolled")

    async def test_pending_logout_blocks_new_readers_until_old_readers_drain(
        self,
    ) -> None:
        await enroll(self.authorization, self.oauth, ALICE)

        async def access() -> None:
            async with self.reopen().lease(ALICE):
                pass

        tasks: list[asyncio.Task[None]] = []
        try:
            async with self.authorization.lease(ALICE):
                logout = asyncio.create_task(self.reopen().logout(ALICE))
                tasks.append(logout)
                await asyncio.sleep(0)
                reader = asyncio.create_task(access())
                tasks.append(reader)
                await asyncio.sleep(0)
                self.assertFalse(logout.done())
                self.assertFalse(reader.done())
            await asyncio.wait_for(logout, 2)
            with self.assertRaises(AuthError) as denied:
                _ = await asyncio.wait_for(reader, 2)
            self.assertEqual(denied.exception.state, "not-enrolled")
        finally:
            for task in tasks:
                _ = task.cancel()
            _ = await asyncio.gather(*tasks, return_exceptions=True)

    async def test_cancelled_writer_releases_admission_for_other_readers(self) -> None:
        await enroll(self.authorization, self.oauth, ALICE)
        async with self.authorization.lease(ALICE) as first:
            writer = asyncio.create_task(self.reopen().logout(ALICE))
            await asyncio.sleep(0)
            self.assertFalse(writer.done())
            _ = writer.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await writer
            async with asyncio.timeout(2):
                async with self.reopen().lease(ALICE) as second:
                    self.assertEqual(first, second)

    async def test_renewal_and_logout_wait_for_admitted_request(self) -> None:
        await enroll(self.authorization, self.oauth, ALICE)
        entered = asyncio.Event()
        finished = asyncio.Event()

        async def renew() -> None:
            entered.set()
            async with self.reopen().lease(ALICE) as token:
                self.assertTrue(self.oauth.permitted(token, "company", True))
            finished.set()

        async with self.authorization.lease(ALICE) as old:
            self.clock.now += 28750
            task = asyncio.create_task(renew())
            _ = await entered.wait()
            self.assertFalse(finished.is_set())
            self.assertTrue(self.oauth.permitted(old, "alice", True))
        await asyncio.wait_for(task, 2)
        self.assertFalse(self.oauth.permitted(old, "alice", True))
        async with self.authorization.lease(ALICE):
            logout = asyncio.create_task(self.reopen().logout(ALICE))
            await asyncio.sleep(0)
            self.assertFalse(logout.done())
        await asyncio.wait_for(logout, 2)
        self.assertEqual((await self.reopen().status(ALICE)).state, "not-enrolled")

    async def test_expired_refresh_or_revocation_requires_login_and_is_user_scoped(
        self,
    ) -> None:
        await enroll(self.authorization, self.oauth, ALICE)
        await enroll(self.authorization, self.oauth, BOB)
        self.oauth.revoke(1)
        self.clock.now += 28800
        with self.assertRaises(AuthError):
            async with self.authorization.lease(ALICE):
                self.fail("revoked token admitted")
        self.assertEqual(
            (await self.reopen().status(ALICE)).state, "reauthorization-required"
        )
        async with self.authorization.lease(BOB) as token:
            self.assertTrue(self.oauth.permitted(token, "bob", True))
        await enroll(self.authorization, self.oauth, ALICE)
        self.clock.now += 15897600
        self.assertEqual(
            (await self.authorization.status(ALICE)).state, "reauthorization-required"
        )
        with self.assertRaises(AuthError):
            async with self.authorization.lease(ALICE):
                self.fail("expired refresh admitted")

    async def test_interrupted_refresh_is_not_replayed_after_restart(self) -> None:
        await enroll(self.authorization, self.oauth, ALICE)
        self.clock.now += 28800
        calls = 0

        async def lost_response(request: HTTPRequest) -> HTTPResponse:
            nonlocal calls
            calls += 1
            _ = await self.oauth.fetch(request)
            raise asyncio.CancelledError

        interrupted = Authorization(
            self.directory, GitHub("test-app", lost_response, self.clock)
        )
        with self.assertRaises(asyncio.CancelledError):
            async with interrupted.lease(ALICE):
                self.fail("lost response admitted")
        self.assertEqual(calls, 1)
        self.assertEqual(
            (await self.reopen().status(ALICE)).state, "reauthorization-required"
        )
        requests = len(self.oauth.requests)
        with self.assertRaises(AuthError):
            async with self.reopen().lease(ALICE):
                self.fail("consumed refresh token reused")
        self.assertEqual(len(self.oauth.requests), requests)
        await enroll(self.authorization, self.oauth, ALICE)
        self.assertEqual((await self.authorization.status(ALICE)).state, "usable")

    async def test_network_failure_and_failed_disk_commit_do_not_admit_tokens(
        self,
    ) -> None:
        await enroll(self.authorization, self.oauth, ALICE)
        before = await self.authorization.status(ALICE)
        # File-system failure is injected at the OS boundary, not into token logic.
        with (
            patch("os.fsync", side_effect=OSError("disk failed")),
            self.assertRaises(OSError),
        ):
            await enroll(self.authorization, self.oauth, ALICE)
        self.assertEqual(await self.reopen().status(ALICE), before)
        async with self.reopen().lease(ALICE) as token:
            self.assertTrue(self.oauth.permitted(token, "alice", True))

        self.clock.now += 28800

        async def unavailable(_: HTTPRequest) -> HTTPResponse:
            raise OSError("network unavailable")

        offline = Authorization(
            self.directory, GitHub("test-app", unavailable, self.clock)
        )
        with self.assertRaises(AuthError) as error:
            async with offline.lease(ALICE):
                self.fail("unavailable token admitted")
        self.assertEqual(error.exception.state, "temporarily-unavailable")
        # The request may have reached GitHub. Restart cannot replay that refresh.
        self.assertEqual(
            (await self.reopen().status(ALICE)).state, "reauthorization-required"
        )

    async def test_operator_process_cannot_logout_an_in_flight_request(self) -> None:
        await enroll(self.authorization, self.oauth, ALICE)
        ready = self.directory.parent / "ready"
        complete = self.directory.parent / "complete"
        child = """
import asyncio
import sys
from pathlib import Path
from auth import Account, Authorization, GitHub

async def no_network(request):
    raise AssertionError("logout must not access GitHub")

async def main():
    authorization = Authorization(Path(sys.argv[1]), GitHub("test-app", no_network))
    Path(sys.argv[2]).touch()
    await authorization.logout(Account("alice", 1))
    Path(sys.argv[3]).touch()

asyncio.run(main())
"""
        async with self.authorization.lease(ALICE) as token:
            process = await asyncio.create_subprocess_exec(
                sys.executable,
                "-B",
                "-c",
                child,
                str(self.directory),
                str(ready),
                str(complete),
                env={
                    **os.environ,
                    "PYTHONPATH": str(Path(__file__).parents[1])
                    + os.pathsep
                    + os.environ.get("PYTHONPATH", ""),
                },
            )
            try:
                async with asyncio.timeout(5):
                    while not ready.exists():
                        await asyncio.sleep(0.01)
                self.assertFalse(complete.exists())
                self.assertTrue(self.oauth.permitted(token, "alice", True))
            except BaseException:
                process.kill()
                _ = await process.wait()
                raise
        try:
            self.assertEqual(await asyncio.wait_for(process.wait(), 5), 0)
        finally:
            if process.returncode is None:
                process.kill()
                _ = await process.wait()
        self.assertTrue(complete.exists())
        self.assertEqual((await self.authorization.status(ALICE)).state, "not-enrolled")

    async def test_untrusted_oauth_responses_never_enroll(self) -> None:
        for body in [
            b"[]",
            b"not-json",
            b"x" * 65537,
            b'{"error":"device_flow_disabled"}',
            b'{"verification_uri":"https://evil.test"}',
        ]:

            async def fetch(request: HTTPRequest, body: bytes = body) -> HTTPResponse:
                return HTTPResponse(request, 200, buffer=io.BytesIO(body))

            authorization = Authorization(
                self.directory, GitHub("test-app", fetch, self.clock)
            )
            with self.assertRaises(AuthError):
                await authorization.login(
                    ALICE, lambda _: self.fail("unsafe device prompt")
                )
            self.assertEqual((await authorization.status(ALICE)).state, "not-enrolled")

    async def test_nonexpiring_and_malformed_token_responses_preserve_login(
        self,
    ) -> None:
        await enroll(self.authorization, self.oauth, ALICE)
        before = await self.authorization.status(ALICE)
        for key, value in [
            ("expires_in", None),
            ("expires_in", True),
            ("expires_in", -1),
            ("refresh_token", ""),
            ("access_token", "ghp_pat"),
            ("token_type", "basic"),
        ]:

            async def fetch(
                request: HTTPRequest, key: str = key, value: object = value
            ) -> HTTPResponse:
                response = await self.oauth.fetch(request)
                if request.url.endswith("/access_token"):
                    data = cast(dict[str, object], json.loads(response.body))
                    data[key] = value
                    return HTTPResponse(
                        request, 200, buffer=io.BytesIO(json.dumps(data).encode())
                    )
                return response

            authorization = Authorization(
                self.directory, GitHub("test-app", fetch, self.clock, self.clock.sleep)
            )
            with self.assertRaises(AuthError):
                await authorization.login(ALICE, lambda _: None)
            self.assertEqual(await authorization.status(ALICE), before)

    async def test_unsafe_state_permissions_fail_closed(self) -> None:
        await enroll(self.authorization, self.oauth, ALICE)
        self.directory.chmod(0o755)
        self.assertEqual(
            (await self.authorization.status(ALICE)).state, "temporarily-unavailable"
        )
        with self.assertRaises(AuthError):
            async with self.authorization.lease(ALICE):
                self.fail("unsafe state admitted")
        self.directory.chmod(0o700)

    async def test_http_client_does_not_follow_redirects_or_environment_proxy(
        self,
    ) -> None:
        requests: list[bytes] = []

        async def handle(
            reader: asyncio.StreamReader, writer: asyncio.StreamWriter
        ) -> None:
            requests.append(await reader.readuntil(b"\r\n\r\n"))
            writer.write(
                b"HTTP/1.1 302 Found\r\nLocation: https://other.test/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            await writer.drain()
            writer.close()
            await writer.wait_closed()

        server = await asyncio.start_server(handle, "127.0.0.1", 0)
        self.addAsyncCleanup(server.wait_closed)
        self.addCleanup(server.close)
        port = cast(tuple[str, int], server.sockets[0].getsockname())[1]
        client = http_client()
        self.addCleanup(client.close)
        with patch.dict(
            os.environ,
            {"HTTPS_PROXY": "http://127.0.0.1:1", "HTTP_PROXY": "http://127.0.0.1:1"},
        ):
            response = await client.fetch(
                HTTPRequest(f"http://127.0.0.1:{port}/", follow_redirects=False),
                raise_error=False,
            )
        self.assertEqual(response.code, 302)
        self.assertEqual(len(requests), 1)


if __name__ == "__main__":
    _ = unittest.main()

import asyncio
import grp
import http.client
import json
import os
import pwd
import socket
import tempfile
import unittest
from pathlib import Path
from typing import cast, override
from unittest.mock import patch

from auth import Account, Authorization, GitHub, object_value
from main import Capabilities, Control, Controls, control_listener, control_server
from tornado.netutil import bind_unix_socket

from .oauth import Clock, OAuth

ALICE = Account("alice")
BOB = Account("bob")


class ControlTest(unittest.IsolatedAsyncioTestCase):
    def __init__(self, methodName: str = "runTest") -> None:
        super().__init__(methodName)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.path: Path = root / "alice.sock"
        self.clock: Clock = Clock()
        self.oauth: OAuth = OAuth(self.clock)
        self.waiting: asyncio.Event = asyncio.Event()
        self.approval: asyncio.Event = asyncio.Event()

        async def sleep(seconds: float) -> None:
            self.waiting.set()
            _ = await self.approval.wait()
            await self.clock.sleep(seconds)

        self.authorization: Authorization = Authorization(
            root / "state", GitHub("test-app", self.oauth.fetch, self.clock, sleep)
        )
        self.controls: Controls = Controls({"github": self.authorization})
        self.control: Control = self.controls.get(ALICE, "github")
        self.capabilities: Capabilities = Capabilities(root / "capabilities")
        self.allowed: set[str] = {"alice"}

    @override
    async def asyncSetUp(self) -> None:
        user = pwd.struct_passwd(
            (
                "alice",
                "x",
                os.getuid(),
                os.getgid(),
                "",
                str(self.path.parent),
                "/bin/sh",
            )
        )

        def lookup(uid: int) -> pwd.struct_passwd:
            self.assertEqual(uid, os.getuid())
            return user

        def groups(name: str, gid: int) -> list[int]:
            return [gid] + ([4242] if name in self.allowed else [])

        _ = self.enterContext(patch("main.pwd.getpwuid", new=lookup))
        _ = self.enterContext(patch("main.pwd.getpwnam", return_value=user))
        _ = self.enterContext(
            patch(
                "main.grp.getgrnam",
                return_value=grp.struct_group(("mitm-proxy-access", "x", 4242, [])),
            )
        )
        _ = self.enterContext(patch("main.os.getgrouplist", new=groups))

        listener = bind_unix_socket(str(self.path), mode=0o600)
        # systemd defaults to blocking descriptors, unlike Tornado's bind helper.
        listener.setblocking(True)
        server = control_server(self.controls, listener, self.capabilities)
        self.addAsyncCleanup(server.close_all_connections)
        self.addAsyncCleanup(self.control.close)
        self.addCleanup(server.stop)

    async def call(
        self,
        method: str = "GET",
        path: str = "/status",
        body: str | None = None,
        headers: dict[str, str] | None = None,
    ) -> tuple[int, dict[str, object] | None]:
        def exchange() -> tuple[int, dict[str, object] | None]:
            connection = http.client.HTTPConnection("localhost", timeout=5)
            connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            _ = connection.sock.connect(str(self.path))
            try:
                connection.request(method, path, body=body, headers=headers or {})
                response = connection.getresponse()
                data = response.read()
                return response.status, object_value(
                    cast(object, json.loads(data))
                ) if response.status == 200 else None
            finally:
                connection.close()

        return await asyncio.to_thread(exchange)

    async def status(self) -> dict[str, object]:
        code, state = await self.call()
        self.assertEqual(code, 200)
        assert state is not None
        return state

    async def begin(self) -> dict[str, object]:
        self.waiting.clear()
        self.approval.clear()
        self.assertEqual(await self.call("POST", "/login"), (204, None))
        _ = await asyncio.wait_for(self.waiting.wait(), 5)
        state = await self.status()
        self.assertEqual(
            state,
            {
                "state": "authorizing",
                "user_id": None,
                "error": None,
                "device": {
                    "user_code": "ABCD-EFGH",
                    "verification_uri": "https://github.com/login/device",
                    "expires_at": self.clock() + 900,
                },
            },
        )
        return state

    async def approve(self) -> dict[str, object]:
        self.approval.set()
        async with asyncio.timeout(5):
            while (state := await self.status())["state"] == "authorizing":
                await asyncio.sleep(0)
        return state

    def test_activation_rejects_wrong_process_count_or_name(self) -> None:
        valid = {
            "LISTEN_PID": str(os.getpid()),
            "LISTEN_FDS": "1",
            "LISTEN_FDNAMES": "control",
        }
        for field, value in [
            ("LISTEN_PID", "0"),
            ("LISTEN_FDS", "0"),
            ("LISTEN_FDS", "2"),
            ("LISTEN_FDNAMES", "alice"),
        ]:
            with (
                self.subTest(field=field, value=value),
                patch.dict(os.environ, {**valid, field: value}),
                self.assertRaises(ValueError),
            ):
                _ = control_listener()

    async def test_enrollment_outlives_request_and_never_exports_tokens(self) -> None:
        pending = await self.begin()
        # A second browser request resumes the same enrollment, not another one.
        self.assertEqual(await self.call("POST", "/login"), (204, None))
        self.assertEqual(await self.status(), pending)
        approved = await self.approve()
        self.assertEqual(
            approved,
            {
                "state": "usable",
                "user_id": 1,
                "error": None,
                "device": None,
                "expires_at": self.clock() + 28800,
                "refresh_expires_at": self.clock() + 15897600,
                "account_id": None,
            },
        )
        async with self.authorization.lease(ALICE) as token:
            self.assertTrue(self.oauth.permitted(token, "company", True))
        self.assertEqual((await self.authorization.status(BOB)).state, "not-enrolled")

        # A failed replacement must preserve working credentials.
        self.oauth.poll_errors.append("access_denied")
        _ = await self.begin()
        self.assertEqual(
            await self.approve(), {**approved, "error": "reauthorization-required"}
        )
        async with self.authorization.lease(ALICE) as original:
            self.assertEqual(original, token)

    async def test_group_membership_and_peer_identity_select_private_capabilities(
        self,
    ) -> None:
        status, hosts = await self.call(
            "GET", "/hosts.yml", headers={"X-Forwarded-For": "1001", "X-User": "bob"}
        )
        self.assertEqual(status, 200)
        self.assertEqual(hosts, self.capabilities.hosts(ALICE))
        self.assertNotIn(BOB, self.capabilities.by_owner)
        self.assertEqual(await self.call("GET", "/hosts.yml?user=bob"), (400, None))
        self.allowed.clear()
        self.assertEqual(await self.call(), (403, None))
        self.assertEqual(await self.call("GET", "/hosts.yml"), (403, None))
        self.allowed.add("alice")
        self.assertEqual((await self.call("GET", "/hosts.yml"))[1], hosts)

    async def test_removal_cancels_pending_authorization_and_releases_lease(
        self,
    ) -> None:
        _ = await self.begin()
        self.assertEqual(await self.call("POST", "/logout"), (204, None))
        self.assertEqual((await self.status())["state"], "not-enrolled")
        _ = await self.begin()
        self.assertEqual((await self.approve())["state"], "usable")
        _ = await self.begin()
        # Shutdown cancels enrollment without deleting an earlier authorization.
        await self.control.close()
        async with self.authorization.lease(ALICE) as token:
            self.assertTrue(self.oauth.permitted(token, "alice", True))
        self.assertEqual(await self.call("POST", "/logout"), (204, None))
        self.assertEqual((await self.status())["state"], "not-enrolled")

    async def test_control_is_fixed_to_socket_owner_and_rejects_browser_requests(
        self,
    ) -> None:
        for method, path, body, headers, expected in [
            ("GET", "/login", None, None, 405),
            ("POST", "/status", None, None, 405),
            ("POST", "/login?user=bob", None, None, 400),
            ("POST", "/login", '{"user":"bob"}', None, 400),
            ("POST", "/login", None, {"Origin": "https://example.com"}, 403),
        ]:
            with self.subTest(method=method, path=path):
                self.assertEqual(
                    (await self.call(method, path, body, headers))[0], expected
                )
        self.assertEqual((await self.authorization.status(ALICE)).state, "not-enrolled")
        self.assertEqual((await self.authorization.status(BOB)).state, "not-enrolled")
        with socket.socket() as listener, self.assertRaises(ValueError):
            _ = control_server(self.controls, listener, self.capabilities)

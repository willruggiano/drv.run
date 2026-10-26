import asyncio
import http.client
import json
import socket
import tempfile
import unittest
from pathlib import Path
from typing import cast, override

from auth import Account, Authorization, GitHub, object_value
from main import Control, control_server
from tornado.netutil import bind_unix_socket

from .oauth import Clock, OAuth

ALICE = Account("alice", 1)
BOB = Account("bob", 2)


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
        self.control: Control = Control(self.authorization, ALICE)

    @override
    async def asyncSetUp(self) -> None:
        listener = bind_unix_socket(str(self.path), mode=0o600)
        # systemd defaults to blocking descriptors, unlike Tornado's bind helper.
        listener.setblocking(True)
        server = control_server(self.control, listener)
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
                "user_id": 1,
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
        self.oauth.identity = 2
        _ = await self.begin()
        self.assertEqual(
            await self.approve(), {**approved, "error": "reauthorization-required"}
        )
        async with self.authorization.lease(ALICE) as original:
            self.assertEqual(original, token)

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
            _ = control_server(self.control, listener)

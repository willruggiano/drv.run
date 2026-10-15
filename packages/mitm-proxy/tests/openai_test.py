import asyncio
import base64
import http.client
import io
import json
import socket
import stat
import tempfile
import unittest
from collections import deque
from pathlib import Path
from typing import cast
from urllib.parse import parse_qs

from auth import Account, AuthError, Authorization, Device, object_value
from main import Control, control_server
from openai import AUTH_BASE, CLIENT_ID, VERIFICATION_URI, OpenAI
from tornado.httpclient import HTTPRequest, HTTPResponse
from tornado.netutil import bind_unix_socket

from .oauth import Clock, OAuth, github

ALICE = Account("alice")
BOB = Account("bob")


def jwt(account_id: str, expiry: float, sequence: int) -> str:
    def part(value: object) -> str:
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")

    return ".".join(
        [
            part({"alg": "RS256"}),
            part(
                {
                    "https://api.openai.com/auth": {"chatgpt_account_id": account_id},
                    "exp": int(expiry),
                    "sequence": sequence,
                }
            ),
            "signature",
        ]
    )


class CodexOAuth:
    def __init__(self, clock: Clock) -> None:
        self.clock: Clock = clock
        self.account_id: str = "account-alice"
        self.sequence: int = 0
        self.refreshes: int = 0
        self.refresh_token: str = ""
        self.polls: deque[tuple[int, dict[str, object]]] = deque()
        self.requests: list[HTTPRequest] = []
        self.failure: str | None = None

    async def fetch(self, request: HTTPRequest) -> HTTPResponse:
        self.requests.append(request)
        assert request.method == "POST"
        assert not request.follow_redirects
        assert request.request_timeout == 20
        if request.url == AUTH_BASE + "/api/accounts/deviceauth/usercode":
            assert json.loads(request.body or b"") == {"client_id": CLIENT_ID}
            code, data = (
                200,
                {
                    "device_auth_id": "private-device",
                    "user_code": "ABCD-EFGH",
                    "interval": "1",
                },
            )
        elif request.url == AUTH_BASE + "/api/accounts/deviceauth/token":
            assert json.loads(request.body or b"") == {
                "device_auth_id": "private-device",
                "user_code": "ABCD-EFGH",
            }
            code, data = (
                self.polls.popleft()
                if self.polls
                else (
                    200,
                    {
                        "authorization_code": "private-code",
                        "code_verifier": "private-verifier",
                    },
                )
            )
        else:
            assert request.url == AUTH_BASE + "/oauth/token"
            values = parse_qs((request.body or b"").decode())
            assert values["client_id"] == [CLIENT_ID]
            if values["grant_type"] == ["refresh_token"]:
                self.refreshes += 1
                assert values["refresh_token"] == [self.refresh_token]
                self.refresh_token = "consumed"
                if self.failure == "network":
                    raise OSError("credential-bearing upstream failure")
                if self.failure == "revoked":
                    return HTTPResponse(
                        request, 400, buffer=io.BytesIO(b'{"error":"invalid_grant"}')
                    )
            else:
                assert values == {
                    "grant_type": ["authorization_code"],
                    "client_id": [CLIENT_ID],
                    "code": ["private-code"],
                    "code_verifier": ["private-verifier"],
                    "redirect_uri": [AUTH_BASE + "/deviceauth/callback"],
                }
            self.sequence += 1
            self.refresh_token = f"refresh-{self.sequence}"
            code, data = (
                200,
                {
                    "access_token": jwt(
                        self.account_id, self.clock() + 3600, self.sequence
                    ),
                    "refresh_token": self.refresh_token,
                    "expires_in": 3600,
                },
            )
        return HTTPResponse(request, code, buffer=io.BytesIO(json.dumps(data).encode()))


class OpenAITest(unittest.IsolatedAsyncioTestCase):
    def __init__(self, methodName: str = "runTest") -> None:
        super().__init__(methodName)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory: Path = Path(temporary.name) / "openai"
        self.clock: Clock = Clock()
        self.oauth: CodexOAuth = CodexOAuth(self.clock)
        self.authorization: Authorization = self.reopen()

    def reopen(self) -> Authorization:
        return Authorization(
            self.directory, OpenAI(self.oauth.fetch, self.clock, self.clock.sleep)
        )

    async def access(self, authorization: Authorization | None = None) -> str:
        async with (authorization or self.authorization).lease(ALICE) as token:
            return token

    async def test_protocol_persistence_refresh_and_owner_isolation(self) -> None:
        shown: list[Device] = []
        self.oauth.polls.extend(
            [
                (403, {}),
                (429, {"error": "slow_down"}),
                (400, {"error": {"code": "deviceauth_authorization_pending"}}),
            ]
        )
        await self.authorization.login(ALICE, shown.append)
        self.assertEqual(self.clock.sleeps, [1, 1, 6, 6])
        self.assertEqual(len(shown), 1)
        self.assertEqual(shown[0].verification_uri, VERIFICATION_URI)
        status = await self.reopen().status(ALICE)
        self.assertEqual(status.state, "usable")
        self.assertEqual(status.account_id, "account-alice")
        self.assertIsNone(status.refresh_expires_at)
        self.assertIsNone(status.user_id)
        self.assertEqual((await self.authorization.status(BOB)).state, "not-enrolled")
        self.assertEqual(stat.S_IMODE(self.directory.stat().st_mode), 0o700)
        for path in self.directory.iterdir():
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        first = await self.access()
        self.clock.now += 3400
        # Independent stores exercise the cross-process flock, not a shared cache.
        tokens = await asyncio.gather(*(self.access(self.reopen()) for _ in range(5)))
        self.assertEqual(len(set(tokens)), 1)
        self.assertNotEqual(tokens[0], first)
        self.assertEqual(self.oauth.refreshes, 1)
        self.assertEqual(await self.access(self.reopen()), tokens[0])
        await self.authorization.logout(ALICE)
        self.assertEqual((await self.reopen().status(ALICE)).state, "not-enrolled")
        with self.assertRaises(AuthError):
            _ = await self.access()

    async def test_failed_cancelled_and_expired_enrollment_preserve_credentials(
        self,
    ) -> None:
        await self.authorization.login(ALICE, lambda _: None)
        before = await self.access()
        self.oauth.polls.append((400, {"error": "access_denied"}))
        with self.assertRaises(AuthError):
            await self.authorization.login(ALICE, lambda _: None)
        self.assertEqual(await self.access(), before)

        def cancel(_: Device) -> None:
            raise asyncio.CancelledError

        with self.assertRaises(asyncio.CancelledError):
            await self.authorization.login(ALICE, cancel)
        self.assertEqual(await self.access(), before)

        def expire(device: Device) -> None:
            self.clock.now = device.expires_at

        with self.assertRaises(AuthError):
            await self.authorization.login(ALICE, expire)
        self.assertEqual(await self.access(), before)

    async def test_uncertain_refresh_is_not_replayed_and_identity_cannot_change(
        self,
    ) -> None:
        for failure in ("network", "revoked", "identity"):
            with self.subTest(failure=failure):
                self.oauth.failure = None
                self.oauth.account_id = "account-alice"
                await self.authorization.login(ALICE, lambda _: None)
                self.clock.now += 3600
                self.oauth.failure = failure
                if failure == "identity":
                    self.oauth.account_id = "account-bob"
                with self.assertRaises(AuthError):
                    _ = await self.access()
                calls = self.oauth.refreshes
                self.assertEqual(
                    (await self.reopen().status(ALICE)).state,
                    "reauthorization-required",
                )
                with self.assertRaises(AuthError):
                    _ = await self.access(self.reopen())
                self.assertEqual(self.oauth.refreshes, calls)

    async def test_malformed_responses_never_commit_credentials(self) -> None:
        for field, value in [
            ("access_token", "not-a-jwt"),
            ("access_token", jwt("", self.clock() + 3600, 1)),
            ("access_token", jwt("account-alice", self.clock() - 1, 1)),
            ("refresh_token", ""),
            ("expires_in", True),
            ("expires_in", -1),
        ]:
            with self.subTest(field=field, value=value):

                async def fetch(
                    request: HTTPRequest, field: str = field, value: object = value
                ) -> HTTPResponse:
                    response = await self.oauth.fetch(request)
                    if request.url == AUTH_BASE + "/oauth/token":
                        data = object_value(cast(object, json.loads(response.body)))
                        data[field] = value
                        return HTTPResponse(
                            request, 200, buffer=io.BytesIO(json.dumps(data).encode())
                        )
                    return response

                auth = Authorization(
                    self.directory, OpenAI(fetch, self.clock, self.clock.sleep)
                )
                with self.assertRaises(AuthError):
                    await auth.login(ALICE, lambda _: None)
                self.assertEqual((await auth.status(ALICE)).state, "not-enrolled")

    async def test_socket_exports_only_access_token_and_browser_cannot_request_it(
        self,
    ) -> None:
        root = self.directory.parent
        oauth = OAuth(self.clock)
        github_auth = Authorization(root / "github", github(oauth, self.clock))
        github_control = Control(github_auth, Account("alice", 1))
        refreshing = asyncio.Event()
        resume = asyncio.Event()
        resume.set()

        async def fetch(request: HTTPRequest) -> HTTPResponse:
            if request.url == AUTH_BASE + "/oauth/token" and parse_qs(
                (request.body or b"").decode()
            ).get("grant_type") == ["refresh_token"]:
                refreshing.set()
                _ = await resume.wait()
            return await self.oauth.fetch(request)

        openai_control = Control(
            Authorization(self.directory, OpenAI(fetch, self.clock, self.clock.sleep)),
            ALICE,
        )
        listener = bind_unix_socket(str(root / "alice.sock"), mode=0o600)
        server = control_server(github_control, listener, openai_control)
        self.addAsyncCleanup(server.close_all_connections)
        self.addAsyncCleanup(openai_control.close)
        self.addAsyncCleanup(github_control.close)
        self.addCleanup(server.stop)

        async def call(
            method: str,
            path: str,
            headers: dict[str, str] | None = None,
            body: str | None = None,
        ) -> tuple[int, dict[str, object] | None]:
            def exchange() -> tuple[int, dict[str, object] | None]:
                connection = http.client.HTTPConnection("localhost", timeout=5)
                connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                _ = connection.sock.connect(str(root / "alice.sock"))
                try:
                    connection.request(method, path, body=body, headers=headers or {})
                    response = connection.getresponse()
                    data = response.read()
                    if response.status == 200:
                        self.assertEqual(
                            response.getheader("Cache-Control"), "no-store"
                        )
                    return response.status, object_value(
                        cast(object, json.loads(data))
                    ) if response.status == 200 else None
                finally:
                    connection.close()

            return await asyncio.to_thread(exchange)

        self.assertEqual(await call("POST", "/openai/login"), (204, None))
        async with asyncio.timeout(5):
            while True:
                code, status = await call("GET", "/openai/status")
                assert status is not None
                if status["state"] != "authorizing":
                    break
                await asyncio.sleep(0)
        self.assertEqual(code, 200)
        self.assertEqual(
            status,
            {
                "state": "usable",
                "user_id": None,
                "account_id": "account-alice",
                "expires_at": self.clock() + 3600,
                "refresh_expires_at": None,
                "device": None,
                "error": None,
            },
        )
        code, credential = await call("POST", "/openai/token")
        self.assertEqual(code, 200)
        self.assertEqual(
            credential,
            {
                "access_token": await self.access(),
                "expires_at": self.clock() + 3600,
                "account_id": "account-alice",
            },
        )
        self.assertEqual(
            (await github_auth.status(Account("alice", 1))).state, "not-enrolled"
        )
        for method, path, headers, body, expected in [
            ("GET", "/openai/token", None, None, 405),
            ("POST", "/token", None, None, 404),
            ("POST", "/openai/token", {"Origin": "https://example.com"}, None, 403),
            ("POST", "/openai/token?user=bob", None, None, 400),
            ("POST", "/openai/token", None, '{"user":"bob"}', 400),
        ]:
            self.assertEqual((await call(method, path, headers, body))[0], expected)
        self.clock.now += 3600
        code, renewed = await call("POST", "/openai/token")
        self.assertEqual(code, 200)
        self.assertNotEqual(credential, renewed)
        self.assertEqual(self.oauth.refreshes, 1)
        # A disconnected Pi request must not cancel an in-flight rotation and
        # discard the new refresh token. The HTTP handler owns that operation.
        self.clock.now += 3600
        refreshing.clear()
        resume.clear()
        _, writer = await asyncio.open_unix_connection(str(root / "alice.sock"))
        writer.write(
            b"POST /openai/token HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n"
        )
        await writer.drain()
        _ = await asyncio.wait_for(refreshing.wait(), 5)
        writer.close()
        await writer.wait_closed()
        resume.set()
        async with asyncio.timeout(5):
            while (await self.reopen().status(ALICE)).state != "usable":
                await asyncio.sleep(0)
        self.assertEqual(self.oauth.refreshes, 2)
        _ = await self.access(self.reopen())
        self.assertEqual(self.oauth.refreshes, 2)
        self.assertEqual(await call("POST", "/openai/logout"), (204, None))
        self.assertEqual(await call("POST", "/openai/token"), (503, None))

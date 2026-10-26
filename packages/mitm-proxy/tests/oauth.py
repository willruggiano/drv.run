import asyncio
import io
import json
import time
from collections import deque
from collections.abc import Callable
from urllib.parse import parse_qs, urlsplit

from auth import Account, Authorization, Device, GitHub
from tornado.httpclient import HTTPRequest, HTTPResponse


class Clock:
    def __init__(self) -> None:
        self.now: float = 1800000000
        self.sleeps: list[float] = []

    def __call__(self) -> float:
        return self.now

    async def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds
        await asyncio.sleep(0)


class OAuth:
    """GitHub's HTTP contract with single-use refresh tokens and repository grants."""

    def __init__(self, clock: Callable[[], float] = time.time) -> None:
        self.clock: Callable[[], float] = clock
        self.identity: int = 1
        self.sequence: int = 0
        self.devices: dict[str, int] = {}
        self.access: dict[str, tuple[int, float]] = {}
        self.refresh: dict[str, tuple[int, str]] = {}
        self.requests: list[HTTPRequest] = []
        self.poll_errors: deque[str] = deque()
        self.grants: dict[int, dict[str, bool]] = {
            1: {"alice": True, "company": True},
            2: {"bob": True, "readonly": False},
        }

    def issue(self, user: int) -> dict[str, object]:
        self.sequence += 1
        token = f"ghu_token{self.sequence}"
        refresh = f"ghr_token{self.sequence}"
        self.access[token] = (user, self.clock() + 28800)
        self.refresh[refresh] = (user, token)
        return {
            "access_token": token,
            "refresh_token": refresh,
            "expires_in": 28800,
            "refresh_token_expires_in": 15897600,
            "token_type": "bearer",
        }

    def revoke(self, user: int) -> None:
        self.access = {
            key: value for key, value in self.access.items() if value[0] != user
        }
        self.refresh = {
            key: value for key, value in self.refresh.items() if value[0] != user
        }

    def permitted(self, token: str, owner: str, write: bool) -> bool:
        identity = self.access.get(token)
        if identity is None or identity[1] <= self.clock():
            return False
        grant = self.grants.get(identity[0], {}).get(owner)
        return grant is not None and (not write or grant)

    async def fetch(self, request: HTTPRequest) -> HTTPResponse:
        self.requests.append(request)
        code, data = self.respond(request)
        return HTTPResponse(request, code, buffer=io.BytesIO(json.dumps(data).encode()))

    def respond(self, request: HTTPRequest) -> tuple[int, dict[str, object]]:
        url = urlsplit(request.url)
        assert not url.query
        values = parse_qs((request.body or b"").decode())
        if url.path == "/login/device/code":
            assert values == {"client_id": ["test-app"], "scope": ["offline_access"]}
            device = f"device{len(self.devices)}"
            self.devices[device] = self.identity
            return 200, {
                "device_code": device,
                "user_code": "ABCD-EFGH",
                "verification_uri": "https://github.com/login/device",
                "interval": 1,
                "expires_in": 900,
            }
        if url.path == "/user":
            token = request.headers["Authorization"].removeprefix("Bearer ")
            identity = self.access.get(token)
            return (200, {"id": identity[0]}) if identity else (401, {})
        assert url.path == "/login/oauth/access_token"
        assert values["client_id"] == ["test-app"]
        if values["grant_type"] == ["refresh_token"]:
            identity = self.refresh.pop(values["refresh_token"][0], None)
            if identity is None:
                return 200, {"error": "bad_refresh_token"}
            user, old = identity
            del self.access[old]
            return 200, self.issue(user)
        assert values["grant_type"] == ["urn:ietf:params:oauth:grant-type:device_code"]
        if self.poll_errors:
            return 200, {"error": self.poll_errors.popleft()}
        user = self.devices.pop(values["device_code"][0])
        return 200, self.issue(user)


async def enroll(authorization: Authorization, oauth: OAuth, account: Account) -> None:
    assert account.user_id is not None
    oauth.identity = account.user_id

    def show(device: Device) -> None:
        assert device.verification_uri == "https://github.com/login/device"

    await authorization.login(account, show)


def github(oauth: OAuth, clock: Clock) -> GitHub:
    return GitHub("test-app", oauth.fetch, clock, clock.sleep)

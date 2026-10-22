import asyncio
import fcntl
import json
import math
import os
import re
import stat
import tempfile
import time
from collections.abc import AsyncGenerator, Awaitable, Callable, Mapping
from contextlib import asynccontextmanager
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Literal, cast
from urllib.parse import urlencode

from tornado.httpclient import (
    AsyncHTTPClient,
    HTTPClientError,
    HTTPRequest,
    HTTPResponse,
)
from tornado.simple_httpclient import SimpleAsyncHTTPClient

Status = Literal[
    "not-enrolled", "usable", "temporarily-unavailable", "reauthorization-required"
]


class AuthError(Exception):
    def __init__(self, state: Status) -> None:
        # Safe for the terminal and proxy logs: never include upstream content.
        super().__init__(state)
        self.state: Status = state


def object_value(value: object) -> dict[str, object]:
    if not isinstance(value, dict):
        raise TypeError("expected object")
    result: dict[str, object] = {}
    for key, item in cast(dict[object, object], value).items():
        if not isinstance(key, str):
            raise TypeError("expected string key")
        result[key] = item
    return result


def text(data: Mapping[str, object], key: str) -> str:
    value = data[key]
    if not isinstance(value, str) or not value or len(value) > 4096:
        raise ValueError("expected nonempty string")
    return value


def integer(data: Mapping[str, object], key: str) -> int:
    value = data[key]
    if type(value) is not int or not 0 < value < 2**63:
        raise ValueError("expected positive integer")
    return value


def timestamp(data: Mapping[str, object], key: str) -> float:
    value = data[key]
    if type(value) not in (int, float) or not 0 < cast(int | float, value) < 2**63:
        raise ValueError("expected timestamp")
    result = float(cast(int | float, value))
    if not math.isfinite(result) or result <= 0:
        raise ValueError("expected finite timestamp")
    return result


@dataclass(frozen=True, repr=False)
class Device:
    code: str
    user_code: str
    verification_uri: str
    expires_at: float
    interval: int


@dataclass(frozen=True, repr=False)
class Tokens:
    access_token: str
    refresh_token: str
    expires_at: float
    refresh_expires_at: float

    @staticmethod
    def response(data: Mapping[str, object], now: float) -> "Tokens":
        if text(data, "token_type") != "bearer":
            raise ValueError("expected bearer token")
        access = text(data, "access_token")
        refresh = text(data, "refresh_token")
        if not re.fullmatch(r"ghu_[A-Za-z0-9_]+", access) or not re.fullmatch(
            r"ghr_[A-Za-z0-9_]+", refresh
        ):
            raise ValueError("expected GitHub App tokens")
        return Tokens(
            access,
            refresh,
            now + integer(data, "expires_in"),
            now + integer(data, "refresh_token_expires_in"),
        )


class GitHub:
    def __init__(
        self,
        client_id: str,
        fetch: Callable[[HTTPRequest], Awaitable[HTTPResponse]],
        clock: Callable[[], float] = time.time,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self.client_id: str = client_id
        self.fetch: Callable[[HTTPRequest], Awaitable[HTTPResponse]] = fetch
        self.clock: Callable[[], float] = clock
        self.sleep: Callable[[float], Awaitable[None]] = sleep

    async def request(
        self, url: str, data: Mapping[str, str] | None = None, token: str | None = None
    ) -> dict[str, object]:
        headers = {"Accept": "application/json", "User-Agent": "drv.run"}
        if token is not None:
            headers["Authorization"] = "Bearer " + token
        body = None
        if data is not None:
            headers["Content-Type"] = "application/x-www-form-urlencoded"
            body = urlencode(data)
        try:
            response = await self.fetch(
                HTTPRequest(
                    url,
                    method="POST" if data is not None else "GET",
                    headers=headers,
                    body=body,
                    follow_redirects=False,
                    connect_timeout=10,
                    request_timeout=20,
                )
            )
            if response.code == 401:
                raise AuthError("reauthorization-required")
            if response.code != 200 or len(response.body) > 65536:
                raise AuthError("temporarily-unavailable")
            return object_value(cast(object, json.loads(response.body)))
        except (HTTPClientError, OSError, ValueError, TypeError, KeyError):
            raise AuthError("temporarily-unavailable") from None

    async def device(self) -> Device:
        data = await self.request(
            "https://github.com/login/device/code",
            {"client_id": self.client_id, "scope": "offline_access"},
        )
        try:
            uri = text(data, "verification_uri")
            if uri != "https://github.com/login/device":
                raise ValueError("unexpected verification origin")
            user_code = text(data, "user_code")
            if not re.fullmatch(r"[A-Z0-9]{4}-[A-Z0-9]{4}", user_code):
                raise ValueError("invalid user code")
            return Device(
                text(data, "device_code"),
                user_code,
                uri,
                self.clock() + integer(data, "expires_in"),
                integer(data, "interval"),
            )
        except (ValueError, TypeError, KeyError):
            raise AuthError("temporarily-unavailable") from None

    async def authorize(self, device: Device, user_id: int) -> Tokens:
        interval = device.interval
        while self.clock() + interval < device.expires_at:
            await self.sleep(interval)
            if self.clock() >= device.expires_at:
                break
            data = await self.request(
                "https://github.com/login/oauth/access_token",
                {
                    "client_id": self.client_id,
                    "device_code": device.code,
                    "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                },
            )
            error = data.get("error")
            if error == "authorization_pending":
                continue
            if error == "slow_down":
                interval += 5
                returned = data.get("interval")
                if type(returned) is int and returned > interval:
                    interval = returned
                continue
            if error is not None:
                raise AuthError("reauthorization-required")
            try:
                tokens = Tokens.response(data, self.clock())
                identity = await self.request(
                    "https://api.github.com/user", token=tokens.access_token
                )
                if integer(identity, "id") != user_id:
                    raise AuthError("reauthorization-required")
                return tokens
            except (ValueError, TypeError, KeyError):
                raise AuthError("temporarily-unavailable") from None
        raise AuthError("reauthorization-required")

    async def refresh(self, token: str) -> Tokens:
        data = await self.request(
            "https://github.com/login/oauth/access_token",
            {
                "client_id": self.client_id,
                "grant_type": "refresh_token",
                "refresh_token": token,
            },
        )
        if data.get("error") in ("bad_refresh_token", "invalid_grant", "expired_token"):
            raise AuthError("reauthorization-required")
        try:
            return Tokens.response(data, self.clock())
        except (ValueError, TypeError, KeyError):
            raise AuthError("temporarily-unavailable") from None


@dataclass(frozen=True)
class Account:
    name: str
    user_id: int

    def __post_init__(self) -> None:
        if (
            not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.-]*", self.name)
            or self.user_id <= 0
        ):
            raise ValueError("invalid account")


@dataclass(frozen=True)
class AccountStatus:
    state: Status
    user_id: int
    expires_at: float | None = None
    refresh_expires_at: float | None = None


class Authorization:
    def __init__(self, directory: Path, github: GitHub) -> None:
        self.directory: Path = directory
        self.github: GitHub = github

    @asynccontextmanager
    async def locked(
        self, account: Account, *, shared: bool = False
    ) -> AsyncGenerator[None]:
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = self.directory.stat()
        if stat.S_IMODE(info.st_mode) != 0o700 or info.st_uid != os.geteuid():
            raise AuthError("temporarily-unavailable")
        # flock is per open-file description, including across processes. A
        # short admission lock prevents new readers from starving a writer that
        # is waiting for active transfers to drain. Never unlink either lock.
        flags = os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW
        fd = os.open(self.directory / (account.name + ".lock"), flags, 0o600)
        try:
            admission = os.open(
                self.directory / (account.name + ".admission"), flags, 0o600
            )
            try:
                async with asyncio.timeout(30):
                    for descriptor, mode in [
                        (admission, fcntl.LOCK_EX),
                        (fd, fcntl.LOCK_SH if shared else fcntl.LOCK_EX),
                    ]:
                        while True:
                            try:
                                fcntl.flock(descriptor, mode | fcntl.LOCK_NB)
                                break
                            except BlockingIOError:
                                await asyncio.sleep(0.05)
            finally:
                os.close(admission)
            yield
        except TimeoutError:
            raise AuthError("temporarily-unavailable") from None
        finally:
            os.close(fd)

    def load(self, account: Account) -> Tokens:
        try:
            path = self.directory / (account.name + ".json")
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd) as file:
                info = os.fstat(file.fileno())
                if (
                    stat.S_IMODE(info.st_mode) != 0o600
                    or info.st_uid != os.geteuid()
                    or info.st_size > 16384
                ):
                    raise ValueError("unsafe state")
                data = object_value(cast(object, json.load(file)))
            if (
                integer(data, "version") != 1
                or data.get("client_id") != self.github.client_id
                or integer(data, "user_id") != account.user_id
                or data.get("refreshing") is True
            ):
                raise AuthError("reauthorization-required")
            tokens = Tokens(
                text(data, "access_token"),
                text(data, "refresh_token"),
                timestamp(data, "expires_at"),
                timestamp(data, "refresh_expires_at"),
            )
            if not re.fullmatch(
                r"ghu_[A-Za-z0-9_]+", tokens.access_token
            ) or not re.fullmatch(r"ghr_[A-Za-z0-9_]+", tokens.refresh_token):
                raise ValueError("invalid token state")
            return tokens
        except FileNotFoundError:
            raise AuthError("not-enrolled") from None
        except (ValueError, TypeError, KeyError):
            raise AuthError("reauthorization-required") from None

    def save(
        self, account: Account, tokens: Tokens, *, refreshing: bool = False
    ) -> None:
        data = {
            **asdict(tokens),
            "version": 1,
            "client_id": self.github.client_id,
            "user_id": account.user_id,
            "refreshing": refreshing,
        }
        fd, name = tempfile.mkstemp(dir=self.directory, prefix=".token-")
        temporary = Path(name)
        try:
            with os.fdopen(fd, "w") as file:
                json.dump(data, file)
                file.flush()
                os.fsync(file.fileno())
            _ = temporary.replace(self.directory / (account.name + ".json"))
            self.sync()
        finally:
            temporary.unlink(missing_ok=True)

    def sync(self) -> None:
        fd = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    async def reject(self, account: Account, token: str) -> None:
        # Release the request's shared lease before calling this. A delayed 401
        # must not invalidate a replacement installed by another request/login.
        async with self.locked(account):
            try:
                current = self.load(account)
            except AuthError:
                return  # Already logged out or invalidated.
            if current.access_token == token:
                self.save(account, current, refreshing=True)

    async def login(self, account: Account, show: Callable[[Device], None]) -> None:
        # Serialize the whole enrollment with logout and renewal. A failed or
        # cancelled enrollment leaves the previous pair untouched.
        async with self.locked(account):
            device = await self.github.device()
            show(device)
            tokens = await self.github.authorize(device, account.user_id)
            self.save(account, tokens)

    async def logout(self, account: Account) -> None:
        async with self.locked(account):
            (self.directory / (account.name + ".json")).unlink(missing_ok=True)
            self.sync()

    async def status(self, account: Account) -> AccountStatus:
        try:
            async with self.locked(account, shared=True):
                tokens = self.load(account)
                state: Status = "usable"
                if tokens.refresh_expires_at <= self.github.clock():
                    state = "reauthorization-required"
                elif tokens.expires_at <= self.github.clock():
                    state = "temporarily-unavailable"
                return AccountStatus(
                    state, account.user_id, tokens.expires_at, tokens.refresh_expires_at
                )
        except AuthError as error:
            return AccountStatus(error.state, account.user_id)
        except OSError:
            return AccountStatus("temporarily-unavailable", account.user_id)

    @asynccontextmanager
    async def lease(self, account: Account) -> AsyncGenerator[str]:
        # Transfers share a generation. Only refresh and mutations require all
        # its readers to drain, including readers in other processes.
        while True:
            async with self.locked(account, shared=True):
                tokens = self.load(account)
                now = self.github.clock()
                if tokens.refresh_expires_at <= now:
                    raise AuthError("reauthorization-required")
                if tokens.expires_at > now + 60:
                    yield tokens.access_token
                    return
            # Do not upgrade a shared flock: conversion is not atomic. Recheck
            # after acquiring exclusive access, then reacquire/read under SH so
            # intervening logout/login cannot leave us forwarding a stale token.
            async with self.locked(account):
                tokens = self.load(account)
                now = self.github.clock()
                if tokens.refresh_expires_at <= now:
                    raise AuthError("reauthorization-required")
                if tokens.expires_at <= now + 60:
                    # Persist intent BEFORE consuming a single-use refresh token.
                    self.save(account, tokens, refreshing=True)
                    tokens = await self.github.refresh(tokens.refresh_token)
                    self.save(account, tokens)


def http_client() -> AsyncHTTPClient:
    # This implementation does not use environment proxy settings. Its bounded
    # body parser also limits responses before JSON decoding.
    return SimpleAsyncHTTPClient(
        force_instance=True, max_body_size=65536, max_buffer_size=65536
    )

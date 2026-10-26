"""Codex device OAuth, matching pi-ai 1.4.0's openai-codex provider."""

import asyncio
import base64
import binascii
import json
import re
import time
from collections.abc import Awaitable, Callable, Mapping
from typing import cast
from urllib.parse import urlencode

from auth import AuthError, Device, Tokens, integer, object_value, text
from tornado.httpclient import HTTPClientError, HTTPRequest, HTTPResponse

AUTH_BASE = "https://auth.openai.com"
VERIFICATION_URI = AUTH_BASE + "/codex/device"
CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"


def identity(token: str) -> tuple[str, int]:
    # Tokens come from the fixed, TLS-verified OAuth endpoint, never a caller.
    # Decode metadata here; this is not a substitute for JWT signature validation.
    parts = token.split(".")
    if len(parts) != 3 or not all(
        re.fullmatch(r"[A-Za-z0-9_-]+", part) for part in parts
    ):
        raise ValueError("invalid access token")
    payload = object_value(
        cast(
            object,
            json.loads(base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4))),
        )
    )
    account = text(
        object_value(payload["https://api.openai.com/auth"]), "chatgpt_account_id"
    )
    return account, integer(payload, "exp")


class OpenAI:
    def __init__(
        self,
        fetch: Callable[[HTTPRequest], Awaitable[HTTPResponse]],
        clock: Callable[[], float] = time.time,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self.client_id: str = CLIENT_ID
        self.refresh_margin: int = 300
        self.fetch: Callable[[HTTPRequest], Awaitable[HTTPResponse]] = fetch
        self.clock: Callable[[], float] = clock
        self.sleep: Callable[[float], Awaitable[None]] = sleep

    async def request(
        self, path: str, data: Mapping[str, str], *, form: bool = False
    ) -> tuple[int, dict[str, object]]:
        try:
            response = await self.fetch(
                HTTPRequest(
                    AUTH_BASE + path,
                    method="POST",
                    headers={
                        "Content-Type": "application/x-www-form-urlencoded"
                        if form
                        else "application/json"
                    },
                    body=urlencode(data) if form else json.dumps(data),
                    follow_redirects=False,
                    connect_timeout=10,
                    request_timeout=20,
                )
            )
            if len(response.body) > 65536:
                raise ValueError("oversized response")
            # pi-ai treats 403/404 from the poll endpoint as pending, including
            # responses without JSON bodies.
            if path == "/api/accounts/deviceauth/token" and response.code in (403, 404):
                return response.code, {}
            value = (
                object_value(cast(object, json.loads(response.body)))
                if response.body
                else {}
            )
            return response.code, value
        except (HTTPClientError, OSError, ValueError, TypeError):
            # Upstream errors and HTTPRequest objects may contain credentials.
            raise AuthError("temporarily-unavailable") from None

    async def device(self) -> Device:
        code, data = await self.request(
            "/api/accounts/deviceauth/usercode", {"client_id": self.client_id}
        )
        if code != 200:
            raise AuthError("temporarily-unavailable")
        try:
            interval = data["interval"]
            if isinstance(interval, str) and interval.isdecimal():
                interval = int(interval)
            if type(interval) is not int or not 0 <= interval <= 900:
                raise ValueError("invalid interval")
            user_code = text(data, "user_code")
            if not re.fullmatch(r"[A-Za-z0-9-]{4,32}", user_code):
                raise ValueError("invalid user code")
            return Device(
                text(data, "device_auth_id"),
                user_code,
                VERIFICATION_URI,
                self.clock() + 900,
                max(1, interval),
            )
        except (ValueError, TypeError, KeyError):
            raise AuthError("temporarily-unavailable") from None

    async def authorize(self, device: Device, user_id: int | None) -> Tokens:
        if user_id is not None:
            raise AuthError("reauthorization-required")
        interval = device.interval
        while self.clock() + interval < device.expires_at:
            await self.sleep(interval)
            if self.clock() >= device.expires_at:
                break
            code, data = await self.request(
                "/api/accounts/deviceauth/token",
                {"device_auth_id": device.code, "user_code": device.user_code},
            )
            if code == 200:
                try:
                    return await self.exchange(
                        {
                            "grant_type": "authorization_code",
                            "code": text(data, "authorization_code"),
                            "code_verifier": text(data, "code_verifier"),
                            "redirect_uri": AUTH_BASE + "/deviceauth/callback",
                        }
                    )
                except (ValueError, TypeError, KeyError):
                    raise AuthError("temporarily-unavailable") from None
            error = data.get("error")
            if isinstance(error, dict):
                error = object_value(cast(object, error)).get("code")
            if error == "slow_down":
                interval += 5
            elif code in (403, 404) or error == "deviceauth_authorization_pending":
                continue
            else:
                raise AuthError(
                    "temporarily-unavailable"
                    if code >= 500
                    else "reauthorization-required"
                )
        raise AuthError("reauthorization-required")

    async def exchange(self, data: Mapping[str, str]) -> Tokens:
        code, value = await self.request(
            "/oauth/token", {**data, "client_id": self.client_id}, form=True
        )
        if code != 200:
            raise AuthError(
                "reauthorization-required"
                if code in (400, 401, 403)
                else "temporarily-unavailable"
            )
        try:
            access = text(value, "access_token", 16384)
            account_id, expiry = identity(access)
            tokens = Tokens(
                access,
                text(value, "refresh_token"),
                min(self.clock() + integer(value, "expires_in"), expiry),
                account_id=account_id,
            )
            self.validate(tokens)
            if tokens.expires_at <= self.clock() + self.refresh_margin:
                raise ValueError("access token expires too soon")
            return tokens
        except (ValueError, TypeError, KeyError, binascii.Error):
            raise AuthError("temporarily-unavailable") from None

    async def refresh(self, token: str) -> Tokens:
        return await self.exchange(
            {"grant_type": "refresh_token", "refresh_token": token}
        )

    def validate(self, tokens: Tokens) -> None:
        account_id, expiry = identity(tokens.access_token)
        if (
            tokens.account_id != account_id
            or tokens.expires_at > expiry
            or tokens.refresh_expires_at is not None
        ):
            raise ValueError("invalid OpenAI token state")

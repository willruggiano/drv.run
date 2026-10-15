import asyncio
import base64
import json
import os
import ssl
import sys
from contextlib import suppress
from pathlib import Path
from typing import cast
from urllib.parse import urlsplit

from auth import object_value, text
from cryptography import x509
from cryptography.hazmat.primitives import serialization
from main import CertificateAuthority
from mitmproxy.certs import CertStore
from tornado.httpclient import HTTPRequest
from tornado.httputil import HTTPHeaders

from .oauth import OAuth


def certificate_authority(directory: Path) -> CertificateAuthority:
    _ = CertStore.from_store(directory, "fixture", 2048)
    return CertificateAuthority(
        (directory / "fixture-ca-cert.pem").read_text(),
        directory / "fixture-ca.pem",
    )


def certificate(directory: Path) -> ssl.SSLContext:
    store = CertStore.from_store(directory, "upstream", 2048)
    entry = store.get_cert(
        "github.com",
        [
            x509.DNSName(host)
            for host in (
                "github.com",
                "api.github.com",
                "example.test",
                "api.github.com.evil.test",
            )
        ],
    )
    cert = directory / "server.pem"
    key = directory / "server.key"
    _ = cert.write_bytes(entry.cert.to_pem())
    _ = key.write_bytes(
        entry.privatekey.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    return context


class Fixture:
    def __init__(self, root: Path, oauth: OAuth) -> None:
        self.root: Path = root
        self.oauth: OAuth = oauth
        self.received: asyncio.Event = asyncio.Event()
        self.requests: list[tuple[str, str, str]] = []
        self.api_requests: list[HTTPRequest] = []
        self.passthrough_requests: list[HTTPRequest] = []
        self.errors: list[Exception] = []
        self.streamed: bytes | None = None

    async def handle(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        try:
            await self.request(reader, writer)
        except (ConnectionError, asyncio.IncompleteReadError):
            pass
        except Exception as error:
            self.errors.append(error)
            raise
        finally:
            writer.close()
            # Some HTTP clients reset TLS after reading Connection: close.
            with suppress(ConnectionResetError):
                await writer.wait_closed()

    async def request(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        # This fixture implements the HTTP/CGI interface, not a stdout oracle.
        head = await reader.readuntil(b"\r\n\r\n")
        request_line, *lines = head.decode("ascii").split("\r\n")
        method, target, _ = request_line.split(" ")
        headers = {
            key.lower(): value.strip()
            for key, value in (line.split(":", 1) for line in lines if line)
        }
        url = urlsplit(target)
        if url.path == "/passthrough":
            body = await reader.readexactly(int(headers.get("content-length", "0")))
            self.passthrough_requests.append(
                HTTPRequest(
                    "https://" + headers["host"] + target,
                    method=method,
                    headers=HTTPHeaders(headers),
                    body=body,
                )
            )
            writer.write(
                b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            await writer.drain()
            return
        if headers["host"] == "api.github.com" or url.path in (
            "/login/device/code",
            "/login/oauth/access_token",
        ):
            body = await reader.readexactly(int(headers.get("content-length", "0")))
            request = HTTPRequest(
                "https://" + headers["host"] + target,
                method=method,
                headers=HTTPHeaders(headers),
                body=body if method in ("POST", "PATCH") else None,
            )
            if url.path in ("/login/device/code", "/login/oauth/access_token", "/user"):
                code, data = self.oauth.respond(request)
            else:
                payload = object_value(cast(object, json.loads(body)))
                if url.path == "/graphql":
                    assert method == "POST"
                    variables = object_value(payload["variables"])
                    owner = text(variables, "owner")
                    assert text(variables, "repo") == "repo"
                    data = {
                        "data": {
                            "repository": {
                                "pullRequests": {
                                    "nodes": [
                                        {
                                            "number": 1,
                                            "title": "Test",
                                            "state": "OPEN",
                                            "url": "https://github.com/alice/repo/pull/1",
                                            "headRefName": "feature",
                                            "isCrossRepository": False,
                                            "isDraft": False,
                                            "createdAt": "2026-01-01T00:00:00Z",
                                        }
                                    ],
                                    "totalCount": 1,
                                    "pageInfo": {"hasNextPage": False, "endCursor": ""},
                                }
                            }
                        }
                    }
                else:
                    assert (
                        method == "PATCH" and url.path == "/repos/alice/repo/issues/1"
                    )
                    owner = "alice"
                    data = {"title": text(payload, "title")}
                token = headers.get("authorization", "").removeprefix("Bearer ")
                code = (
                    200
                    if self.oauth.permitted(token, owner, method == "PATCH")
                    else 403
                )
            if headers["host"] == "api.github.com" and code == 200:
                self.api_requests.append(request)
                _ = (self.root / "api-requests.json").write_text(
                    json.dumps(
                        [
                            {"method": item.method, "url": item.url}
                            for item in self.api_requests
                        ]
                    )
                )
            response = json.dumps(data).encode()
            writer.write(
                f"HTTP/1.1 {code} OK\r\nContent-Type: application/json\r\nContent-Length: {len(response)}\r\nConnection: close\r\n\r\n".encode()
                + response
            )
            await writer.drain()
            return
        authorization = headers.get("authorization", "")
        token = ""
        if authorization.startswith("Basic "):
            user, token = (
                base64.b64decode(authorization.removeprefix("Basic "))
                .decode()
                .split(":", 1)
            )
            if user != "x-access-token":
                token = ""
        owner = url.path.split("/")[1]
        write = "git-receive-pack" in target
        if not self.oauth.permitted(token, owner, write):
            code = 401 if token not in self.oauth.access else 403
            challenge = (
                'WWW-Authenticate: Basic realm="GitHub"\r\n' if code == 401 else ""
            )
            writer.write(
                f"HTTP/1.1 {code} Denied\r\n{challenge}Content-Length: 0\r\nConnection: close\r\n\r\n".encode()
            )
            await writer.drain()
            return
        self.requests.append((owner, method, target))
        _ = (self.root / "requests.json").write_text(json.dumps(self.requests))
        body = bytearray()
        if headers.get("transfer-encoding") == "chunked":
            while True:
                size = int((await reader.readline()).strip(), 16)
                if not size:
                    _ = await reader.readline()
                    break
                body.extend(await reader.readexactly(size))
                self.received.set()
                assert await reader.readexactly(2) == b"\r\n"
        else:
            remaining = int(headers.get("content-length", "0"))
            while remaining:
                chunk = await reader.read(min(remaining, 65536))
                assert chunk
                body.extend(chunk)
                remaining -= len(chunk)
                self.received.set()
        if url.path == f"/{owner}/stream.git/git-receive-pack":
            self.streamed = bytes(body)
            writer.write(
                b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            await writer.drain()
            return
        if url.path == f"/{owner}/redirect.git/info/refs":
            writer.write(
                b"HTTP/1.1 302 Found\r\nLocation: https://other.test/alice/repo.git/info/refs?service=git-upload-pack\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            await writer.drain()
            return
        environment = {
            **os.environ,
            "GIT_PROJECT_ROOT": str(self.root),
            "GIT_HTTP_EXPORT_ALL": "1",
            "PATH_INFO": url.path,
            "QUERY_STRING": url.query,
            "REQUEST_METHOD": method,
            "CONTENT_TYPE": headers.get("content-type", ""),
            "CONTENT_LENGTH": str(len(body)),
            "REMOTE_USER": owner,
            "REMOTE_ADDR": "127.0.0.1",
            "GIT_PROTOCOL": headers.get("git-protocol", ""),
        }
        process = await asyncio.create_subprocess_exec(
            "git",
            "http-backend",
            env=environment,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
        )
        output, _ = await process.communicate(bytes(body))
        assert process.returncode == 0
        cgi_headers, content = output.split(b"\r\n\r\n", 1)
        status = b"200 OK"
        response_headers: list[bytes] = []
        for line in cgi_headers.split(b"\r\n"):
            if line.lower().startswith(b"status:"):
                status = line.split(b":", 1)[1].strip()
            else:
                response_headers.append(line)
        writer.write(
            b"HTTP/1.1 "
            + status
            + b"\r\n"
            + b"\r\n".join(response_headers)
            + f"\r\nContent-Length: {len(content)}\r\nConnection: close\r\n\r\n".encode()
            + content
        )
        await writer.drain()


async def main() -> None:
    root = Path(sys.argv[1])
    root.mkdir(parents=True, exist_ok=True)
    context = certificate(
        root / ("invalid" if (root / "invalid-certificate").exists() else "tls")
    )
    fixture = Fixture(root, OAuth())
    server = await asyncio.start_server(fixture.handle, "0.0.0.0", 443, ssl=context)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())

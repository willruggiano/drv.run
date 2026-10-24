import asyncio
import base64
import json
import os
import stat
import tempfile
import unittest
from collections.abc import Awaitable, Callable, Mapping
from contextlib import nullcontext
from pathlib import Path
from typing import cast, override
from unittest.mock import patch

from auth import Account, Authorization
from cryptography import x509
from cryptography.hazmat.primitives import serialization
from main import (
    HOST,
    CertificateAuthority,
    Owner,
    Policy,
    create_master,
    prepare,
    public_address,
    read_credentials,
    resolve_upstream,
)
from mitmproxy import connection, http
from mitmproxy.certs import CertStore
from mitmproxy.proxy.server_hooks import ServerConnectionHookData

from .fixture import certificate_authority
from .oauth import Clock, OAuth, enroll, github

ALICE = "drv_run_" + "a" * 64
BOB = "drv_run_" + "b" * 64


def policy_fixture(
    credentials: Mapping[str, Account],
    authorization: Authorization,
    resolve: Callable[[], Awaitable[str]] = resolve_upstream,
) -> Policy:
    # Policy-only tests have no TCP reader. Transport tests exercise real gates.
    return Policy(credentials, authorization, resolve, pause=lambda _: nullcontext())


def basic(password: str, username: str = "x-access-token") -> str:
    return "Basic " + base64.b64encode(f"{username}:{password}".encode()).decode()


def flow(
    path: str = "/alice/project.git/info/refs?service=git-upload-pack",
) -> http.HTTPFlow:
    client = connection.Client(peername=("10.0.0.2", 1234), sockname=("10.0.0.1", 3128))
    client.tls = True
    client.sni = HOST
    result = http.HTTPFlow(client, connection.Server(address=(HOST, 443)))
    result.live = True
    result.request = http.Request.make("GET", "https://github.com" + path)
    result.request.headers["Host"] = "github.com"
    return result


def connect(policy: Policy, request: http.HTTPFlow) -> None:
    tunnel = http.HTTPFlow(request.client_conn, request.server_conn)
    tunnel.request = http.Request.make("CONNECT", "https://github.com:443")
    tunnel.request.authority = "github.com:443"
    policy.http_connect(tunnel)
    assert tunnel.response is None


class PolicyTest(unittest.IsolatedAsyncioTestCase):
    def __init__(self, methodName: str = "runTest") -> None:
        super().__init__(methodName)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        clock = Clock()
        oauth = OAuth(clock)
        self.authorization: Authorization = Authorization(
            Path(temporary.name) / "auth", github(oauth, clock)
        )
        self.oauth: OAuth = oauth

    @override
    async def asyncSetUp(self) -> None:
        for name, user in [("alice", 1), ("bob", 2)]:
            await enroll(self.authorization, self.oauth, Account(name, user))

    async def test_credentials_are_owner_scoped_and_only_password_is_replaced(
        self,
    ) -> None:
        for placeholder, token in [(ALICE, "ghu_token1"), (BOB, "ghu_token2")]:
            with self.subTest(placeholder=placeholder):
                policy = policy_fixture(
                    {ALICE: Account("alice", 1), BOB: Account("bob", 2)},
                    self.authorization,
                )
                request = flow("/alice/project.git/git-receive-pack")
                request.request.method = "POST"
                request.request.content = placeholder.encode()
                request.request.headers["X-Example"] = placeholder
                request.request.headers["Authorization"] = basic(placeholder)
                request.request.headers["Connection"] = "Authorization"
                request.request.headers["Proxy-Authorization"] = basic(placeholder)
                connect(policy, request)
                await policy.requestheaders(request)
                await policy.response(request)
                self.assertIsNone(request.response)
                self.assertEqual(request.request.headers["Authorization"], basic(token))
                self.assertEqual(request.request.headers["X-Example"], placeholder)
                self.assertEqual(request.request.content, placeholder.encode())
                self.assertNotIn("connection", request.request.headers)
                self.assertNotIn("proxy-authorization", request.request.headers)
                self.assertTrue(request.request.stream)

    async def test_challenge_and_unknown_credentials(self) -> None:
        for headers, status in [
            ([], 401),
            ([("Authorization", basic("unknown"))], 403),
            ([("Authorization", basic(ALICE, "wrong"))], 403),
            ([("Authorization", "Bearer " + ALICE)], 403),
            ([("Authorization", "Basic !invalid!")], 403),
            ([("Authorization", "Basic dXNlcg==")], 403),
            ([("Authorization", "Basic /w==")], 403),
            ([("Authorization", basic(ALICE)), ("Authorization", basic(BOB))], 403),
        ]:
            with self.subTest(headers=headers):
                policy = policy_fixture(
                    {ALICE: Account("alice", 1)}, self.authorization
                )
                request = flow()
                connect(policy, request)
                for key, value in headers:
                    request.request.headers.set_all(
                        key, [*request.request.headers.get_all(key), value]
                    )
                await policy.requestheaders(request)
                await policy.response(request)
                assert request.response is not None
                self.assertEqual(request.response.status_code, status)
                self.assertFalse(request.request.stream)

    def test_connect_is_exact_and_cannot_be_nested(self) -> None:
        for host, port, authority in [
            ("api.github.com", 443, "api.github.com:443"),
            ("github.com", 80, "github.com:80"),
            ("127.0.0.1", 443, "127.0.0.1:443"),
            ("github.com", 443, "other.test:443"),
        ]:
            policy = policy_fixture({}, self.authorization)
            request = flow()
            request.request.host = host
            request.request.port = port
            request.request.authority = authority
            policy.http_connect(request)
            assert request.response is not None
            self.assertEqual(request.response.status_code, 403)
        policy = policy_fixture({}, self.authorization)
        request = flow()
        connect(policy, request)
        request.request.authority = "github.com:443"
        policy.http_connect(request)
        self.assertIsNotNone(request.response)
        policy.client_disconnected(request.client_conn)

    async def test_only_git_endpoints(self) -> None:
        for method, path, allowed in [
            ("GET", "/alice/repo/info/refs?service=git-upload-pack", True),
            ("GET", "/alice/repo.git/info/refs?service=git-receive-pack", True),
            ("POST", "/alice/repo.git/git-upload-pack", True),
            ("POST", "/alice/repo.git/git-receive-pack", True),
            ("GET", "/alice/repo.git/git-upload-pack", False),
            ("POST", "/alice/repo.git/info/lfs/objects/batch", False),
            ("GET", "/alice/repo.git/info/refs?service=git-upload-pack&extra=1", False),
            ("GET", "/alice/repo.git/info/refs?service=" + ALICE, False),
            ("GET", "/login", False),
        ]:
            with self.subTest(method=method, path=path):
                policy = policy_fixture(
                    {ALICE: Account("alice", 1)}, self.authorization
                )
                request = flow(path)
                request.request.method = method
                request.request.headers["Authorization"] = basic(ALICE)
                connect(policy, request)
                await policy.requestheaders(request)
                await policy.response(request)
                self.assertEqual(request.response is None, allowed)
                self.assertEqual(request.request.path, path)

    async def test_authorities_and_tls_must_agree(self) -> None:
        for change in [
            "no-connect",
            "plaintext",
            "sni",
            "host",
            "duplicate-host",
            "authority",
            "upgrade",
            "trailer",
        ]:
            with self.subTest(change=change):
                policy = policy_fixture(
                    {ALICE: Account("alice", 1)}, self.authorization
                )
                request = flow()
                if change != "no-connect":
                    connect(policy, request)
                request.request.headers["Authorization"] = basic(ALICE)
                if change == "plaintext":
                    request.client_conn.tls = False
                elif change == "sni":
                    request.client_conn.sni = "other.test"
                elif change == "host":
                    request.request.headers["host"] = "other.test"
                elif change == "duplicate-host":
                    request.request.headers.set_all(
                        "host", ["github.com", "github.com"]
                    )
                elif change == "authority":
                    request.request.authority = "other.test"
                elif change in ("upgrade", "trailer"):
                    request.request.headers[change] = "example"
                await policy.requestheaders(request)
                await policy.response(request)
                assert request.response is not None
                self.assertEqual(request.response.status_code, 403)

    async def test_concurrent_401_responses_release_leases_before_rejection(
        self,
    ) -> None:
        account = Account("alice", 1)
        policy = policy_fixture({ALICE: account}, self.authorization)
        requests = [flow(), flow()]
        async with asyncio.timeout(2):
            for request in requests:
                connect(policy, request)
                request.request.headers["Authorization"] = basic(ALICE)
                await policy.requestheaders(request)
                self.assertIsNone(request.response)
                request.response = http.Response.make(401)
            _ = await asyncio.gather(
                *(policy.response(request) for request in requests)
            )
            self.assertEqual(
                (await self.authorization.status(account)).state,
                "reauthorization-required",
            )
            await self.authorization.logout(account)

    async def test_exception_after_mutation_kills_flow(self) -> None:
        policy = policy_fixture({ALICE: Account("alice", 1)}, self.authorization)
        request = flow()
        connect(policy, request)
        request.request.headers["Authorization"] = basic(ALICE)
        original = http.Headers.set_all

        def fail(headers: http.Headers, key: str, value: str) -> None:
            original(headers, key, [value])
            if key.lower() == "authorization":
                raise RuntimeError("must not escape")

        with (
            patch.object(http.Headers, "__setitem__", fail),
            self.assertRaises(RuntimeError),
        ):
            await policy.requestheaders(request)
            await policy.response(request)
        self.assertIsNotNone(request.error)
        self.assertFalse(request.live)
        self.assertIsNotNone(request.response)


class ConnectionTest(unittest.IsolatedAsyncioTestCase):
    def __init__(self, methodName: str = "runTest") -> None:
        super().__init__(methodName)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        clock = Clock()
        self.authorization: Authorization = Authorization(
            Path(temporary.name) / "auth", github(OAuth(clock), clock)
        )

    async def test_resolved_address_is_pinned_before_connect(self) -> None:
        for address, allowed in [
            ("93.184.216.34", True),
            ("127.0.0.1", False),
            ("10.0.0.1", False),
            ("169.254.169.254", False),
            ("100.64.0.1", False),
            ("198.18.0.1", False),
            ("224.0.0.1", False),
            ("::1", False),
        ]:

            async def resolve(address: str = address) -> str:
                return address

            policy = policy_fixture({}, self.authorization, resolve)
            request = flow()
            connect(policy, request)
            request.server_conn.sni = HOST
            data = ServerConnectionHookData(request.server_conn, request.client_conn)
            if address == "::1":
                with self.assertRaises(ValueError):
                    await policy.server_connect(data)
            else:
                await policy.server_connect(data)
            self.assertEqual(data.server.error is None, allowed)
            if allowed:
                self.assertEqual(data.server.address, (address, 443))
                self.assertEqual(data.server.sni, HOST)

    async def test_resolution_failure_denies(self) -> None:
        async def resolve() -> str:
            raise OSError("DNS failed")

        policy = policy_fixture({}, self.authorization, resolve)
        request = flow()
        connect(policy, request)
        request.server_conn.sni = HOST
        data = ServerConnectionHookData(request.server_conn, request.client_conn)
        with self.assertRaises(OSError):
            await policy.server_connect(data)
        self.assertIsNotNone(data.server.error)

    async def test_missing_ca_is_not_automatically_generated(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(FileNotFoundError):
                _ = create_master(root, 0, {}, self.authorization)
            self.assertEqual(list(root.iterdir()), [])

    def test_public_address(self) -> None:
        self.assertTrue(public_address("140.82.112.3"))
        self.assertFalse(public_address("0.0.0.0"))
        self.assertFalse(public_address("240.0.0.1"))


class CredentialTest(unittest.TestCase):
    def test_publication_modes_override_restrictive_umask(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state, public = root / "state", root / "public"
            owners = [Owner("alice", 1000, 1), Owner("bob", 1001, 2)]
            ca = certificate_authority(root / "ca-source")
            previous_umask = os.umask(0o077)
            try:
                # Only ownership changes need privilege; exercise real file modes.
                with patch("main.os.chown"):
                    for _ in range(2):
                        prepare(state, public, owners, 999, ca, root / "runtime-ca")
                        for owner in owners:
                            publication = public / owner.name
                            self.assertEqual(
                                stat.S_IMODE(publication.stat().st_mode), 0o750
                            )
                            for name in ["config.yml", "hosts.yml"]:
                                self.assertEqual(
                                    stat.S_IMODE((publication / name).stat().st_mode),
                                    0o640,
                                )
                            self.assertEqual(
                                cast(
                                    object,
                                    json.loads((publication / "hosts.yml").read_text()),
                                ),
                                {
                                    "github.com": {
                                        "oauth_token": (
                                            state / ("placeholder-" + owner.name)
                                        ).read_text(),
                                        "git_protocol": "https",
                                    }
                                },
                            )
                            self.assertFalse((publication / "placeholder").exists())
                            self.assertFalse((publication / "ca.pem").exists())
                            # Restart must repair directories from the broken version.
                            publication.chmod(0o700)
                        self.assertEqual(stat.S_IMODE(public.stat().st_mode), 0o755)
                        self.assertEqual(stat.S_IMODE(state.stat().st_mode), 0o750)
                        for entry in state.iterdir():
                            self.assertEqual(stat.S_IMODE(entry.stat().st_mode), 0o640)
            finally:
                _ = os.umask(previous_umask)

    def test_ca_is_provisioned_only_in_runtime_store_and_matches_guest_trust(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ca = certificate_authority(root / "ca-source")
            state, public, runtime = (
                root / "state",
                root / "public",
                root / "runtime-ca",
            )
            with patch("main.os.chown"):
                prepare(state, public, [], 999, ca, runtime)
            store = CertStore.from_files(
                runtime / "mitmproxy-ca.pem", runtime / "mitmproxy-dhparam.pem"
            )
            certificate = x509.load_pem_x509_certificate(ca.certificate.encode())
            self.assertEqual(
                x509.load_pem_x509_certificate(store.default_ca.to_pem()), certificate
            )
            self.assertEqual(
                store.default_privatekey.public_key().public_bytes(
                    serialization.Encoding.DER,
                    serialization.PublicFormat.SubjectPublicKeyInfo,
                ),
                certificate.public_key().public_bytes(
                    serialization.Encoding.DER,
                    serialization.PublicFormat.SubjectPublicKeyInfo,
                ),
            )
            self.assertEqual(list(state.iterdir()), [])
            self.assertEqual(list(public.iterdir()), [])
            self.assertEqual(stat.S_IMODE(runtime.stat().st_mode), 0o750)
            for entry in runtime.iterdir():
                self.assertEqual(stat.S_IMODE(entry.stat().st_mode), 0o640)

    def test_missing_or_mismatched_ca_key_cannot_replace_the_active_ca(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ca = certificate_authority(root / "ca-source")
            other = certificate_authority(root / "other-ca")
            state, public, runtime = (
                root / "state",
                root / "public",
                root / "runtime-ca",
            )
            with patch("main.os.chown"):
                prepare(state, public, [], 999, ca, runtime)
                for key_file, error in [
                    (root / "missing", OSError),
                    (other.private_key_file, ValueError),
                ]:
                    with self.subTest(key_file=key_file), self.assertRaises(error):
                        prepare(
                            state,
                            public,
                            [],
                            999,
                            CertificateAuthority(ca.certificate, key_file),
                            runtime,
                        )
            store = CertStore.from_files(
                runtime / "mitmproxy-ca.pem", runtime / "mitmproxy-dhparam.pem"
            )
            self.assertEqual(
                x509.load_pem_x509_certificate(store.default_ca.to_pem()),
                x509.load_pem_x509_certificate(ca.certificate.encode()),
            )

    def test_only_configured_placeholders_are_loaded(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _ = (root / "placeholder-alice").write_text(ALICE)
            _ = (root / "placeholder-bob").write_text(BOB)
            self.assertEqual(
                read_credentials(root, [Owner("alice", 1000, 1)]),
                {ALICE: Account("alice", 1)},
            )


if __name__ == "__main__":
    _ = unittest.main()

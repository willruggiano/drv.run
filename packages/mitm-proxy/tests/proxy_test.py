import asyncio
import base64
import json
import os
import stat
import tempfile
import unittest
from collections.abc import Awaitable, Callable, Mapping
from contextlib import nullcontext
from itertools import product
from pathlib import Path
from typing import cast, override
from unittest.mock import patch

from auth import Account, Authorization
from cryptography import x509
from cryptography.hazmat.primitives import serialization
from main import (
    API_HOST,
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
    resolve: Callable[[str], Awaitable[str]] = resolve_upstream,
) -> Policy:
    # Policy-only tests have no TCP reader. Transport tests exercise real gates.
    return Policy(credentials, authorization, resolve, pause=lambda _: nullcontext())


def basic(password: str, username: str = "x-access-token") -> str:
    return "Basic " + base64.b64encode(f"{username}:{password}".encode()).decode()


def flow(
    path: str = "/alice/project.git/info/refs?service=git-upload-pack",
    host: str = HOST,
) -> http.HTTPFlow:
    client = connection.Client(peername=("10.0.0.2", 1234), sockname=("10.0.0.1", 3128))
    client.tls = True
    client.sni = host
    result = http.HTTPFlow(client, connection.Server(address=(host, 443)))
    result.live = True
    result.request = http.Request.make("GET", "https://" + host + path)
    result.request.headers["Host"] = host
    return result


def connect(policy: Policy, request: http.HTTPFlow) -> None:
    tunnel = http.HTTPFlow(request.client_conn, request.server_conn)
    host = request.request.host
    tunnel.request = http.Request.make("CONNECT", f"https://{host}:443")
    tunnel.request.authority = f"{host}:443"
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

    async def test_api_credentials_are_owner_scoped(self) -> None:
        for scheme, placeholder, token in [
            ("token", ALICE, "ghu_token1"),
            ("Bearer", BOB, "ghu_token2"),
        ]:
            for method, path in [
                ("GET", "/repos/alice/repo/pulls?state=open"),
                ("POST", "/graphql"),
                ("POST", "/repos/alice/repo/pulls"),
                ("PATCH", "/repos/alice/repo/issues/1"),
                ("PUT", "/repos/alice/repo/pulls/1/merge"),
                ("DELETE", "/repos/alice/repo/issues/1/labels/bug"),
            ]:
                with self.subTest(scheme=scheme, method=method, path=path):
                    policy = policy_fixture(
                        {ALICE: Account("alice", 1), BOB: Account("bob", 2)},
                        self.authorization,
                    )
                    request = flow(path, API_HOST)
                    request.request.method = method
                    request.request.content = placeholder.encode()
                    request.request.headers["Authorization"] = f"{scheme} {placeholder}"
                    request.request.headers["Proxy-Authorization"] = basic(placeholder)
                    request.request.headers["Connection"] = "Authorization"
                    connect(policy, request)
                    await policy.requestheaders(request)
                    self.assertIsNone(request.response)
                    self.assertEqual(
                        request.request.headers["Authorization"], "Bearer " + token
                    )
                    self.assertEqual(request.request.content, placeholder.encode())
                    self.assertEqual(request.request.path, path)
                    self.assertNotIn("proxy-authorization", request.request.headers)
                    self.assertNotIn("connection", request.request.headers)
                    self.assertTrue(request.request.stream)
                    await policy.response(request)
                    self.assertEqual(policy.leases, {})

    async def test_api_rejects_unknown_placeholders_and_duplicate_credentials(
        self,
    ) -> None:
        for headers, method, status in [
            ([("Authorization", "token " + BOB)], "GET", 403),
            (
                [
                    ("Authorization", "token " + ALICE),
                    ("Authorization", "token " + BOB),
                ],
                "GET",
                403,
            ),
        ]:
            with self.subTest(headers=headers, method=method):
                policy = policy_fixture(
                    {ALICE: Account("alice", 1)}, self.authorization
                )
                request = flow("/user", API_HOST)
                connect(policy, request)
                request.request.method = method
                for key, value in headers:
                    request.request.headers.set_all(
                        key, [*request.request.headers.get_all(key), value]
                    )
                await policy.requestheaders(request)
                assert request.response is not None
                self.assertEqual(request.response.status_code, status)
                self.assertEqual(policy.leases, {})

    async def test_tunnel_cannot_switch_between_git_and_api(self) -> None:
        for tunnel_host, request_host in [(HOST, API_HOST), (API_HOST, HOST)]:
            policy = policy_fixture({ALICE: Account("alice", 1)}, self.authorization)
            request = flow("/graphql", tunnel_host)
            connect(policy, request)
            # Even consistent inner Host/SNI/authority cannot change CONNECT's origin.
            request.client_conn.sni = request_host
            request.request.host = request_host
            request.request.headers["Host"] = request_host
            request.request.headers["Authorization"] = "token " + ALICE
            await policy.requestheaders(request)
            assert request.response is not None
            self.assertEqual(request.response.status_code, 403)
            request.server_conn.address = (request_host, 443)
            request.server_conn.sni = request_host
            await policy.server_connect(
                ServerConnectionHookData(request.server_conn, request.client_conn)
            )
            self.assertIsNotNone(request.server_conn.error)
            self.assertEqual(policy.leases, {})

    async def test_unknown_placeholders_and_duplicate_credentials(self) -> None:
        for headers, status in [
            ([("Authorization", basic(BOB))], 403),
            ([("Authorization", basic(ALICE, "wrong"))], 403),
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

    def test_connect_is_default_allow_but_cannot_be_nested_or_change_authority(
        self,
    ) -> None:
        for host, port in [
            ("uploads.github.com", 443),
            ("api.github.com.evil.test", 443),
            ("github.com", 80),
            ("example.test", 8443),
        ]:
            policy = policy_fixture({}, self.authorization)
            request = flow()
            request.request.host = host
            request.request.port = port
            request.request.authority = f"{host}:{port}"
            policy.http_connect(request)
            self.assertIsNone(request.response)
            self.assertEqual(policy.tunnels[request.client_conn.id], (host, port))
            policy.http_connect(request)
            self.assertIsNotNone(request.response)
            policy.client_disconnected(request.client_conn)
            self.assertEqual(policy.tunnels, {})
        policy = policy_fixture({}, self.authorization)
        request = flow()
        request.request.authority = "other.test:443"
        policy.http_connect(request)
        self.assertIsNotNone(request.response)
        self.assertEqual(policy.tunnels, {})

    async def test_unseeded_credentials_and_anonymous_requests_pass_unchanged(
        self,
    ) -> None:
        for host, authorization in product(
            (HOST, API_HOST),
            (
                None,
                "token user-token",
                "Bearer user-token",
                basic("user-token"),
                "Basic !invalid!",
                "Basic dXNlcg==",
                "Basic /w==",
            ),
        ):
            with self.subTest(host=host, authorization=authorization):
                policy = policy_fixture(
                    {ALICE: Account("alice", 1)}, self.authorization
                )
                request = flow(host=host)
                connect(policy, request)
                if authorization is not None:
                    request.request.headers["Authorization"] = authorization
                headers = request.request.headers.copy()
                await policy.requestheaders(request)
                self.assertIsNone(request.response)
                self.assertEqual(request.request.headers, headers)
                self.assertTrue(request.request.stream)
                self.assertEqual(policy.leases, {})

    async def test_unconfigured_api_methods_do_not_receive_host_credentials(
        self,
    ) -> None:
        policy = policy_fixture({ALICE: Account("alice", 1)}, self.authorization)
        request = flow("/user", API_HOST)
        request.request.method = "TRACE"
        request.request.headers["Authorization"] = "token " + ALICE
        connect(policy, request)
        await policy.requestheaders(request)
        self.assertIsNone(request.response)
        self.assertEqual(request.request.headers["Authorization"], "token " + ALICE)
        self.assertEqual(policy.leases, {})

    async def test_only_git_endpoints_receive_host_credentials(self) -> None:
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
                self.assertIsNone(request.response)
                self.assertEqual(
                    request.request.headers["Authorization"],
                    basic("ghu_token1" if allowed else ALICE),
                )
                self.assertEqual(request.request.path, path)

    async def test_authorities_and_tls_must_agree(self) -> None:
        for host, change in product(
            (HOST, API_HOST),
            [
                "no-connect",
                "plaintext",
                "sni",
                "host",
                "duplicate-host",
                "authority",
                "upgrade",
                "trailer",
            ],
        ):
            with self.subTest(host=host, change=change):
                policy = policy_fixture(
                    {ALICE: Account("alice", 1)}, self.authorization
                )
                request = flow(host=host)
                if change != "no-connect":
                    connect(policy, request)
                request.request.headers["Authorization"] = (
                    basic(ALICE) if host == HOST else "token " + ALICE
                )
                if change == "plaintext":
                    request.client_conn.tls = False
                elif change == "sni":
                    request.client_conn.sni = "other.test"
                elif change == "host":
                    request.request.headers["host"] = "other.test"
                elif change == "duplicate-host":
                    request.request.headers.set_all("host", [host, host])
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

            async def resolve(host: str, address: str = address) -> str:
                self.assertEqual(host, HOST)
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

    async def test_api_resolves_and_pins_its_own_address(self) -> None:
        for address in ("93.184.216.34", "127.0.0.1", "169.254.169.254"):

            async def resolve(host: str, address: str = address) -> str:
                self.assertEqual(host, API_HOST)
                return address

            policy = policy_fixture({}, self.authorization, resolve)
            request = flow("/user", API_HOST)
            connect(policy, request)
            request.server_conn.sni = API_HOST
            await policy.server_connect(
                ServerConnectionHookData(request.server_conn, request.client_conn)
            )
            if address == "93.184.216.34":
                self.assertIsNone(request.server_conn.error)
                self.assertEqual(request.server_conn.address, (address, 443))
                self.assertEqual(request.server_conn.sni, API_HOST)
            else:
                self.assertIsNotNone(request.server_conn.error)

    async def test_passthrough_also_pins_dns_and_denies_private_addresses(self) -> None:
        for address in ("93.184.216.34", "127.0.0.1", "10.0.0.1", "169.254.169.254"):

            async def resolve(host: str, address: str = address) -> str:
                self.assertEqual(host, "example.test")
                return address

            policy = policy_fixture({}, self.authorization, resolve)
            request = flow(host="example.test")
            request.request.port = 8443
            request.request.authority = "example.test:8443"
            request.server_conn.address = ("example.test", 8443)
            policy.http_connect(request)
            self.assertIsNone(request.response)
            await policy.server_connect(
                ServerConnectionHookData(request.server_conn, request.client_conn)
            )
            self.assertEqual(
                request.server_conn.error is None, address == "93.184.216.34"
            )
            if request.server_conn.error is None:
                self.assertEqual(request.server_conn.address, (address, 8443))

    async def test_resolution_failure_denies(self) -> None:
        async def resolve(host: str) -> str:
            self.assertEqual(host, HOST)
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

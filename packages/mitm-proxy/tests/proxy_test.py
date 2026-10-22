import base64
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from main import HOST, Owner, Policy, prepare, public_address, read_credentials
from mitmproxy import connection, http
from mitmproxy.proxy.server_hooks import ServerConnectionHookData

ALICE = "drv_run_" + "a" * 64
BOB = "drv_run_" + "b" * 64


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


class PolicyTest(unittest.TestCase):
    def test_credentials_are_owner_scoped_and_only_password_is_replaced(self) -> None:
        for placeholder, token in [(ALICE, "alice_token"), (BOB, "bob_token")]:
            with self.subTest(placeholder=placeholder):
                policy = Policy({ALICE: "alice_token", BOB: "bob_token"})
                request = flow("/alice/project.git/git-receive-pack")
                request.request.method = "POST"
                request.request.content = placeholder.encode()
                request.request.headers["X-Example"] = placeholder
                request.request.headers["Authorization"] = basic(placeholder)
                request.request.headers["Connection"] = "Authorization"
                request.request.headers["Proxy-Authorization"] = basic(placeholder)
                connect(policy, request)
                policy.requestheaders(request)
                self.assertIsNone(request.response)
                self.assertEqual(request.request.headers["Authorization"], basic(token))
                self.assertEqual(request.request.headers["X-Example"], placeholder)
                self.assertEqual(request.request.content, placeholder.encode())
                self.assertNotIn("connection", request.request.headers)
                self.assertNotIn("proxy-authorization", request.request.headers)
                self.assertTrue(request.request.stream)

    def test_challenge_and_unknown_credentials(self) -> None:
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
                policy = Policy({ALICE: "alice_token"})
                request = flow()
                connect(policy, request)
                for key, value in headers:
                    request.request.headers.set_all(
                        key, [*request.request.headers.get_all(key), value]
                    )
                policy.requestheaders(request)
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
            policy = Policy({})
            request = flow()
            request.request.host = host
            request.request.port = port
            request.request.authority = authority
            policy.http_connect(request)
            assert request.response is not None
            self.assertEqual(request.response.status_code, 403)
            self.assertEqual(policy.tunnels, set())
        policy = Policy({})
        request = flow()
        connect(policy, request)
        request.request.authority = "github.com:443"
        policy.http_connect(request)
        self.assertIsNotNone(request.response)
        policy.client_disconnected(request.client_conn)
        self.assertEqual(policy.tunnels, set())

    def test_only_git_endpoints(self) -> None:
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
                policy = Policy({ALICE: "token"})
                request = flow(path)
                request.request.method = method
                request.request.headers["Authorization"] = basic(ALICE)
                connect(policy, request)
                policy.requestheaders(request)
                self.assertEqual(request.response is None, allowed)
                self.assertEqual(request.request.path, path)

    def test_authorities_and_tls_must_agree(self) -> None:
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
                policy = Policy({ALICE: "token"})
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
                policy.requestheaders(request)
                assert request.response is not None
                self.assertEqual(request.response.status_code, 403)

    def test_exception_after_mutation_kills_flow(self) -> None:
        policy = Policy({ALICE: "token"})
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
            policy.requestheaders(request)
        self.assertIsNotNone(request.error)
        self.assertFalse(request.live)
        self.assertIsNotNone(request.response)


class ConnectionTest(unittest.IsolatedAsyncioTestCase):
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

            policy = Policy({}, resolve)
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

        policy = Policy({}, resolve)
        request = flow()
        connect(policy, request)
        request.server_conn.sni = HOST
        data = ServerConnectionHookData(request.server_conn, request.client_conn)
        with self.assertRaises(OSError):
            await policy.server_connect(data)
        self.assertIsNotNone(data.server.error)

    def test_public_address(self) -> None:
        self.assertTrue(public_address("140.82.112.3"))
        self.assertFalse(public_address("0.0.0.0"))
        self.assertFalse(public_address("240.0.0.1"))


class CredentialTest(unittest.TestCase):
    def test_publication_modes_override_restrictive_umask(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state, public = root / "state", root / "public"
            owners = [Owner("alice", 1000), Owner("bob", 1001)]
            previous_umask = os.umask(0o077)
            try:
                # Only ownership changes need privilege; exercise real file modes.
                with patch("main.os.chown") as chown:
                    for _ in range(2):
                        prepare(state, public, owners, 999)
                        for owner in owners:
                            publication = public / owner.name
                            self.assertEqual(
                                stat.S_IMODE(publication.stat().st_mode), 0o750
                            )
                            chown.assert_any_call(publication, 0, owner.gid)
                            for name in ["placeholder", "ca.pem"]:
                                self.assertEqual(
                                    stat.S_IMODE((publication / name).stat().st_mode),
                                    0o640,
                                )
                            # Restart must repair directories from the broken version.
                            publication.chmod(0o700)
                        self.assertEqual(stat.S_IMODE(public.stat().st_mode), 0o755)
                        self.assertEqual(stat.S_IMODE(state.stat().st_mode), 0o750)
                        for entry in state.iterdir():
                            self.assertEqual(stat.S_IMODE(entry.stat().st_mode), 0o640)
            finally:
                _ = os.umask(previous_umask)

    def test_loading_and_rotation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _ = (root / "placeholder-alice").write_text(ALICE)
            _ = (root / "placeholder-bob").write_text(BOB)
            _ = (root / "token-alice").write_text("first_token\n")
            _ = (root / "token-bob").write_text("other_token")
            owners = [Owner("alice", 1000), Owner("bob", 1001)]
            self.assertEqual(
                read_credentials(root, root, owners),
                {ALICE: "first_token", BOB: "other_token"},
            )
            _ = (root / "token-alice").write_text("second_token")
            self.assertEqual(
                read_credentials(root, root, owners)[ALICE], "second_token"
            )
            for invalid in ["", "token\nheader", ALICE]:
                _ = (root / "token-alice").write_text(invalid)
                with self.assertRaises(ValueError):
                    _ = read_credentials(root, root, owners)
            (root / "token-alice").unlink()
            with self.assertRaises(FileNotFoundError):
                _ = read_credentials(root, root, owners)


if __name__ == "__main__":
    _ = unittest.main()

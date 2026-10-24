import argparse
import asyncio
import base64
import binascii
import ipaddress
import json
import logging
import os
import pwd
import re
import secrets
import shutil
import signal
import socket
import sys
from collections.abc import Awaitable, Callable, Generator, Mapping, Sequence
from contextlib import (
    AbstractAsyncContextManager,
    AbstractContextManager,
    ExitStack,
    contextmanager,
    suppress,
)
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import cast, override

from auth import (
    Account,
    AuthError,
    Authorization,
    Device,
    GitHub,
    Status,
    http_client,
    integer,
    object_value,
    text,
)
from cryptography import x509
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from mitmproxy import connection, http, options
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.certs import CertStore
from mitmproxy.net.http.http1 import expected_http_body_size
from mitmproxy.proxy.mode_servers import ProxyConnectionHandler
from mitmproxy.proxy.server_hooks import ServerConnectionHookData
from mitmproxy.tools.dump import DumpMaster
from tornado.httpclient import HTTPRequest, HTTPResponse
from tornado.httpserver import HTTPServer
from tornado.httputil import HTTPServerRequest
from tornado.web import Application, HTTPError, RequestHandler

# Initial policy: HTTPS Git smart HTTP, not GitHub's web/API endpoints.
HOST = "github.com"
REPOSITORY = r"/[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+"
DISCOVERY = re.compile(REPOSITORY + r"/info/refs\?service=git-(upload|receive)-pack")
TRANSFER = re.compile(REPOSITORY + r"/git-(upload|receive)-pack")
PLACEHOLDER = re.compile(r"drv_run_[0-9a-f]{64}")


async def resolve_upstream() -> str:
    import socket

    addresses = await asyncio.get_running_loop().getaddrinfo(
        HOST, 443, family=socket.AF_INET, type=socket.SOCK_STREAM
    )
    return str(addresses[0][4][0])


def public_address(address: str) -> bool:
    ip = ipaddress.IPv4Address(address)
    return ip.is_global and not ip.is_multicast and not ip.is_reserved


class ReadGate(asyncio.StreamReader):
    """Gate the read() interface used by mitmproxy's TCP connection handler."""

    def __init__(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        super().__init__()
        self.reader: asyncio.StreamReader = reader
        self.writer: asyncio.StreamWriter = writer
        self.ready: asyncio.Event = asyncio.Event()
        self.ready.set()

    @override
    async def read(self, n: int = -1) -> bytes:
        # 12.2.3 ConnectionHandler.handle_connection calls only read(65535).
        assert 0 < n <= 65535
        _ = await self.ready.wait()
        data = await self.reader.read(n)
        # Also stop a read that was already pending when the hook paused us.
        _ = await self.ready.wait()
        return data


class Backpressure:
    def __init__(self, proxyserver: Proxyserver) -> None:
        self.proxyserver: Proxyserver = proxyserver
        self.readers: dict[str, ReadGate] = {}

    def client_connected(self, client: connection.Client) -> None:
        client.error = "mitm-proxy: cannot bound client reads"
        # 12.2.3 registers the connection before this hook and captures its reader
        # afterward. Stop consuming that reader, letting asyncio's bounded buffer
        # pause the TCP transport; pausing an HTTP hook alone queues body events.
        # Upstream also supports unparameterized UDP tuple keys; TCP IDs are str.
        connections = cast(
            Mapping[str, ProxyConnectionHandler], self.proxyserver.connections
        )
        transport = connections[client.id].transports[client]
        assert isinstance(transport.reader, asyncio.StreamReader)
        assert isinstance(transport.writer, asyncio.StreamWriter)
        gate = ReadGate(transport.reader, transport.writer)
        transport.reader = gate
        self.readers[client.id] = gate
        client.error = None

    def client_disconnected(self, client: connection.Client) -> None:
        _ = self.readers.pop(client.id, None)

    @contextmanager
    def pause(self, flow: http.HTTPFlow) -> Generator[None]:
        gate = self.readers[flow.client_conn.id]
        # This proxy permits HTTP/1 only, without concurrent/pipelined streams.
        assert gate.ready.is_set()
        gate.ready.clear()
        try:
            yield
        except BaseException:
            # Cancelled hooks do not deliver HookCompleted. Never resume reads
            # into a permanently paused HTTP layer.
            gate.writer.transport.abort()
            raise
        finally:
            if flow.error is not None:
                # Abort explicitly: killing a flow can cancel 12.2.3's reader
                # inside server_event(), before its writer-close cleanup runs.
                gate.writer.transport.abort()
            gate.ready.set()


class Policy:
    def __init__(
        self,
        credentials: Mapping[str, Account],
        authorization: Authorization,
        resolve: Callable[[], Awaitable[str]] = resolve_upstream,
        *,
        pause: Callable[[http.HTTPFlow], AbstractContextManager[None]],
    ) -> None:
        self.credentials: dict[str, Account] = dict(credentials)
        self.authorization: Authorization = authorization
        self.leases: dict[
            str, tuple[Account, str, AbstractAsyncContextManager[str]]
        ] = {}
        self.pause: Callable[[http.HTTPFlow], AbstractContextManager[None]] = pause
        self.resolve: Callable[[], Awaitable[str]] = resolve
        self.tunnels: set[str] = set()

    def http_connect(self, flow: http.HTTPFlow) -> None:
        # mitmproxy catches addon exceptions. Install the denial before checking
        # anything, and remove it only once all policy checks have succeeded.
        flow.response = http.Response.make(403)
        if (
            flow.request.host == HOST
            and flow.request.port == 443
            and flow.request.authority.lower() == f"{HOST}:443"
            and flow.client_conn.id not in self.tunnels
        ):
            self.tunnels.add(flow.client_conn.id)
            flow.response = None

    def client_disconnected(self, client: connection.Client) -> None:
        self.tunnels.discard(client.id)

    async def requestheaders(self, flow: http.HTTPFlow) -> None:
        completed = False
        try:
            with self.pause(flow):
                await self.authorize(flow)
                if (
                    flow.response is not None
                    and expected_http_body_size(flow.request) != 0
                ):
                    # 12.2.3 buffers a denied request's body before sending its
                    # response. Close instead of reading an arbitrary upload.
                    flow.kill()
                    await self.release(flow)
                completed = True
        finally:
            # Even an exception after partial mutation must fail closed.
            if not completed:
                flow.kill()
                await self.release(flow)

    async def authorize(self, flow: http.HTTPFlow) -> None:
        try:
            flow.response = http.Response.make(403)
            flow.request.stream = False
            request = flow.request
            hosts = request.headers.get_all("host")
            if (
                flow.client_conn.id not in self.tunnels
                or not flow.client_conn.tls
                or flow.client_conn.sni != HOST
                or request.scheme != "https"
                or request.host != HOST
                or request.port != 443
                or len(hosts) > 1
                or any(host.lower() not in (HOST, f"{HOST}:443") for host in hosts)
                or request.authority.lower() not in ("", HOST, f"{HOST}:443")
                or "upgrade" in request.headers
                or "trailer" in request.headers
                or not (
                    (request.method == "GET" and DISCOVERY.fullmatch(request.path))
                    or (request.method == "POST" and TRANSFER.fullmatch(request.path))
                )
            ):
                return
            authorization = request.headers.get_all("authorization")
            if not authorization:
                flow.response = http.Response.make(
                    401, headers={"WWW-Authenticate": 'Basic realm="mitm-proxy"'}
                )
                return
            if len(authorization) != 1:
                return
            scheme, encoded = authorization[0].split(" ", 1)
            if scheme.lower() != "basic":
                return
            username, placeholder = (
                base64.b64decode(encoded, validate=True).decode("ascii").split(":", 1)
            )
            if username != "x-access-token":
                return
            account = self.credentials.get(placeholder)
            if account is None:
                return
            lease = self.authorization.lease(account)
            token = await lease.__aenter__()
            self.leases[flow.id] = (account, token, lease)
            replacement = base64.b64encode(f"{username}:{token}".encode()).decode()
            # Do not allow the client to nominate credentials as a hop-by-hop
            # header, or to pass proxy credentials on to the upstream server.
            request.headers.set_all("connection", [])
            request.headers.set_all("proxy-authorization", [])
            request.headers["authorization"] = "Basic " + replacement
            request.stream = True
            flow.response = None
        except (ValueError, UnicodeError, binascii.Error):
            return
        except AuthError as error:
            flow.response = http.Response.make(
                503 if error.state == "temporarily-unavailable" else 403
            )
        except OSError:
            flow.response = http.Response.make(503)

    async def server_connect(self, data: ServerConnectionHookData) -> None:
        data.server.error = "mitm-proxy: upstream denied"
        if (
            data.client.id not in self.tunnels
            or data.client.sni != HOST
            or data.server.address != (HOST, 443)
            or data.server.transport_protocol != "tcp"
            or data.server.sni != HOST
        ):
            return
        address = await self.resolve()
        if not public_address(address):
            return
        # Pin the checked numeric address: no second DNS lookup at connect.
        data.server.address = (address, 443)
        data.server.error = None

    def responseheaders(self, flow: http.HTTPFlow) -> None:
        assert flow.response is not None
        flow.response.stream = True

    async def release(self, flow: http.HTTPFlow) -> None:
        entry = self.leases.pop(flow.id, None)
        if entry is not None:
            _ = await entry[2].__aexit__(None, None, None)

    async def response(self, flow: http.HTTPFlow) -> None:
        entry = self.leases.get(flow.id)
        await self.release(flow)
        if (
            entry is not None
            and flow.response is not None
            and flow.response.status_code == 401
        ):
            with self.pause(flow):
                await self.authorization.reject(entry[0], entry[1])

    async def error(self, flow: http.HTTPFlow) -> None:
        await self.release(flow)


@dataclass(frozen=True)
class Owner:
    name: str
    gid: int
    user_id: int


@dataclass(frozen=True)
class CertificateAuthority:
    certificate: str
    private_key_file: Path


def prepare(
    state: Path,
    public: Path,
    owners: Sequence[Owner],
    gid: int,
    ca: CertificateAuthority,
    ca_store: Path,
) -> None:
    certificates = x509.load_pem_x509_certificates(ca.certificate.encode())
    if len(certificates) != 1:
        raise ValueError("expected one CA certificate")
    certificate = certificates[0]
    key = serialization.load_pem_private_key(ca.private_key_file.read_bytes(), None)
    if not isinstance(key, (rsa.RSAPrivateKey, ec.EllipticCurvePrivateKey)):
        raise TypeError("unsupported CA key type")
    if key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    ) != certificate.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    ):
        raise ValueError("CA certificate and private key do not match")
    try:
        constraints = certificate.extensions.get_extension_for_class(
            x509.BasicConstraints
        ).value
        usage = certificate.extensions.get_extension_for_class(x509.KeyUsage).value
    except x509.ExtensionNotFound as error:
        raise ValueError("missing CA constraints") from error
    if not constraints.ca or not usage.key_cert_sign:
        raise ValueError("certificate cannot sign certificates")
    if (
        not certificate.not_valid_before_utc
        <= datetime.now(UTC)
        < certificate.not_valid_after_utc
    ):
        raise ValueError("CA certificate is not currently valid")

    # Only the runtime directory receives the decrypted key. Never let mitmproxy
    # silently generate a CA that differs from the guest's build-time trust root.
    ca_store.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = ca_store / ".mitmproxy-ca.pem"
    _ = temporary.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        )
        + certificate.public_bytes(serialization.Encoding.PEM)
    )
    os.chown(temporary, 0, gid)
    temporary.chmod(0o640)
    _ = temporary.replace(ca_store / "mitmproxy-ca.pem")
    _ = CertStore.from_files(
        ca_store / "mitmproxy-ca.pem", ca_store / "mitmproxy-dhparam.pem"
    )
    for entry in ca_store.iterdir():
        os.chown(entry, 0, gid)
        entry.chmod(0o640)
    os.chown(ca_store, 0, gid)
    ca_store.chmod(0o750)

    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    for obsolete in state.glob("mitmproxy-*"):
        obsolete.unlink()
    public.mkdir(mode=0o755, parents=True, exist_ok=True)
    public.chmod(0o755)
    # Remove publications for owners whose access was removed.
    for entry in public.iterdir():
        if entry.name not in {owner.name for owner in owners}:
            shutil.rmtree(entry)
    for owner in owners:
        marker = state / ("placeholder-" + owner.name)
        if not marker.exists():
            with marker.open("x") as file:
                _ = file.write("drv_run_" + secrets.token_hex(32))
        placeholder = marker.read_text()
        if not PLACEHOLDER.fullmatch(placeholder):
            raise ValueError("invalid persisted mitm-proxy placeholder")
        directory = public / owner.name
        directory.mkdir(mode=0o750, exist_ok=True)
        os.chown(directory, 0, owner.gid)
        # mkdir's mode is masked by the service's UMask=0077.
        directory.chmod(0o750)
        # JSON is also YAML; gh reads this without an online login or token export.
        hosts = json.dumps(
            {"github.com": {"oauth_token": placeholder, "git_protocol": "https"}}
        ).encode()
        for name, content in [
            # Without a schema version gh attempts an online account migration.
            ("config.yml", b"version: 1\n"),
            ("hosts.yml", hosts),
        ]:
            temporary = directory / ("." + name)
            _ = temporary.write_bytes(content)
            os.chown(temporary, 0, owner.gid)
            temporary.chmod(0o640)
            _ = temporary.replace(directory / name)
        for obsolete in ["placeholder", "ca.pem"]:
            (directory / obsolete).unlink(missing_ok=True)
    # The proxy can read, but cannot alter state consumed by privileged prepare.
    for entry in state.iterdir():
        os.chown(entry, 0, gid)
        entry.chmod(0o640)
    os.chown(state, 0, gid)
    state.chmod(0o750)


def read_credentials(state: Path, owners: Sequence[Owner]) -> dict[str, Account]:
    credentials: dict[str, Account] = {}
    for owner in owners:
        placeholder = (state / ("placeholder-" + owner.name)).read_text()
        if not PLACEHOLDER.fullmatch(placeholder) or placeholder in credentials:
            raise ValueError("invalid mitm-proxy placeholder")
        credentials[placeholder] = Account(owner.name, owner.user_id)
    return credentials


def create_master(
    state: Path,
    port: int,
    credentials: Mapping[str, Account],
    authorization: Authorization,
) -> DumpMaster:
    _ = CertStore.from_files(
        state / "mitmproxy-ca.pem", state / "mitmproxy-dhparam.pem"
    )
    opts = options.Options(
        confdir=str(state),
        listen_host="0.0.0.0",
        listen_port=port,
        mode=["regular"],
        upstream_cert=False,
        ssl_insecure=False,
        # 12.2.3's HTTP/2 -> HTTP/1 conversion does not frame unknown-length
        # streamed bodies. Git's large pushes must retain HTTP/1 chunk framing.
        http2=False,
        rawtcp=False,
        websocket=False,
    )
    # Do not emit flows or addon tracebacks (which may contain credentials).
    # Keep ErrorCheck active so startup errors still cause a nonzero exit.
    logging.getLogger().addHandler(logging.NullHandler())
    master = DumpMaster(opts, with_termlog=False, with_dumper=False)
    opts.set("connection_strategy=lazy")
    get_addon = cast(Callable[[str], object], master.addons.get)
    proxyserver = get_addon("proxyserver")
    assert isinstance(proxyserver, Proxyserver)
    backpressure = Backpressure(proxyserver)
    # mitmproxy 12.2.3 leaves AddonManager.add's variadic argument untyped.
    cast(Callable[[Backpressure, Policy], None], master.addons.add)(
        backpressure, Policy(credentials, authorization, pause=backpressure.pause)
    )
    return master


class Control:
    """One owner's authorization, exposed only on that owner's Unix socket."""

    def __init__(self, authorization: Authorization, account: Account) -> None:
        self.authorization: Authorization = authorization
        self.account: Account = account
        self.task: asyncio.Task[None] | None = None
        self.device: Device | None = None
        self.failure: Status | None = None
        self.lock: asyncio.Lock = asyncio.Lock()

    async def status(self) -> dict[str, object]:
        async with self.lock:
            state: dict[str, object] = (
                {"state": "authorizing", "user_id": self.account.user_id}
                if self.task is not None and not self.task.done()
                else asdict(await self.authorization.status(self.account))
            )
            # Never serialize Device: its device_code is a credential, not UI data.
            state["device"] = (
                {
                    "user_code": self.device.user_code,
                    "verification_uri": self.device.verification_uri,
                    "expires_at": self.device.expires_at,
                }
                if self.device is not None
                else None
            )
            state["error"] = self.failure
            return state

    async def login(self) -> None:
        async with self.lock:
            if self.task is not None and not self.task.done():
                return
            self.failure = None
            self.device = None
            self.task = asyncio.create_task(self.enroll())

    async def enroll(self) -> None:
        def show(device: Device) -> None:
            self.device = device

        try:
            await self.authorization.login(self.account, show)
        except AuthError as error:
            self.failure = error.state
        except OSError:
            self.failure = "temporarily-unavailable"
        finally:
            self.device = None

    async def cancel(self) -> None:
        if self.task is not None:
            _ = self.task.cancel()
            with suppress(asyncio.CancelledError):
                await self.task
            self.task = None

    async def logout(self) -> None:
        async with self.lock:
            await self.cancel()
            await self.authorization.logout(self.account)
            self.failure = None

    async def close(self) -> None:
        async with self.lock:
            await self.cancel()


class ControlHandler(RequestHandler):
    def __init__(
        self, application: Application, request: HTTPServerRequest, *, control: Control
    ) -> None:
        self.control: Control = control
        super().__init__(application, request)

    @override
    def prepare(self) -> None:
        self.set_header("Cache-Control", "no-store")
        if self.request.query or self.request.body:
            raise HTTPError(400)
        if self.request.headers.get("Origin"):
            raise HTTPError(403)

    @override
    async def get(self, operation: str) -> None:
        if operation != "status":
            raise HTTPError(405)
        self.set_header("Content-Type", "application/json")
        # Tornado's dict overloads are unparameterized in 6.5.7; use JSON text.
        cast(Callable[[str], None], self.write)(json.dumps(await self.control.status()))

    @override
    async def post(self, operation: str) -> None:
        try:
            if operation == "login":
                await self.control.login()
            elif operation == "logout":
                await self.control.logout()
            else:
                raise HTTPError(405)
            self.set_status(204)
        except (AuthError, OSError):
            raise HTTPError(503) from None

    @override
    def write_error(self, status_code: int, **kwargs: object) -> None:
        cast(Callable[[str], None], self.write)("authorization operation failed")


def control_server(control: Control, listener: socket.socket) -> HTTPServer:
    if listener.family != socket.AF_UNIX:
        raise ValueError("authorization control requires a Unix socket")
    listener.setblocking(False)
    listener.set_inheritable(False)
    # HTTPServer inherits Configurable.__new__, whose return type is Any.
    server = cast(
        HTTPServer,
        HTTPServer(
            Application(
                [(r"/(status|login|logout)", ControlHandler, {"control": control})]
            ),
            max_body_size=1024,
            max_header_size=4096,
            body_timeout=5,
            idle_connection_timeout=10,
        ),
    )
    server.add_sockets([listener])
    return server


def control_listeners(owners: Sequence[Owner]) -> dict[str, socket.socket]:
    # systemd creates owner-only sockets before dropping service privileges.
    # Descriptor names bind each listener to configuration, never to client input.
    names = os.environ.pop("LISTEN_FDNAMES", "").split(":")
    count = int(os.environ.pop("LISTEN_FDS", "0"))
    pid = int(os.environ.pop("LISTEN_PID", "0"))
    if (
        pid != os.getpid()
        or count != len(owners)
        or len(names) != count
        or set(names) != {owner.name for owner in owners}
    ):
        raise ValueError("invalid authorization socket activation")
    return {name: socket.socket(fileno=fd) for fd, name in enumerate(names, 3)}


async def serve(
    state: Path,
    port: int,
    credentials: Mapping[str, Account],
    authorization: Authorization,
    owners: Sequence[Owner],
) -> None:
    master = create_master(state, port, credentials, authorization)
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, master.shutdown)
    controls: list[Control] = []
    servers: list[HTTPServer] = []
    listeners = control_listeners(owners)
    try:
        for owner in owners:
            control = Control(authorization, Account(owner.name, owner.user_id))
            controls.append(control)
            servers.append(control_server(control, listeners[owner.name]))
        await master.run()
    finally:
        for server in servers:
            server.stop()
        for control in controls:
            await control.close()
        for server in servers:
            await server.close_all_connections()
        for listener in listeners.values():
            listener.close()


class Arguments(argparse.Namespace):
    operation: str = ""
    config: str = "/etc/mitm-proxy.json"
    user: str | None = None


def configuration(path: Path) -> tuple[str, int, list[Owner], CertificateAuthority]:
    data = object_value(cast(object, json.loads(path.read_text())))
    client_id = text(data, "clientId")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", client_id):
        raise ValueError("invalid client ID")
    port = integer(data, "port")
    if port > 65535:
        raise ValueError("invalid port")
    owners: list[Owner] = []
    for name, value in object_value(data["owners"]).items():
        owner = object_value(value)
        account = Account(name, integer(owner, "githubUserId"))
        owners.append(Owner(account.name, integer(owner, "gid"), account.user_id))
    ca = CertificateAuthority(
        text(data, "caCertificate"), Path(text(data, "caPrivateKeyFile"))
    )
    return client_id, port, owners, ca


async def run(
    args: Arguments, state: Path, tokens: Path, show: Callable[[Device], None]
) -> None:
    client_id, port, owners, ca = configuration(Path(args.config))
    ca_store = Path("/run/mitm-proxy-ca")
    if args.operation == "prepare":
        prepare(
            state,
            Path("/run/mitm-proxy"),
            owners,
            pwd.getpwnam("mitm-proxy").pw_gid,
            ca,
            ca_store,
        )
        return
    client = http_client()

    async def fetch(request: HTTPRequest) -> HTTPResponse:
        return await client.fetch(request, raise_error=False)

    authorization = Authorization(tokens, GitHub(client_id, fetch))
    try:
        if args.operation == "serve":
            await serve(
                ca_store, port, read_credentials(state, owners), authorization, owners
            )
            return
        owner = next((owner for owner in owners if owner.name == args.user), None)
        if owner is None:
            raise ValueError("select a configured host user with --user")
        account = Account(owner.name, owner.user_id)
        if args.operation == "login":
            await authorization.login(account, show)
        elif args.operation == "logout":
            await authorization.logout(account)
        else:
            print(json.dumps(asdict(await authorization.status(account))))
    finally:
        client.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    _ = parser.add_argument(
        "operation", choices=["prepare", "serve", "login", "status", "logout"]
    )
    _ = parser.add_argument("--config", default="/etc/mitm-proxy.json")
    _ = parser.add_argument("--user")
    args = parser.parse_args(namespace=Arguments())
    state = Path("/var/lib/mitm-proxy")
    tokens = Path("/var/lib/mitm-proxy-auth")
    try:
        with ExitStack() as stack:
            if os.geteuid() not in (0, pwd.getpwnam("mitm-proxy").pw_uid):
                raise PermissionError("operator commands require root")
            # Open the initiating terminal before dropping root privileges.
            terminal = (
                stack.enter_context(open("/dev/tty", "w"))
                if args.operation == "login"
                else None
            )

            def show(device: Device) -> None:
                assert terminal is not None
                print(
                    device.verification_uri, device.user_code, file=terminal, flush=True
                )

            if args.operation == "prepare":
                if os.geteuid() != 0:
                    raise PermissionError("prepare requires root")
            else:
                service = pwd.getpwnam("mitm-proxy")
                if os.geteuid() == 0:
                    os.setgroups([])
                    os.setgid(service.pw_gid)
                    os.setuid(service.pw_uid)
            asyncio.run(run(args, state, tokens, show))
    except (AuthError, OSError, ValueError, TypeError, KeyError):
        # Exceptions may contain credential-bearing HTTP or state data.
        print(
            "mitm-proxy: operation failed; check authorization with status",
            file=sys.stderr,
        )
        raise SystemExit(1) from None
    except KeyboardInterrupt:
        raise SystemExit(130) from None


if __name__ == "__main__":
    main()

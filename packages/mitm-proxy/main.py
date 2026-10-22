import argparse
import asyncio
import base64
import binascii
import ipaddress
import logging
import os
import pwd
import re
import secrets
import shutil
import signal
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import cast

from mitmproxy import connection, http, options
from mitmproxy.certs import CertStore
from mitmproxy.proxy.server_hooks import ServerConnectionHookData
from mitmproxy.tools.dump import DumpMaster

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


class Policy:
    def __init__(
        self,
        credentials: Mapping[str, str],
        resolve: Callable[[], Awaitable[str]] = resolve_upstream,
    ) -> None:
        self.credentials: dict[str, str] = dict(credentials)
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

    def requestheaders(self, flow: http.HTTPFlow) -> None:
        completed = False
        try:
            self.authorize(flow)
            completed = True
        finally:
            # Even an exception after partial mutation must fail closed.
            if not completed:
                flow.kill()

    def authorize(self, flow: http.HTTPFlow) -> None:
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
            token = self.credentials.get(placeholder)
            if token is None:
                return
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


@dataclass(frozen=True)
class Owner:
    name: str
    gid: int

    @staticmethod
    def parse(value: str) -> "Owner":
        name, gid = value.split(":")
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.-]*", name) or int(gid) <= 0:
            raise ValueError("invalid mitm-proxy owner")
        return Owner(name, int(gid))


def prepare(state: Path, public: Path, owners: Sequence[Owner], gid: int) -> None:
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    _ = CertStore.from_store(str(state), "mitmproxy", 2048)
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
        if not PLACEHOLDER.fullmatch(marker.read_text()):
            raise ValueError("invalid persisted mitm-proxy placeholder")
        directory = public / owner.name
        directory.mkdir(mode=0o750, exist_ok=True)
        os.chown(directory, 0, owner.gid)
        # mkdir's mode is masked by the service's UMask=0077.
        directory.chmod(0o750)
        for source, name in [
            (marker, "placeholder"),
            (state / "mitmproxy-ca-cert.pem", "ca.pem"),
        ]:
            temporary = directory / ("." + name)
            _ = shutil.copyfile(source, temporary)
            os.chown(temporary, 0, owner.gid)
            temporary.chmod(0o640)
            _ = temporary.replace(directory / name)
    # The proxy can read, but cannot alter state consumed by privileged prepare.
    for entry in state.iterdir():
        os.chown(entry, 0, gid)
        entry.chmod(0o640)
    os.chown(state, 0, gid)
    state.chmod(0o750)


def read_credentials(
    state: Path, directory: Path, owners: Sequence[Owner]
) -> dict[str, str]:
    credentials: dict[str, str] = {}
    for owner in owners:
        placeholder = (state / ("placeholder-" + owner.name)).read_text()
        token = (directory / ("token-" + owner.name)).read_text().strip()
        if (
            not PLACEHOLDER.fullmatch(placeholder)
            or placeholder in credentials
            or not re.fullmatch(r"[A-Za-z0-9_]+", token)
            or token == placeholder
        ):
            raise ValueError("invalid mitm-proxy credentials")
        credentials[placeholder] = token
    return credentials


def create_master(state: Path, port: int, credentials: Mapping[str, str]) -> DumpMaster:
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
    # mitmproxy 12.2.3 leaves AddonManager.add's variadic argument untyped.
    cast(Callable[[Policy], None], master.addons.add)(Policy(credentials))
    return master


async def serve(state: Path, port: int, credentials: Mapping[str, str]) -> None:
    master = create_master(state, port, credentials)
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, master.shutdown)
    await master.run()


class Arguments(argparse.Namespace):
    operation: str = ""
    port: int = 0

    def __init__(self) -> None:
        super().__init__()
        self.owner: list[Owner] = []


def main() -> None:
    parser = argparse.ArgumentParser()
    _ = parser.add_argument("operation", choices=["prepare", "serve"])
    _ = parser.add_argument("--owner", action="append", type=Owner.parse, default=[])
    _ = parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args(namespace=Arguments())
    state = Path(os.environ["STATE_DIRECTORY"])
    if args.operation == "prepare":
        prepare(
            state,
            Path("/run/mitm-proxy"),
            args.owner,
            pwd.getpwnam("mitm-proxy").pw_gid,
        )
    else:
        credentials = read_credentials(
            state, Path(os.environ["CREDENTIALS_DIRECTORY"]), args.owner
        )
        asyncio.run(serve(state, args.port, credentials))


if __name__ == "__main__":
    main()

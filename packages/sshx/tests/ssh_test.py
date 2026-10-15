import os
import shlex
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from typing import final


@final
class SSHFixture:
    def __init__(self, test: unittest.TestCase) -> None:
        self.test = test
        self.directory = tempfile.TemporaryDirectory(prefix="sshx-")
        self.test.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.children: list[subprocess.Popen[bytes]] = []
        self.test.addCleanup(self.stop_children)
        self.env = dict(os.environ)
        self.env.update(
            LD_PRELOAD=os.environ["NSS_WRAPPER_LIBRARY"],
            NSS_WRAPPER_PASSWD=str(self.root / "passwd"),
            NSS_WRAPPER_GROUP=str(self.root / "group"),
        )
        bash = shutil.which("bash")
        assert bash is not None
        _ = (self.root / "passwd").write_text(
            f"fixture:x:{os.getuid()}:{os.getgid()}::{self.root}:{bash}\n"
            + "sshd:x:65534:65534::/var/empty:/bin/false\n"
        )
        _ = (self.root / "group").write_text(
            f"fixture:x:{os.getgid()}:\nsshd:x:65534:\n"
        )
        guest_shell = self.root / "guest-shell"
        (self.root / "ready").touch()
        (self.root / "environment").touch()
        (self.root / "profile").symlink_to(self.root / "environment")
        (self.root / "workspace").mkdir()
        (self.root / "bin").mkdir()
        activation = self.root / "bin/nix"
        _ = activation.write_text(
            f"#!{bash}\nset -euo pipefail\n"
            + f"if [[ $2 == -- ]]; then exec {bash} -i; fi\n"
            + "printf 'shellHook output\\n'\n"
            + "if read -r unexpected; then exit 1; fi\n"
            + 'exec "${@:4}"\n'
        )
        activation.chmod(0o755)
        _ = guest_shell.write_text(
            f"#!{bash}\nexport PATH={self.root / 'bin'}:$PATH\n"
            + Path("tests/shell.sh")
            .read_text()
            .replace(
                "profile=/nix/var/nix/profiles/project",
                f"profile={self.root / 'profile'}",
            )
            .replace("/run/drv-run-environment/ready", str(self.root / "ready"))
            .replace("/workspace", str(self.root / "workspace"))
            .replace("@bash@", bash)
        )
        guest_shell.chmod(0o755)
        _ = (self.root / "guest-passwd").write_text(
            (self.root / "passwd").read_text().replace(bash, str(guest_shell))
        )
        for name in ["client", "host", "guest", "wrong"]:
            self.run_command(
                "ssh-keygen",
                "-q",
                "-t",
                "ed25519",
                "-N",
                "",
                "-f",
                str(self.root / name),
            )
        connector = str(Path("connect.test").resolve())
        bridge = self.root / "connect"
        _ = bridge.write_text(
            f'#!{bash}\nexec {shlex.quote(connector)} "$1" '
            + f"{shlex.quote('vsock-mux' + str(self.root / 'guest.sock'))}\n"
        )
        bridge.chmod(0o755)
        launcher = self.root / "launcher"
        _ = launcher.write_text(
            Path("tests/launcher.sh")
            .read_text()
            .replace("@connect@", shlex.quote(str(bridge)))
            .replace("@timing@", "")
        )
        for name in ["host", "guest"]:
            config = self.root / f"{name}.conf"
            _ = config.write_text(
                f"HostKey {self.root / name}\n"
                + "UsePAM no\nStrictModes yes\nPermitRootLogin yes\n"
                + "PasswordAuthentication no\nKbdInteractiveAuthentication no\n"
                + f"AuthorizedKeysFile {self.root / 'client.pub'}\n"
                + f"Subsystem sftp {os.environ['SFTP_SERVER']}\n"
                + f"SetEnv PATH={os.environ['PATH']}\n"
                + (
                    f"DisableForwarding yes\nForceCommand {bash} {launcher}\n"
                    if name == "host"
                    else ""
                )
            )
            self.mux(name, config)
        known = self.root / "known_hosts"
        _ = known.write_text(
            "".join(
                f"{name} {(self.root / (name + '.pub')).read_text()}"
                for name in ["host", "guest"]
            )
        )
        self.config = self.root / "client.conf"
        ssh = shutil.which("ssh")
        assert ssh is not None
        _ = self.config.write_text(
            "Host host guest\n User fixture\n BatchMode yes\n"
            + " IdentitiesOnly yes\n StrictHostKeyChecking yes\n"
            + f" UserKnownHostsFile {known}\n GlobalKnownHostsFile /dev/null\n"
            + f" IdentityFile {self.root / 'client'}\n"
            + "Host host\n"
            + f" ProxyCommand {connector} vsock-mux{self.root / 'host.sock'}\n"
            + "Host guest\n"
            + f" ProxyCommand {ssh} -F {self.config} -T host connect drv.run.0123456789abcdef\n"
        )

    def stop_children(self) -> None:
        for child in self.children:
            if child.poll() is None:
                child.terminate()
        for child in self.children:
            try:
                _ = child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                _ = child.wait(timeout=5)

    def run_command(self, *args: str, expected: int = 0) -> None:
        result = subprocess.run(
            args,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            timeout=20,
            check=False,
        )
        self.test.assertEqual(result.returncode, expected, args)

    def mux(self, name: str, config: Path) -> None:
        listener = socket.socket(socket.AF_UNIX)
        listener.bind(str(self.root / f"{name}.sock"))
        listener.listen()
        listener.settimeout(0.1)
        stopped = threading.Event()
        sshd = shutil.which("sshd")
        assert sshd is not None
        errors: list[Exception] = []

        def accept() -> None:
            while not stopped.is_set():
                try:
                    connection = listener.accept()[0]
                except TimeoutError:
                    continue
                try:
                    with connection:
                        connection.settimeout(5)
                        request = bytearray()
                        while not request.endswith(b"\n") and len(request) < 32:
                            byte = connection.recv(1)
                            if not byte:
                                raise EOFError("incomplete mux request")
                            request.extend(byte)
                        if bytes(request) != b"CONNECT 22\n":
                            raise ValueError("invalid mux request")
                        connection.sendall(b"OK 22\n")
                        connection.settimeout(None)
                        child = subprocess.Popen(
                            [sshd, "-i", "-e", "-f", str(config)],
                            stdin=connection.fileno(),
                            stdout=connection.fileno(),
                            stderr=None,
                            env=dict(
                                self.env,
                                NSS_WRAPPER_PASSWD=str(
                                    self.root
                                    / ("guest-passwd" if name == "guest" else "passwd")
                                ),
                            ),
                        )
                        self.children.append(child)
                except (OSError, EOFError, ValueError) as error:
                    errors.append(error)

        thread = threading.Thread(target=accept, daemon=True)
        thread.start()

        def stop() -> None:
            stopped.set()
            thread.join(timeout=10)
            listener.close()
            self.test.assertFalse(thread.is_alive())
            self.test.assertEqual(errors, [])

        self.test.addCleanup(stop)

    def ssh(self, *args: str, expected: int = 0) -> None:
        self.run_command("ssh", "-F", str(self.config), *args, expected=expected)

    def wait_socket(self, path: Path, child: subprocess.Popen[bytes]) -> None:
        deadline = time.monotonic() + 10
        while not path.is_socket():
            self.test.assertIsNone(child.poll())
            self.test.assertLess(time.monotonic(), deadline)
            time.sleep(0.01)


class SSHTransport(unittest.TestCase):
    def test_commands_transfers_and_channels(self) -> None:
        fixture = SSHFixture(self)
        fixture.ssh("guest", "exit 37", expected=37)
        fixture.ssh("-tt", "guest", "test -t 0 && test -t 1")
        interactive = subprocess.run(
            ["ssh", "-F", str(fixture.config), "-tt", "guest"],
            input=b"touch interactive; exit 37\n",
            stdout=subprocess.DEVNULL,
            timeout=20,
            check=False,
        )
        self.assertEqual(interactive.returncode, 37)
        self.assertTrue((fixture.root / "workspace/interactive").is_file())
        fixture.ssh("guest", "test ! -e /proc/self/fd/3 && test ! -e /proc/self/fd/4")
        for command in [
            "connect ../abcdefghij",
            "connect drv.run.0123456789abcdef extra",
            f"connect drv.run.0123456789abcdef; touch {fixture.root / 'injected'}",
        ]:
            fixture.ssh("host", command, expected=1)
        self.assertFalse((fixture.root / "injected").exists())
        # Guest identity is verified independently of the outer SSH server.
        known = fixture.root / "known_hosts"
        original = known.read_bytes()
        _ = known.write_text(
            f"host {(fixture.root / 'host.pub').read_text()}"
            + f"guest {(fixture.root / 'wrong.pub').read_text()}"
        )
        fixture.ssh("guest", "true", expected=255)
        _ = known.write_bytes(original)
        guest_config = fixture.root / "guest.conf"
        settings = guest_config.read_text()
        _ = guest_config.write_text(
            settings.replace(
                str(fixture.root / "client.pub"), str(fixture.root / "wrong.pub")
            )
        )
        fixture.ssh("guest", f"touch {fixture.root / 'unauthorized'}", expected=255)
        self.assertFalse((fixture.root / "unauthorized").exists())
        _ = guest_config.write_text(settings)
        source = fixture.root / "source"
        _ = source.write_bytes(bytes(range(256)) * 8192)
        for legacy in [False, True]:
            options = ["-O"] if legacy else []
            remote = fixture.root / "uploaded"
            result = fixture.root / "downloaded"
            fixture.run_command(
                "scp",
                "-F",
                str(fixture.config),
                *options,
                str(source),
                f"guest:{remote}",
            )
            fixture.run_command(
                "scp",
                "-F",
                str(fixture.config),
                *options,
                f"guest:{remote}",
                str(result),
            )
            self.assertEqual(result.read_bytes(), source.read_bytes())
            remote.unlink()
            result.unlink()
        batch = fixture.root / "batch"
        downloaded = fixture.root / "sftp-result"
        _ = batch.write_text(
            f"put {source} {fixture.root / 'sftp'}\nget {fixture.root / 'sftp'} {downloaded}\n"
        )
        fixture.run_command(
            "sftp", "-F", str(fixture.config), "-b", str(batch), "guest"
        )
        self.assertEqual(downloaded.read_bytes(), source.read_bytes())
        downloaded.unlink()
        _ = guest_config.write_text(
            settings.replace(os.environ["SFTP_SERVER"], "internal-sftp")
        )
        fixture.run_command(
            "sftp", "-F", str(fixture.config), "-b", str(batch), "guest"
        )
        self.assertEqual(downloaded.read_bytes(), source.read_bytes())
        _ = guest_config.write_text(settings)
        control = fixture.root / "control"
        master = subprocess.Popen(
            ["ssh", "-F", str(fixture.config), "-M", "-S", str(control), "-N", "guest"]
        )
        fixture.children.append(master)
        fixture.wait_socket(control, master)
        fixture.ssh(
            "-S", str(control), "guest", f"touch {fixture.root / 'multiplexed'}"
        )
        self.assertTrue((fixture.root / "multiplexed").exists())
        fixture.ssh("-S", str(control), "-O", "exit", "guest")
        # OpenSSH clientloop initializes exit_status to -1 for -N. Unlike
        # SIGTERM, a mux terminate request does not replace it with zero.
        self.assertEqual(master.wait(timeout=5), 255)
        for direction in ["-L", "-R"]:
            with socket.socket() as service:
                service.bind(("127.0.0.1", 0))
                service.listen()
                service.settimeout(10)
                forwarded = fixture.root / ("forward" + direction)
                forwarder = subprocess.Popen(
                    [
                        "ssh",
                        "-F",
                        str(fixture.config),
                        "-o",
                        "ExitOnForwardFailure=yes",
                        direction,
                        f"{forwarded}:127.0.0.1:{service.getsockname()[1]}",
                        "-N",
                        "guest",
                    ]
                )
                fixture.children.append(forwarder)
                fixture.wait_socket(forwarded, forwarder)
                with socket.socket(socket.AF_UNIX) as client:
                    client.settimeout(10)
                    client.connect(str(forwarded))
                    connection = service.accept()[0]
                    with connection:
                        connection.sendall(b"forwarded")
                        self.assertEqual(client.recv(9), b"forwarded")
                forwarder.terminate()
                _ = forwarder.wait(timeout=5)
        agent_socket = fixture.root / "agent"
        agent = subprocess.Popen(
            ["ssh-agent", "-D", "-a", str(agent_socket)], stdout=subprocess.DEVNULL
        )
        fixture.children.append(agent)
        fixture.wait_socket(agent_socket, agent)
        agent_env = dict(os.environ, SSH_AUTH_SOCK=str(agent_socket))
        _ = subprocess.run(
            ["ssh-add", str(fixture.root / "client")], env=agent_env, check=True
        )
        _ = subprocess.run(
            [
                "ssh",
                "-F",
                str(fixture.config),
                "-A",
                "guest",
                f"ssh-add -T {fixture.root / 'client.pub'}",
            ],
            env=agent_env,
            check=True,
            timeout=20,
        )
        repository = fixture.root / "repository"
        checkout = fixture.root / "checkout"
        fixture.run_command("git", "init", "--bare", str(repository))
        ssh_command = f"ssh -F {fixture.config}"
        fixture.run_command(
            "git",
            "-c",
            f"core.sshCommand={ssh_command}",
            "clone",
            f"guest:{repository}",
            str(checkout),
        )
        _ = (checkout / "payload").write_bytes(source.read_bytes())
        fixture.run_command("git", "-C", str(checkout), "add", "payload")
        fixture.run_command(
            "git",
            "-C",
            str(checkout),
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "commit",
            "-m",
            "fixture",
        )
        fixture.run_command(
            "git",
            "-C",
            str(checkout),
            "-c",
            f"core.sshCommand={ssh_command}",
            "push",
            "origin",
            "HEAD:main",
        )
        # A command inside the guest authenticates with the forwarded agent,
        # not a private key copied into the guest or forwarded through the host.
        outgoing = (
            "ssh -F /dev/null -o IdentityFile=none -o User=fixture "
            + f"-o UserKnownHostsFile={known} -o StrictHostKeyChecking=yes "
            + f"-o ProxyCommand={shlex.quote(str(Path('connect.test').resolve()) + ' vsock-mux' + str(fixture.root / 'guest.sock'))}"
        )
        clone = fixture.root / "agent-clone"
        command = shlex.join(
            [
                "git",
                "-c",
                f"core.sshCommand={outgoing}",
                "clone",
                "-b",
                "main",
                f"guest:{repository}",
                str(clone),
            ]
        )
        _ = subprocess.run(
            ["ssh", "-F", str(fixture.config), "-A", "guest", command],
            env=agent_env,
            check=True,
            timeout=20,
        )
        self.assertEqual((clone / "payload").read_bytes(), source.read_bytes())

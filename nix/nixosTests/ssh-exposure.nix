{pkgs, ...}: let
  inherit (pkgs) lib;
  keys = import (pkgs.path + "/nixos/tests/ssh-keys.nix") pkgs;
  sftp = "${pkgs.openssh}/libexec/sftp-server";
  dispatcher = pkgs.writeShellApplication {
    name = "guest-dispatcher";
    runtimeInputs = [pkgs.coreutils pkgs.nix];
    text =
      lib.replaceStrings
      ["@sftp-pattern@" "@sftp-command@" "@command@" "@notifications-stream@"]
      [(lib.escapeShellArg sftp) sftp "${pkgs.coreutils}/bin/false" "exit 1"]
      (builtins.readFile ../../nixosModules/guest/guest.sh);
  };
  mux = pkgs.writeText "guest-mux.py" ''
    import os
    from pathlib import Path
    import shutil
    import signal
    import socket
    import subprocess

    directory = Path(os.environ["RUNTIME_DIRECTORY"])
    key = directory / "host-key"
    shutil.copyfile("${keys.snakeOilEd25519PrivateKey}", key)
    key.chmod(0o600)
    config = directory / "sshd.conf"
    config.write_text("\n".join([
        f"HostKey {key}",
        "UsePAM no",
        "PasswordAuthentication no",
        "KbdInteractiveAuthentication no",
        "AuthenticationMethods publickey",
        "StrictModes no",
        "AuthorizedKeysFile ${pkgs.writeText "client.pub" keys.snakeOilPublicKey}",
        "DisableForwarding yes",
        "ForceCommand ${lib.getExe dispatcher}",
        "Subsystem sftp ${sftp}",
    ]))
    listener = socket.socket(socket.AF_UNIX)
    listener.bind(str(directory / "notify.vsock"))
    listener.listen()
    notification = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
    notification.connect(os.environ["NOTIFY_SOCKET"].replace("@", "\0", 1))
    notification.send(b"READY=1")
    notification.close()
    signal.signal(signal.SIGCHLD, signal.SIG_IGN)
    while True:
        connection, _ = listener.accept()
        request = bytearray()
        while not request.endswith(b"\n"):
            byte = connection.recv(1)
            if not byte:
                break
            request.extend(byte)
        assert request == b"CONNECT 22\n"
        connection.sendall(b"OK 22\n")
        subprocess.Popen(
            ["${pkgs.openssh}/bin/sshd", "-i", "-e", "-f", str(config)],
            stdin=connection, stdout=connection,
        )
        connection.close()
  '';
  hold = pkgs.writeText "hold-connection.py" ''
    from pathlib import Path
    import socket
    import sys

    with socket.create_connection((sys.argv[1], 22), timeout=10) as connection:
        connection.settimeout(None)
        assert connection.recv(4096)
        Path(sys.argv[2] + ".ready").touch()
        while connection.recv(4096):
            pass
    Path(sys.argv[2] + ".closed").touch()
  '';
  inspect = pkgs.writeText "inspect-processes.py" ''
    from pathlib import Path
    import sys

    group = Path("/sys/fs/cgroup") / sys.argv[1].lstrip("/")
    pids = [int(pid) for pid in (group / "cgroup.procs").read_text().split()]
    assert len(pids) >= 2
    for pid in pids:
        fields = dict(line.split(":", 1) for line in Path(f"/proc/{pid}/status").read_text().splitlines())
        assert all(int(uid) == 1000 for uid in fields["Uid"].split())
        for name in ("CapInh", "CapPrm", "CapEff", "CapAmb"):
            assert int(fields[name], 16) == 0
        assert int(fields["NoNewPrivs"]) == 1
  '';
in {
  name = "ssh-exposure";
  qemu.forceAccel = false;
  nodes.machine = {
    imports = [../../nixosModules/host/ssh.nix];
    virtualisation.memorySize = 768;
    networking.useDHCP = false;
    networking.useNetworkd = true;
    environment.systemPackages = [pkgs.python3 pkgs.openssh];
    networking.nftables.enable = true;
    services.openssh = {
      enable = true;
      listenAddresses = [{addr = "127.0.0.1";}];
    };
    services.drv-run.ssh = {
      interfaces = ["client-host"];
      owners = {
        alice.prefix = "fd42:1:2:3::/64";
        bob.prefix = "fd42:1:2:4::/64";
      };
    };
    users.users = lib.genAttrs ["alice" "bob" "observer"] (name: {
      isNormalUser = true;
      uid =
        {
          alice = 1000;
          bob = 1001;
          observer = 1002;
        }.${
          name
        };
      linger = true;
      initialHashedPassword = "";
      openssh.authorizedKeys.keys = [keys.snakeOilPublicKey];
    });
    systemd.tmpfiles.rules = ["d /run/drv-run-environment 0755 root root -" "f /run/drv-run-environment/ready 0644 root root -"];
    systemd.user.services."drv.run@" = {
      serviceConfig = {
        Type = "notify";
        RuntimeDirectory = "drv.run.%i";
        RuntimeDirectoryMode = "0700";
        ExecStart = "${pkgs.python3}/bin/python3 ${mux}";
        ExecStartPost = "${pkgs.writeShellScript "provision" ''
          until test -f /tmp/ready-"$1"; do sleep 0.1; done
        ''} %i";
        KillMode = "control-group";
      };
    };
  };
  testScript = ''
    import shlex

    def user(name, command):
        uid = {"alice": 1000, "bob": 1001, "observer": 1002}[name]
        return (
            f"runuser -u {name} -- env XDG_RUNTIME_DIR=/run/user/{uid} "
            f"DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/{uid}/bus " + command
        )

    def unit(name, command):
        return user(name, "systemctl --user " + command)

    def active(name, service):
        machine.wait_until_succeeds(unit(name, f"is-active --quiet {service}"))

    def inactive(name, service):
        machine.wait_until_fails(unit(name, f"is-active --quiet {service}"))

    start_all()
    machine.wait_for_unit("multi-user.target")
    for uid in (1000, 1001, 1002):
        machine.wait_for_unit(f"user@{uid}.service")
    machine.succeed(
        "ip netns add client",
        "ip link add client-host type veth peer name client-net",
        "ip link set client-net netns client",
        "ip link set client-host up",
        "ip -6 addr add fd42:ffff::1/64 dev client-host nodad",
        "ip netns exec client ip link set lo up",
        "ip netns exec client ip link set client-net up",
        "ip netns exec client ip -6 addr add fd42:ffff::2/64 dev client-net nodad",
        "ip netns exec client ip -6 route add fd42:1:2::/48 via fd42:ffff::1",
        "ip -6 route get fd42:1:2:3::1",
        "install -m 600 ${keys.snakeOilPrivateKey} /root/client-key",
        "install -m 600 ${keys.snakeOilEd25519PrivateKey} /root/wrong-key",
    )
    machine.succeed("printf '%s\\n' " + shlex.quote("fd42:1:2:3::1 ${keys.snakeOilEd25519PublicKey}") + " > /root/known_hosts")
    first = "drv.run@0000000000.service"
    exposure = "drv-run-ssh@0000000000.service"
    second = "drv.run@0000000001.service"
    second_exposure = "drv-run-ssh@0000000001.service"

    with subtest("provisioning gates exposure"):
        machine.succeed(unit("alice", f"start --no-block {first}"))
        machine.wait_for_file("/run/user/1000/drv.run.0000000000/notify.vsock")
        machine.fail(unit("alice", f"is-active --quiet {exposure}"))
        machine.succeed("touch /tmp/ready-0000000000 /tmp/ready-0000000001")
        active("alice", exposure)
        machine.succeed(unit("alice", f"start {second}"), unit("bob", f"start {first}"))
        active("alice", second_exposure)
        active("bob", exposure)

    with subtest("binding authority and owner isolation"):
        machine.fail(user("observer", "/run/wrappers/bin/sshx.bind 0000000000"))
        machine.fail(user("alice", "/run/wrappers/bin/sshx.bind ../0000000"))
        machine.fail(user("alice", "/run/wrappers/bin/sshx.bind 0000000000 fd42:1:2:4::1"))
        machine.fail(user("bob", "test -r /run/user/1000/drv.run.0000000000/host-key"))
        bind = "import socket; s=socket.socket(socket.AF_INET6); s.bind(('::1',22))"
        machine.fail(user("alice", "python3 -c " + shlex.quote(bind)))
        machine.succeed("python3 -c \"import socket; socket.create_connection(('127.0.0.1',22),5).close()\"")
        # Even a wildcard listener must not become reachable on the guest prefix.
        machine.succeed("systemd-run --unit=unrelated python3 -m http.server 8080 --bind ::")
        machine.wait_for_open_port(8080)
        blocked = "import socket; socket.create_connection(('fd42:1:2:3::1',8080),1)"
        machine.fail("ip netns exec client python3 -c " + shlex.quote(blocked))
        # Local ingress is not in the configured interface allowlist either.
        machine.fail("python3 -c " + shlex.quote(blocked.replace("8080", "22")))

    client_options = "-F /dev/null -oBatchMode=yes -oStrictHostKeyChecking=yes -oUserKnownHostsFile=/root/known_hosts -oIdentityFile=/root/client-key -oIdentitiesOnly=yes"
    with subtest("SCP and SFTP reach the guest dispatcher without nix develop"):
        machine.succeed("python3 -c \"from pathlib import Path; Path('/tmp/input').write_bytes(bytes(range(256))*8192)\"")
        machine.succeed(f"ip netns exec client scp {client_options} /tmp/input 'alice@[fd42:1:2:3::1]:/home/alice/upload'")
        machine.succeed(f"ip netns exec client scp {client_options} 'alice@[fd42:1:2:3::1]:/home/alice/upload' /tmp/download")
        machine.succeed("cmp /tmp/input /tmp/download")
        machine.succeed("printf 'get /home/alice/upload /tmp/sftp-download\\n' > /tmp/batch")
        machine.succeed(f"ip netns exec client sftp {client_options} -b /tmp/batch 'alice@[fd42:1:2:3::1]'")
        machine.succeed("cmp /tmp/input /tmp/sftp-download")
        wrong_key = client_options.replace("IdentityFile=/root/client-key", "IdentityFile=/root/wrong-key")
        machine.fail(f"ip netns exec client sftp {wrong_key} -b /tmp/batch 'alice@[fd42:1:2:3::1]'")
        machine.succeed("printf '%s\\n' " + shlex.quote("fd42:1:2:3::1 ${keys.snakeOilPublicKey}") + " > /root/wrong-host")
        wrong_host = client_options.replace("known_hosts", "wrong-host")
        machine.fail(f"ip netns exec client sftp {wrong_host} -b /tmp/batch 'alice@[fd42:1:2:3::1]'")

    with subtest("connection ownership and independent exposure stop"):
        machine.succeed("systemd-run --unit=hold-first ip netns exec client ${pkgs.python3}/bin/python3 ${hold} fd42:1:2:3::1 /tmp/first")
        machine.succeed("systemd-run --unit=hold-second ip netns exec client ${pkgs.python3}/bin/python3 ${hold} fd42:1:2:3::2 /tmp/second")
        machine.wait_for_file("/tmp/first.ready")
        machine.wait_for_file("/tmp/second.ready")
        group = machine.succeed(unit("alice", f"show {exposure} -p ControlGroup --value")).strip()
        machine.succeed("python3 ${inspect} " + shlex.quote(group))
        machine.succeed(unit("alice", f"stop {exposure}"))
        machine.wait_for_file("/tmp/first.closed")
        machine.succeed(unit("alice", f"is-active --quiet {first}"))
        machine.succeed(unit("alice", f"is-active --quiet {second_exposure}"))
        machine.fail("test -e /tmp/second.closed")
        machine.fail("test -d /sys/fs/cgroup" + group)
        machine.fail(unit("alice", f"is-active --quiet {exposure}"))
        machine.succeed(unit("alice", f"start {exposure}"))
        active("alice", exposure)
        machine.succeed(unit("alice", f"stop {second}"))
        machine.wait_for_file("/tmp/second.closed")
        inactive("alice", second_exposure)

    with subtest("spoofed environment and occupied endpoint"):
        machine.succeed(unit("alice", f"stop {exposure}"))
        machine.succeed(user("alice", "systemd-run --user --unit=occupied --property=Type=notify env UID=1001 USER=bob XDG_RUNTIME_DIR=/run/user/1001 LISTEN_PIDFDID=0 LISTEN_FDS=99 /run/wrappers/bin/sshx.bind 0000000000"))
        active("alice", "occupied.service")
        machine.succeed(f"ip netns exec client scp {client_options} 'alice@[fd42:1:2:3::1]:/home/alice/upload' /tmp/owner-check")
        machine.succeed("cmp /tmp/input /tmp/owner-check")
        machine.fail(unit("alice", f"start {exposure}"))
        machine.wait_until_succeeds(unit("alice", f"is-failed --quiet {exposure}"))
        machine.succeed(unit("alice", f"is-active --quiet {first}"))
        machine.succeed(unit("alice", "stop occupied.service"))
        machine.succeed(unit("alice", f"reset-failed {exposure}"))
        machine.succeed(unit("alice", f"start {exposure}"))
        active("alice", exposure)

    with subtest("guest failure and restart"):
        machine.succeed(unit("alice", f"kill --signal=KILL {first}"))
        inactive("alice", exposure)
        machine.succeed(unit("alice", f"restart {first}"))
        active("alice", exposure)
        machine.succeed(f"ip netns exec client scp {client_options} 'alice@[fd42:1:2:3::1]:/home/alice/upload' /tmp/after-restart")
        machine.succeed("cmp /tmp/input /tmp/after-restart")
        machine.succeed(unit("alice", f"kill --signal=KILL {exposure}"))
        active("alice", exposure)
        machine.succeed(unit("alice", f"is-active --quiet {first}"))
  '';
}

{
  nixosModules,
  pkgs,
}: let
  tap = import ../nixosModules/host/tap.nix {inherit pkgs;};
  shell = pkgs.mkShell {
    packages = [pkgs.curl pkgs.python3 pkgs.iproute2];
    shellHook = "export DRV_RUN_TEST_READY=1";
  };
  payload = pkgs.writeText "egress-payload" "offline Guest egress\n";
  webroot = pkgs.runCommand "egress-webroot" {} ''
    mkdir -p $out
    cp ${payload} $out/payload
  '';
  keys = import (pkgs.path + "/nixos/tests/ssh-keys.nix") pkgs;
  fixture = pkgs.writeText "flake.nix" ''
    {
      inputs.nixpkgs.url = "path:${pkgs.path}";
      outputs = { nixpkgs, ... }: {
        devShells.x86_64-linux.default = let pkgs = nixpkgs.legacyPackages.x86_64-linux; in pkgs.mkShell {
          packages = [pkgs.curl pkgs.python3 pkgs.iproute2];
          shellHook = "export DRV_RUN_TEST_READY=1";
        };
      };
    }
  '';
in {
  name = "host-basic";
  qemu.forceAccel = true;
  nodes = {
    client = {
      # Public/sensitive destinations on an isolated VLAN, never the Internet.
      networking = {
        interfaces.lo.ipv4.addresses =
          map (address: {
            inherit address;
            prefixLength = 32;
          }) [
            "93.184.216.34"
            "169.254.169.254"
            "100.64.0.2"
            "10.42.0.2"
            "198.18.0.1"
          ];
        firewall.allowedTCPPorts = [53 80];
        firewall.allowedUDPPorts = [53];
      };
      services = {
        dnsmasq = {
          enable = true;
          resolveLocalQueries = false;
          settings = {
            no-resolv = true;
            no-hosts = true;
            address = "/egress.test/93.184.216.34";
          };
        };
        nginx = {
          enable = true;
          commonHttpConfig = ''log_format peer escape=json '{"peer":"$remote_addr"}';'';
          virtualHosts.default = {
            default = true;
            root = webroot;
            extraConfig = "access_log /var/log/nginx/peers.json peer;";
          };
        };
      };
      systemd.services.nginx = {
        requires = ["network-addresses-lo.service"];
        after = ["network-addresses-lo.service"];
      };
      environment.systemPackages = [pkgs.curl];
      environment.etc."ssh/client-key" = {
        source = keys.snakeOilPrivateKey;
        mode = "0600";
      };
      programs.ssh = {
        extraConfig = ''
          Host host
            User operator
            IdentityFile /etc/ssh/client-key
            IdentitiesOnly yes
            BatchMode yes
            StrictHostKeyChecking yes
        '';
        knownHosts.host.publicKey = keys.snakeOilEd25519PublicKey;
      };
    };
    host = {
      imports = [nixosModules.host];
      services.drv-run.network = {
        uplink = "eth1";
        dnsServers = ["192.168.1.1"];
      };
      environment.systemPackages = with pkgs; [curl e2fsprogs python3];
      networking.interfaces.eth1.ipv4.routes = map (address: {
        inherit address;
        prefixLength = 32;
        via = "192.168.1.1";
      }) ["93.184.216.34" "169.254.169.254" "100.64.0.2" "10.42.0.2" "198.18.0.1"];
      networking.firewall.allowedTCPPorts = [8080];
      systemd.services.host-listener = {
        wantedBy = ["multi-user.target"];
        serviceConfig.ExecStart = "${pkgs.python3}/bin/python3 -m http.server 8080 --bind 0.0.0.0";
      };
      virtualisation = {
        memorySize = 10240;
        cores = 2;
        diskSize = 20480;
        qemu.options = ["-cpu" "host"];
        additionalPaths = [shell pkgs.path];
      };
      users.users = {
        operator = {
          isNormalUser = true;
          uid = 1000;
          group = "operator";
          openssh.authorizedKeys.keys = [keys.snakeOilPublicKey];
        };
        other = {
          isNormalUser = true;
          uid = 1001;
          group = "other";
          openssh.authorizedKeys.keys = [keys.snakeOilPublicKey];
        };
        disabled = {
          enable = false;
          isNormalUser = true;
          uid = 1002;
        };
        root.openssh.authorizedKeys.keys = [keys.snakeOilPublicKey];
      };
      users.groups = {
        operator.gid = 1000;
        other.gid = 1001;
      };
      services.openssh = {
        hostKeys = [
          {
            path = "/etc/ssh/ssh_host_ed25519_key";
            type = "ed25519";
          }
        ];
        settings.PermitRootLogin = "prohibit-password";
      };
      environment.etc."ssh/ssh_host_ed25519_key" = {
        source = keys.snakeOilEd25519PrivateKey;
        mode = "0600";
      };
      nix = {
        enable = true;
        settings = {
          experimental-features = ["nix-command" "flakes"];
          sandbox = true;
          substituters = pkgs.lib.mkForce [];
        };
      };
    };
  };
  testScript = {nodes, ...}: ''
    import ipaddress
    import json
    import shlex
    from datetime import timedelta

    def as_user(user: str, command: str):
        return "su --login " + shlex.quote(user) + " --command " + shlex.quote(command)

    def operator(command: str):
        return host.succeed(as_user("operator",
            "export XDG_RUNTIME_DIR=/run/user/1000; " + command
        ))

    def guest(command: str, user: str = "operator", address = None):
        # Supply a terminal while exercising the exact reconnect command.
        status, output = host.execute(as_user(user, "printf '%s\\n' " + shlex.quote("set -e; test -t 0; " + command + "; exit")
            + " | TERM=xterm-256color ${pkgs.util-linux}/bin/script --quiet --return --command "
            + shlex.quote("ssh " + (address or target)) + " /dev/null"))
        if status != 0:
            host.log(repr(output))
            for diagnostic in ["ip -j addr; ip route", "nft list ruleset", "journalctl -b -u systemd-networkd -u systemd-nsresourced --no-pager"]:
                host.log(host.execute(diagnostic)[1])
            raise Exception(f"Guest command failed ({status}): {command}")

    def instance_units():
        reply = json.loads(operator("busctl --user --json=short call org.freedesktop.systemd1 "
            "/org/freedesktop/systemd1 org.freedesktop.systemd1.Manager ListUnits"))
        return {row[0]: row[6] for row in reply["data"][0] if row[0].startswith("drv.run@")}

    def links():
        return [link["ifname"] for link in json.loads(host.succeed("ip -j link")) if link["ifname"].startswith("ns-")]

    def egress(user = "operator", address = None):
        guest("curl --fail --silent --show-error --max-time 15 http://egress.test/payload -o /workspace/payload || { ip addr; ip route; resolvectl status; journalctl -b -u systemd-networkd --no-pager; exit 1; }; "
              "test -s /workspace/payload", user, address)

    def blocked(destination: str, port: int = 80, user = "operator", address = None):
        guest(f"if curl --noproxy '*' --silent --max-time 2 http://{destination}:{port}/; then exit 1; fi", user, address)

    def source_drops():
        rules = json.loads(host.succeed("nft -j list chain inet drv-run source"))["nftables"]
        return sum(expr["counter"]["packets"] for entry in rules if "rule" in entry
                   for expr in entry["rule"]["expr"] if "counter" in expr)

    def network(tap_name: str):
        data = json.loads(host.succeed(f"ip -j -4 addr show dev {tap_name}"))[0]["addr_info"][0]
        net = ipaddress.ip_interface(f'{data["local"]}/{data["prefixlen"]}').network
        neighbors = json.loads(host.succeed(f"ip -j -4 neigh show dev {tap_name}"))
        addresses = [entry["dst"] for entry in neighbors if ipaddress.ip_address(entry["dst"]) in net]
        t.assertEqual(len(addresses), 1)
        return data["local"], addresses[0], net

    def service_ssh(key: str, known_hosts: str):
        # Isolate identities from additive Host SSH configuration.
        options = [
            "ssh", "-F", "/dev/null", "-i", key,
            "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
            "-o", "IdentityAgent=none", "-o", "StrictHostKeyChecking=yes",
            "-o", "GlobalKnownHostsFile=/dev/null",
            "-o", "UserKnownHostsFile=" + known_hosts,
            "-o", "ProxyUseFdpass=yes", "-o", "ConnectTimeout=2",
            "-o", "ProxyCommand=${nodes.host.systemd.package}/lib/systemd/systemd-ssh-proxy vsock-mux" + runtime + "/notify.vsock %p",
            "root@" + target, "root-environment",
        ]
        return shlex.join(options)

    start_all()
    host.wait_for_unit("default.target")
    host.wait_for_unit("sshd.service")
    client.wait_for_unit("default.target")
    client.wait_for_unit("nginx.service")
    client.wait_for_unit("dnsmasq.service")
    host.succeed("curl -fsS http://93.184.216.34/payload >/dev/null")

    with subtest("normal accounts receive lifecycle prerequisites automatically"):
        host.succeed("test -f /etc/systemd/user/drv.run@.service")
        host.fail("getent passwd drvrun")
        host.fail("getent group drvrun")
        host.fail("getent passwd disabled")
        host.fail("test -e /var/lib/systemd/linger/disabled")
        for user, uid in [("operator", 1000), ("other", 1001)]:
            host.wait_for_unit(f"user@{uid}.service")
            host.wait_until_succeeds(f"test -S /run/user/{uid}/bus")
            host.wait_for_unit("default.target", user=user)
            host.succeed(f"test -f /var/lib/systemd/linger/{user}")
            host.succeed(as_user(user, "test -r /dev/kvm && test -w /dev/kvm"))
            client.succeed(f"ssh {user}@host </dev/null")
            status, _ = host.systemctl("is-active --quiet 'drv.run@*.service'", user=user)
            t.assertEqual(status, 4) # no instantiated units match the pattern
            for request in [" ", " leading-whitespace", f"-invalid; touch /home/{user}/not-a-launcher-command"]:
                status, _ = client.execute(f"ssh -- {user}@host " + shlex.quote(request) + " </dev/null")
                t.assertEqual(status, 2)
            # Local callers must also supply the complete request, not positional commands.
            status, _ = host.execute(as_user(user,
                "SSH_ORIGINAL_COMMAND=path:/does-not-exist drv.run exit </dev/null"))
            t.assertEqual(status, 2)
            host.fail(f"test -e /home/{user}/not-a-launcher-command")
            host.fail(f"test -d /home/{user}/.local/state/drv.run")

    with subtest("system accounts retain ordinary SSH behavior"):
        client.succeed("ssh root@host 'touch /root/ordinary-ssh'")
        host.succeed("test -f /root/ordinary-ssh")

    with subtest("SSH creation runs as the authenticated owner"):
        operator("mkdir /home/operator/flake")
        operator("cp ${fixture} /home/operator/flake/flake.nix")
        operator("nix flake lock --offline path:/home/operator/flake")
        client.succeed("printf '%s\\n' " + shlex.quote(
            "set -e; test -t 0; touch /workspace/created; exit"
        ) + " | ssh -tt host path:/home/operator/flake", timeout=timedelta(minutes=15))

        # Discover the ID from durable state, not launcher output.
        instances = operator("find /home/operator/.local/state/drv.run -mindepth 1 -maxdepth 1 -type d").splitlines()
        t.assertEqual(len(instances), 1)
        state = instances[0]
        instance_id = state.rsplit("/", 1)[1]
        target = "drv.run." + instance_id
        runtime = "/run/user/1000/" + target
        unit = "drv.run@" + instance_id + ".service"
        operator(f"systemctl --user is-active --quiet {unit}")
        operator(f'test "$(stat -c %u /proc/$(systemctl --user show -p MainPID --value {unit}))" -eq 1000')
        for path in [state, runtime]:
            host.succeed(f'test "$(stat -c %u {path})" -eq 1000 && test "$(stat -c %a {path})" -eq 700')
        for path in [f"{state}/host-key", f"{runtime}/client-key", f"{runtime}/client.conf"]:
            host.succeed(f'test "$(stat -c %u {path})" -eq 1000 && test "$(stat -c %a {path})" -eq 600')
        host.succeed(f'test "$(stat -c %u {state}/state.img)" -eq 1000')
        host.succeed(f'test -S {runtime}/notify.vsock && test "$(stat -c %u {runtime}/notify.vsock)" -eq 1000')
        host.fail(f"test -e {runtime}/ssh.sock || test -e /run/drv.run-network")
        host.fail(f"test -S {runtime}/provision-ssh")
        pid = int(operator(f"systemctl --user show -p MainPID --value {unit}"))
        status = dict(line.split(":", 1) for line in host.succeed(f"cat /proc/{pid}/status").splitlines())
        t.assertEqual([int(uid) for uid in status["Uid"].split()], [1000] * 4)
        t.assertEqual(int(status["CapEff"].strip(), 16), 0)
        # The VMM stays in the Host user namespace and pins a distinct, empty
        # namespace by FD solely for nsresourced resource lifetime tracking.
        host.succeed(f"test /proc/{pid}/ns/user -ef /proc/1/ns/user")
        probe = "from pathlib import Path; import os; "
        probe += f"assert any(os.readlink(fd).startswith('user:[') for fd in Path('/proc/{pid}/fd').iterdir())"
        host.succeed("python3 -c " + shlex.quote(probe))
        info = json.loads(operator(f"curl -fsS --unix-socket {runtime}/control.sock http://localhost/api/v1/vm.info"))
        t.assertEqual(len(info["config"]["net"]), 1)
        t.assertEqual(info["config"]["net"][0]["num_queues"], 2)
        t.assertEqual(info["config"]["vsock"]["cid"], 42)

    with subtest("host and guest use the configured Nix implementation"):
        expected = "${nodes.host.nix.package.version}"
        t.assertEqual(json.loads(host.succeed("nix eval --json --expr builtins.nixVersion")), expected)
        t.assertEqual(json.loads(operator(f"ssh -T {target} nix eval --json --expr builtins.nixVersion")), expected)
        for settings in [json.loads(host.succeed("nix config show --json")),
                         json.loads(operator(f"ssh -T {target} nix config show --json"))]:
            t.assertTrue(settings["eval-cache"]["value"])
            t.assertTrue(settings["sandbox"]["value"])
            t.assertTrue(settings["require-sigs"]["value"])
            t.assertTrue(settings["fsync-metadata"]["value"])

    with subtest("listing does not restart a running Instance"):
        client.succeed("ssh operator@host </dev/null")
        operator(f"systemctl --user is-active --quiet {unit}")
        operator(f'test "$(systemctl --user show -p MainPID --value {unit})" -eq {pid}')
        guest("test -f /workspace/created")

    with subtest("owner reconnects without sudo or connection flags"):
        guest('test "$TERM" = xterm-256color; test "$DRV_RUN_TEST_READY" = 1')
        guest("systemctl is-system-running --wait || { journalctl -b -u 'persist-*.service' --no-pager; exit 1; }")
        guest("test $(id -u) -eq 0; test -f /workspace/created; cp /etc/hostname /workspace/retained; touch /root/discarded")
        guest("test -f /root/discarded; cmp /etc/hostname /workspace/retained")
        guest("systemctl is-active --quiet sshd-vsock.socket; test $(ss -H -ltn 'sport = :22' | wc -l) -eq 0")
        guest("test $(find /sys/class/net -mindepth 1 -maxdepth 1 | wc -l) -eq 2; test -d /sys/class/net/lo")
        guest('test -r /run/drv-run-seed/environment-path; '
              'findmnt -n -O ro,nodev,nosuid,noexec /run/drv-run-seed >/dev/null; '
              'found=false; for key in /run/credentials/*/authorized-keys; do '
              'test -f "$key" || continue; cmp /run/drv-run-seed/authorized-keys "$key"; '
              'cmp /run/drv-run-seed/host-key "$(dirname "$key")/host-key"; '
              'found=true; done; "$found"')
        operator(f"systemctl --user is-active --quiet {unit}")
        status, _ = host.execute(as_user("operator", f"ssh {target} drv-run-command-does-not-exist </dev/null"))
        t.assertEqual(status, 127)

    with subtest("VSOCK notifications tolerate immediate privileged source-port reuse"):
        # sd_notify binds the highest free privileged source port. A stale reset
        # response must not abort the next connection using that same tuple.
        probe = """
    import errno
    import socket
    for _ in range(256):
        with socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM) as sock:
            sock.settimeout(2)
            for port in range(1023, 0, -1):
                try:
                    sock.bind((socket.VMADDR_CID_ANY, port))
                    break
                except OSError as error:
                    if error.errno != errno.EADDRINUSE:
                        raise
            else:
                raise RuntimeError("No privileged VSOCK source port available")
            sock.connect((2, 8888))
            sock.sendall(b"STATUS=port-reuse-regression")
            sock.shutdown(socket.SHUT_WR)
            assert sock.recv(1) == bytes()
    """
        guest("python3 -c " + shlex.quote(probe))
        operator(f"systemctl --user is-active --quiet {unit}")

    with subtest("launcher forwards commands and propagates their exit status"):
        input_payload = "  stdin with spaces\nsecond line\n"
        arguments = ["two  spaces", "", "double\" single' back\\slash", "line one\nline two",
                     "$HOME", "$(touch /tmp/drv-run-command-literal)", "*"]
        shell_probe = (
            "set -e\n"
            'test "$(touch /tmp/drv-run-command-guest; id -u)" -eq 0\n'
            'test "$PWD" = /workspace\n'
            'test "$DRV_RUN_TEST_READY" = 1\n'
            "test ! -t 0\n"
            "curl --version >/dev/null\n"
            "python3 -c " + shlex.quote(
                "import sys; from pathlib import Path; "
                f"assert sys.stdin.read() == {input_payload!r}; "
                f"assert sys.argv[1:] == {arguments!r}; "
                "Path('/workspace/command-file').touch()"
            ) + " " + shlex.join(arguments) + "\n"
            "printf '%s\\n' 'one  two' | tee /workspace/command-pipe >/dev/null\n"
            "test -s /workspace/command-pipe\n"
            "test ! -e /tmp/drv-run-command-literal\n"
        )
        for transport, remote_command, expected_status in [
            ("-T", "exit", 0),
            ("-T", "exit 7", 7),
            ("-T", "drv-run-command-does-not-exist", 127),
            ("-T", shell_probe, 0),
            ("-tt", "test -t 0 && test -t 1", 0),
            ("-T", "-oProxyCommand=touch /tmp/drv-run-ssh-option", 2),
            ("local", "exit", 0),
        ]:
            before = set(instance_units())
            # Exercise a whitespace separator without splitting or unquoting the command.
            request = "path:/home/operator/flake" + ("\t  " if remote_command == shell_probe else " ") + remote_command
            if transport == "local":
                status, _ = host.execute(as_user("operator",
                    "env " + shlex.quote("SSH_ORIGINAL_COMMAND=" + request) + " drv.run </dev/null"),
                    timeout=timedelta(minutes=15))
            else:
                status, _ = client.execute(
                    "printf '%s' " + shlex.quote(input_payload) + f" | ssh {transport} host " + shlex.quote(request),
                    timeout=timedelta(minutes=15))
            t.assertEqual(status, expected_status)
            created = set(instance_units()) - before
            t.assertEqual(len(created), 1)
            command_unit = created.pop()
            command_id = command_unit.removeprefix("drv.run@").removesuffix(".service")
            command_target = "drv.run." + command_id
            command_state = "/home/operator/.local/state/drv.run/" + command_id
            operator(f"systemctl --user is-active --quiet {command_unit}")
            operator(f"printf '%s\\n' path:/home/operator/flake | cmp - {command_state}/reference")
            if remote_command == shell_probe:
                operator(f"ssh {command_target} 'test -f /workspace/command-file && test -s /workspace/command-pipe' </dev/null")
            for marker in ["drv-run-command-guest", "drv-run-command-literal", "drv-run-ssh-option"]:
                host.fail(f"test -e /tmp/{marker}")
                client.fail(f"test -e /tmp/{marker}")
            operator(f"systemctl --user stop {command_unit}")
            operator(f"systemctl --user clean --what=state {command_unit}")
        operator(f"systemctl --user is-active --quiet {unit}")
        guest("test -f /workspace/created")

    with subtest("failed environment evaluation cannot publish prepared Instance state"):
        before = set(instance_units())
        prior_links = links()
        status, _ = client.execute("ssh -T host path:/does-not-exist exit </dev/null")
        t.assertNotEqual(status, 0)
        created = set(instance_units()) - before
        t.assertEqual(len(created), 1)
        failed_unit = created.pop()
        failed_id = failed_unit.removeprefix("drv.run@").removesuffix(".service")
        failed_state = "/home/operator/.local/state/drv.run/" + failed_id
        operator(f"systemctl --user is-failed --quiet {failed_unit}")
        operator(f"test -d {failed_state}/creating; test ! -e {failed_state}/ready")
        operator(f'test "$(systemctl --user show -p MainPID --value {failed_unit})" -eq 0')
        host.wait_until_fails("test -e /run/user/1000/drv.run." + failed_id)
        t.assertEqual(links(), prior_links)
        # Listing a failed creation must neither retry it nor clear its failure.
        client.succeed("ssh operator@host </dev/null")
        operator(f"systemctl --user is-failed --quiet {failed_unit}")
        operator(f"test -d {failed_state}/creating; test ! -e {failed_state}/ready")
        t.assertEqual(links(), prior_links)
        operator(f"systemctl --user reset-failed {failed_unit}")
        operator(f"systemctl --user clean --what=state {failed_unit}")
        guest("test -f /workspace/created")

    for failed_id, collision in [("diskfailure", "state.img"), ("rootfailure", "runner")]:
        with subtest(f"failed {collision} creation cannot publish prepared Instance state"):
            failed_unit = f"drv.run@{failed_id}.service"
            failed_state = f"/home/operator/.local/state/drv.run/{failed_id}"
            failed_runtime = f"/run/user/1000/drv.run.{failed_id}"
            prior_links = links()
            # A colliding object must fail creation, never be overwritten.
            operator(f"mkdir -p {failed_state}/{collision} {failed_runtime}")
            operator(f"printf '%s\\n' path:/home/operator/flake >{failed_runtime}/reference")
            host.fail(as_user("operator", f"XDG_RUNTIME_DIR=/run/user/1000 systemctl --user start {failed_unit}"))
            operator(f"systemctl --user is-failed --quiet {failed_unit}")
            operator(f"test -d {failed_state}/{collision}; test -d {failed_state}/creating; test ! -e {failed_state}/ready")
            operator(f'test "$(systemctl --user show -p MainPID --value {failed_unit})" -eq 0')
            host.wait_until_fails(f"test -e {failed_runtime}")
            t.assertEqual(links(), prior_links)
            operator(f"systemctl --user reset-failed {failed_unit}")
            operator(f"systemctl --user clean --what=state {failed_unit}")
            guest("test -f /workspace/created")

    with subtest("other users cannot access the owner's Instance"):
        for path in [f"{runtime}/client.conf", f"{runtime}/client-key", f"{runtime}/seed.img", f"{state}/host-key", f"{state}/state.img"]:
            host.fail(as_user("other", f"test -r {path}"))
        host.fail(as_user("other", f"ssh {target} </dev/null"))
        # Supplying the owner's configuration explicitly must not bypass isolation.
        host.fail(as_user("other", f"ssh -F {runtime}/client.conf {target} </dev/null"))
        host.fail(as_user("operator", "ssh drv.run.nonexistent </dev/null"))
        probe = "import errno,socket; s=socket.socket(socket.AF_UNIX); "
        probe += f"\ntry: s.connect('{runtime}/notify.vsock')\nexcept OSError as e: assert e.errno == errno.EACCES\nelse: raise AssertionError('foreign socket access')"
        host.succeed(as_user("other", "python3 -c " + shlex.quote(probe)))

    with subtest("networkd DHCP, DNS and NAT supply offline egress"):
        t.assertEqual(len(links()), 1)
        tap_name = links()[0]
        host.succeed(f"test $(cat /sys/class/net/{tap_name}/owner) -eq 1000")
        client.succeed("truncate -s 0 /var/log/nginx/peers.json")
        egress()
        gateway, guest_ip, subnet = network(tap_name)
        t.assertEqual(subnet.prefixlen, 28)
        peers = [json.loads(line)["peer"] for line in client.succeed("cat /var/log/nginx/peers.json").splitlines()]
        t.assertEqual(peers, ["192.168.1.2"])
        guest("ip -j addr show > /workspace/addresses.json; python3 -c " + shlex.quote(
            "import json; assert any(a.get('local') == '" + guest_ip + "' for i in json.load(open('/workspace/addresses.json')) for a in i.get('addr_info', []))"))
        host.succeed("test -d /sys/fs/bpf/systemd/userns-restrict/programs && test -d /sys/fs/bpf/systemd/userns-restrict/maps")

    with subtest("Host, sensitive destinations and unsolicited ingress are blocked"):
        # Prove listeners are reachable outside the Guest before negative tests.
        client.succeed("curl -fsS http://host:8080/ >/dev/null")
        for destination in ["192.168.1.1", "169.254.169.254", "100.64.0.2", "10.42.0.2", "198.18.0.1"]:
            host.succeed(f"curl -fsS http://{destination}/payload >/dev/null")
            blocked(destination)
        blocked(gateway, 8080)
        blocked("192.168.1.2", 8080)
        guest("systemctl stop firewall; systemd-run --unit=egress-listener python3 -m http.server 8080 --bind 0.0.0.0")
        guest("curl --retry 5 --retry-connrefused --retry-delay 1 -fsS http://127.0.0.1:8080/ >/dev/null")
        host.fail(f"curl --max-time 2 http://{guest_ip}:8080/")
        client.succeed(f"ip route replace {subnet} via 192.168.1.2")
        client.fail(f"curl --max-time 2 http://{guest_ip}:8080/")
        host.succeed("systemctl restart nftables.service")
        egress()
        blocked("169.254.169.254")
        blocked(gateway, 8080)

    with subtest("source spoofing and IPv6 cannot bypass Host policy"):
        drops = source_drops()
        guest("dev=$(find /sys/class/net -mindepth 1 ! -name lo -printf '%f'); ip addr add 10.254.254.254/32 dev $dev; if curl --noproxy '*' --interface 10.254.254.254 --max-time 2 http://93.184.216.34/payload; then exit 1; fi; ip addr del 10.254.254.254/32 dev $dev")
        t.assertGreater(source_drops(), drops)
        host.succeed(f"ip -6 addr add fd42::1/64 dev {tap_name}")
        host.succeed("systemd-run --unit=ipv6-listener ${pkgs.python3}/bin/python3 -m http.server 8081 --bind ::")
        host.wait_until_succeeds("curl -g -fsS http://[::1]:8081/ >/dev/null")
        drops = source_drops()
        guest("dev=$(find /sys/class/net -mindepth 1 ! -name lo -printf '%f'); ip -6 addr add fd42::2/64 dev $dev; if curl --noproxy '*' -g --max-time 2 http://[fd42::1]:8081/; then exit 1; fi; ip -6 addr del fd42::2/64 dev $dev")
        t.assertGreater(source_drops(), drops)
        host.succeed(f"ip -6 addr del fd42::1/64 dev {tap_name}")
        egress()

    with subtest("two owners have disjoint networks and cannot reach each other"):
        host.succeed(as_user("other", "mkdir /home/other/flake"))
        host.succeed(as_user("other", "cp ${fixture} /home/other/flake/flake.nix"))
        host.succeed(as_user("other", "nix flake lock --offline path:/home/other/flake"))
        client.succeed("printf '%s\\n' 'touch /workspace/peer; exit' | ssh -tt other@host path:/home/other/flake", timeout=timedelta(minutes=15))
        other_state = host.succeed(as_user("other", "find /home/other/.local/state/drv.run -mindepth 1 -maxdepth 1 -type d")).strip()
        other_id = other_state.rsplit("/", 1)[1]
        other_target = "drv.run." + other_id
        other_unit = "drv.run@" + other_id + ".service"
        egress("other", other_target)
        t.assertEqual(len(links()), 2)
        other_tap = next(link for link in links() if link != tap_name)
        other_gateway, other_ip, other_subnet = network(other_tap)
        t.assertFalse(subnet.overlaps(other_subnet))
        host.succeed(f"test $(cat /sys/class/net/{other_tap}/owner) -eq 1001")
        guest("systemctl stop firewall; systemd-run --unit=egress-listener python3 -m http.server 8080 --bind 0.0.0.0", "other", other_target)
        guest("curl --retry 5 --retry-connrefused --retry-delay 1 -fsS http://127.0.0.1:8080/ >/dev/null", "other", other_target)
        blocked(other_ip, 8080)
        blocked(guest_ip, 8080, "other", other_target)
        # TUNSETIFF on the owner's live TAP must fail for another Host UID.
        probe = "import os,fcntl,struct; fd=os.open('/dev/net/tun',os.O_RDWR); "
        probe += "\ntry: fcntl.ioctl(fd,0x400454ca,struct.pack('16sH'," + repr(tap_name.encode()) + ",0x5002))\nexcept PermissionError: pass\nelse: raise AssertionError('foreign TAP attachment')"
        host.succeed(as_user("other", "python3 -c " + shlex.quote(probe)))

    with subtest("wrong host and client keys fail closed"):
        operator(f"ssh-keygen -q -t ed25519 -N \"\" -f {runtime}/unrelated-key")
        operator(f"printf '{target} %s\\n' \"$(ssh-keygen -y -f {runtime}/unrelated-key)\" > {runtime}/wrong-known-hosts")
        host.fail(as_user("operator", service_ssh(f"{runtime}/client-key", f"{runtime}/wrong-known-hosts")))
        host.fail(as_user("operator", service_ssh(f"{runtime}/unrelated-key", f"{runtime}/known_hosts")))
        operator(service_ssh(f"{runtime}/client-key", f"{runtime}/known_hosts"))

    with subtest("declared state survives a fresh Guest boot"):
        operator(f"cp {runtime}/client-key {state}/old-client-key")
        operator(f"cp {state}/host-key {state}/old-host-key")
        operator(f"systemctl --user stop {unit}")
        operator(f"${pkgs.e2fsprogs}/bin/e2fsck -fn {state}/state.img")
        host.wait_until_fails(f"test -e /sys/class/net/{tap_name}")
        t.assertEqual(links(), [other_tap])
        egress("other", other_target)
        host.fail(f"test -e {runtime}")
        host.fail(as_user("operator", f"ssh {target} </dev/null"))
        # Wait for collection, then exercise listing an unloaded retained Instance.
        host.wait_until_succeeds(as_user("operator",
            "export XDG_RUNTIME_DIR=/run/user/1000; busctl --user call org.freedesktop.systemd1 "
            "/org/freedesktop/systemd1 org.freedesktop.systemd1.Manager GetUnit s "
            + shlex.quote(unit) + "; test $? -ne 0"))
        client.succeed("ssh operator@host </dev/null")
        host.fail(as_user("operator", f"XDG_RUNTIME_DIR=/run/user/1000 systemctl --user is-active --quiet {unit}"))
        host.fail(f"test -e {runtime}")
        operator(f"test -d {state}/ready; test -f {state}/state.img")
        t.assertEqual(links(), [other_tap])
        operator(f"systemctl --user start {unit}")
        guest("systemctl is-system-running --wait || { journalctl -b -u 'persist-*.service' --no-pager; exit 1; }")
        guest("test -f /workspace/created; cmp /etc/hostname /workspace/retained; test ! -e /root/discarded")
        egress()
        operator(f"cmp {state}/host-key {state}/old-host-key")
        host.fail(as_user("operator", service_ssh(f"{state}/old-client-key", f"{runtime}/known_hosts")))
        operator(service_ssh(f"{runtime}/client-key", f"{runtime}/known_hosts"))
        operator(f"rm {state}/old-client-key {state}/old-host-key")
        operator(f"systemctl --user stop {unit}")
        operator(f"${pkgs.e2fsprogs}/bin/e2fsck -fn {state}/state.img")

    with subtest("failed exec releases allocated resources without disrupting its peer"):
        host.fail(as_user("operator", "${tap}/bin/drv-run-tap /does-not-exist"))
        t.assertEqual(links(), [other_tap])
        host.wait_until_succeeds("test -z \"$(find /run/systemd/nsresource/registry -maxdepth 1 -name 'n1000-*.userns')\"")
        egress("other", other_target)

    with subtest("failed provisioning closes its master and releases its TAP"):
        # A valid store path that is not a prepared environment fails only after
        # SSH authentication and nix copy have succeeded.
        operator(f"mv {state}/environment {state}/saved-environment")
        operator(f"ln -s ${pkgs.bash} {state}/environment")
        host.fail(as_user("operator", f"XDG_RUNTIME_DIR=/run/user/1000 systemctl --user start {unit}"))
        operator(f"systemctl --user is-failed --quiet {unit}")
        host.wait_until_fails(f"test -e {runtime}")
        t.assertEqual(links(), [other_tap])
        egress("other", other_target)
        operator(f"rm {state}/environment; mv {state}/saved-environment {state}/environment")
        operator(f"systemctl --user reset-failed {unit}")

    with subtest("crashed VMM releases its TAP without disrupting its peer"):
        operator(f"systemctl --user start {unit}")
        egress()
        crashed_tap = next(link for link in links() if link != other_tap)
        operator(f"systemctl --user kill --signal=KILL --kill-whom=main {unit}")
        host.wait_until_fails(f"test -e /sys/class/net/{crashed_tap}")
        host.wait_until_fails(f"test -e {runtime}")
        t.assertEqual(links(), [other_tap])
        egress("other", other_target)
        operator(f"systemctl --user reset-failed {unit}")
        operator(f"systemctl --user start {unit}")
        egress()
        operator(f"systemctl --user stop {unit}")
        host.succeed(as_user("other", f"XDG_RUNTIME_DIR=/run/user/1001 systemctl --user stop {other_unit}"))
        host.succeed(f"e2fsck -fn {other_state}/state.img")
        host.wait_until_succeeds("test -z \"$(find /sys/class/net -name 'ns-*')\"")
        host.wait_until_succeeds("test -z \"$(find /run/systemd/nsresource/registry -maxdepth 1 -name 'i*.userns')\"")
  '';
}

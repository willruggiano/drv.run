{pkgs, ...}: let
  python = pkgs.python3.withPackages (ps: [ps.mitmproxy ps.tornado]);
  source = ../../packages/mitm-proxy;
  # Public test-only CA/key pair from nixpkgs, never used by deployed systems.
  testCA = pkgs.path + "/nixos/tests/common/acme/server";
  caCertificate = builtins.readFile (testCA + "/ca.cert.pem");
  # A login must have an initiating terminal. The fixture approves the device
  # without a browser; test success through Git, never by inspecting the prompt.
  login = pkgs.writeText "github-login.py" ''
    import fcntl
    import os
    import pty
    import subprocess
    import termios

    master, slave = pty.openpty()
    def terminal():
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    try:
        result = subprocess.run(
            ["mitm-proxy", "login", "--user", "alice"],
            stdin=slave, stdout=slave, stderr=slave, preexec_fn=terminal,
            timeout=30,
        )
        assert result.returncode == 0
    finally:
        os.close(slave)
        os.close(master)
  '';
  control = pkgs.writeText "github-control.py" ''
    import http.client
    import json
    import socket
    import sys
    import time

    def request(operation):
        connection = http.client.HTTPConnection("localhost", timeout=35)
        connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.sock.connect("/run/mitm-proxy-auth/alice.sock")
        try:
            connection.request("GET" if operation == "status" else "POST", "/" + operation)
            response = connection.getresponse()
            assert response.status == (200 if operation == "status" else 204)
            return json.load(response) if operation == "status" else None
        finally:
            connection.close()

    operation = sys.argv[1]
    request(operation)
    expected = "usable" if operation == "login" else "not-enrolled"
    deadline = time.monotonic() + 30
    while True:
        state = request("status")
        assert state["user_id"] == 1
        if state["state"] == expected:
            break
        assert state["state"] == "authorizing" and time.monotonic() < deadline
        time.sleep(0.1)
  '';
in {
  name = "mitm-proxy";
  nodes.machine = {lib, ...}: {
    imports = [
      ../../nixosModules/host/mitm-proxy.nix
      (import ../../nixosModules/guest/mitm-proxy.nix {port = 3128;})
    ];
    # This feature publishes a guest module for its caller. No microVM, launcher,
    # flake activation, or host-basic lifecycle is needed to test its service.
    options.services.drv-run.guest.extraModules = lib.mkOption {
      type = lib.types.listOf lib.types.deferredModule;
      default = [];
    };
    config = {
      virtualisation = {
        memorySize = 768;
        cores = 2;
        graphics = false;
        useNixStoreImage = true;
        mountHostNixStore = false;
        writableStore = true;
        writableStoreUseTmpfs = false;
      };
      boot.kernelParams = ["systemd.tty.term.console=dumb"];
      systemd.user.services = {
        # Environment realization and the guest are doubles; the integration's
        # producer, owner scope, and shared proxy service are production units.
        "drv.run-prepare@" = {
          partOf = ["drv.run@%i.service"];
          unitConfig.StopWhenUnneeded = true;
          serviceConfig = {
            Type = "oneshot";
            RemainAfterExit = true;
            RuntimeDirectory = "drv.run/%i";
            RuntimeDirectoryMode = "0700";
            ExecStart = "${pkgs.coreutils}/bin/true";
          };
        };
        "drv.run-image@" = {
          partOf = ["drv.run@%i.service"];
          unitConfig.StopWhenUnneeded = true;
          serviceConfig = {
            Type = "oneshot";
            RemainAfterExit = true;
            ExecStart = "${pkgs.coreutils}/bin/true";
          };
        };
        "drv.run@" = {
          requires = ["drv.run-image@%i.service"];
          after = ["drv.run-image@%i.service"];
          serviceConfig.ExecStart = "${pkgs.coreutils}/bin/sleep infinity";
        };
      };
      networking.hosts."93.184.216.34" = ["github.com" "api.github.com" "example.test"];
      # The proxy and guest clients share this test VM, rather than a gateway.
      networking.proxy.httpsProxy = lib.mkForce "http://127.0.0.1:3128";
      networking.interfaces.lo.ipv4.addresses = [
        {
          address = "93.184.216.34";
          prefixLength = 32;
        }
      ];
      networking.nftables.enable = true;
      environment.systemPackages = [
        pkgs.git
        pkgs.gh
        pkgs.python3
        pkgs.curl
      ];
      users.users.alice = {
        isNormalUser = true;
        linger = true;
        uid = 1000;
        group = "alice";
      };
      users.groups.alice.gid = 1000;
      users.users.bob = {
        isNormalUser = true;
        linger = true;
        uid = 1001;
        group = "bob";
      };
      users.groups.bob.gid = 1001;
      services.drv-run.mitm-proxy = {
        clientId = "test-app";
        owners.alice.githubUserId = 1;
        inherit caCertificate;
        caPrivateKeyFile = "/run/test-ca-key";
      };
      security.pki.certificates = [caCertificate];
      system.activationScripts.test-ca = lib.stringAfter ["specialfs"] ''
        install -m 0400 ${testCA + "/ca.key.pem"} /run/test-ca-key
      '';
      system.activationScripts.mitm-proxy.deps = ["test-ca"];
      systemd.services.fixture = {
        wantedBy = ["multi-user.target"];
        after = ["network-addresses-lo.service"];
        requires = ["network-addresses-lo.service"];
        path = [pkgs.git];
        # Keep the fixture source in the VM closure, not just its path as text.
        environment.PYTHONPATH = "${source}";
        serviceConfig.ExecStart = "${python}/bin/python3 -B -m tests.fixture /srv/git";
      };
      systemd.services.mitm-proxy = {
        # Python constructs its default TLS context at import time. Start after
        # the fixture has published its CA, not merely after its process execs.
        wantedBy = lib.mkForce [];
        environment = {
          NIX_SSL_CERT_FILE = lib.mkForce "/srv/git/tls/upstream-ca-cert.pem";
          SSL_CERT_FILE = lib.mkForce "/srv/git/tls/upstream-ca-cert.pem";
        };
      };
    };
  };
  testScript = ''
    import json
    import shlex

    machine.wait_for_unit("fixture.service")
    machine.wait_for_open_port(443)
    machine.succeed("systemctl start mitm-proxy.service")
    machine.wait_for_unit("mitm-proxy.service")
    machine.wait_for_open_port(3128)
    machine.succeed("git init --bare --initial-branch=main /srv/git/alice/repo.git; "
                    "git init --bare --initial-branch=main /srv/git/company/repo.git")

    def as_alice(command):
        return "su -s /bin/sh alice -c " + shlex.quote(command)

    with subtest("service starts without enrollment; only the capability is published"):
        machine.succeed(as_alice("test -r /run/mitm-proxy/alice/hosts.yml; test ! -e /run/mitm-proxy/alice/ca.pem"))
        machine.fail("su -s /bin/sh bob -c 'test -r /run/mitm-proxy/alice/hosts.yml'")
        machine.fail(as_alice("test -r /run/mitm-proxy-ca/mitmproxy-ca.pem"))
        machine.fail(as_alice("test -r /run/test-ca-key"))
        machine.fail(as_alice("test -r /var/lib/mitm-proxy-auth"))
        machine.fail(as_alice("mitm-proxy logout --user alice"))
        machine.fail("su -s /bin/sh mitm-proxy -c 'test -w /run/mitm-proxy-ca/mitmproxy-ca.pem'")

    with subtest("per-instance producer gates readiness and leaves the shared proxy independent"):
        machine.wait_for_unit("user@1000.service")
        machine.wait_for_unit("user@1001.service")
        def ctl(owner, command):
            return "systemctl --user --machine=" + owner + "@.host " + command
        main = "drv.run@fixture.service"
        tree = "/run/user/1000/drv.run/fixture/inputs/mitm"
        capability = tree + "/root/.config/gh/hosts.yml"
        proxy_pid = int(machine.succeed("systemctl show mitm-proxy.service -p MainPID --value"))
        machine.succeed("mv /run/mitm-proxy/alice/hosts.yml /run/pending-hosts.yml")
        machine.fail(ctl("alice", "start " + main))
        machine.fail(ctl("alice", "is-active --quiet " + main))
        machine.succeed("mv /run/pending-hosts.yml /run/mitm-proxy/alice/hosts.yml")
        machine.succeed(ctl("alice", "start " + main))
        machine.succeed(ctl("alice", "stop " + main + " drv.run-prepare@fixture.service"))
        machine.succeed("chmod 0000 /run/mitm-proxy/alice/hosts.yml")
        machine.fail(ctl("alice", "start " + main))
        machine.fail(ctl("alice", "is-active --quiet " + main))
        machine.succeed("chmod 0640 /run/mitm-proxy/alice/hosts.yml")
        machine.succeed(ctl("alice", "start " + main))
        machine.succeed("cmp /run/mitm-proxy/alice/hosts.yml " + capability)
        assert int(machine.succeed("stat -c %a " + capability), 8) == 0o600
        machine.fail("su -s /bin/sh bob -c " + shlex.quote("test -r " + capability))
        machine.succeed(ctl("bob", "start " + main))
        machine.fail("test -e /run/user/1001/drv.run/fixture/inputs/mitm")
        # This transport fixture runs clients as alice rather than guest root.
        # Both use the native configuration path relative to their own HOME.
        machine.succeed("install -d -m 0700 -o alice -g alice /home/alice/.config/gh; "
                        "install -m 0600 -o alice -g alice " + capability + " /home/alice/.config/gh/hosts.yml")
        for owner in ["alice", "bob"]:
            machine.succeed(ctl(owner, "stop " + main + " drv.run-prepare@fixture.service"))
        machine.fail("test -e " + tree)
        assert int(machine.succeed("systemctl show mitm-proxy.service -p MainPID --value")) == proxy_pid
        machine.succeed("systemctl is-active --quiet mitm-proxy.service")
    git = as_alice("GIT_TERMINAL_PROMPT=0 git ls-remote https://github.com/alice/repo.git")
    machine.fail(git)

    with subtest("device enrollment grants personal and organization Git access"):
        machine.succeed("SSL_CERT_FILE=/srv/git/tls/upstream-ca-cert.pem python3 ${login}")
        machine.succeed(git)
        machine.succeed(as_alice("git clone https://github.com/alice/repo.git /home/alice/repo; "
                                "git -C /home/alice/repo config user.name Test; "
                                "git -C /home/alice/repo config user.email test@example.test; "
                                "printf test > /home/alice/repo/value; "
                                "git -C /home/alice/repo add value; "
                                "git -C /home/alice/repo commit -m test; "
                                "git -C /home/alice/repo push origin main; "
                                "git -C /home/alice/repo push https://github.com/company/repo.git main"))
        for owner in ["alice", "company"]:
            machine.succeed(f"git --git-dir=/srv/git/{owner}/repo.git cat-file -e refs/heads/main:value")
        machine.fail(as_alice("test -r /var/lib/mitm-proxy-auth/alice.json"))

    with subtest("ordinary gh inherits the system-wide HTTPS proxy"):
        gh = as_alice("gh api user")
        machine.succeed(gh)
        machine.succeed(as_alice("gh pr list --repo alice/repo"))
        requests = json.loads(machine.succeed("cat /srv/git/api-requests.json"))
        assert requests[-2:] == [
            {"method": "GET", "url": "https://api.github.com/user"},
            {"method": "POST", "url": "https://api.github.com/graphql"},
        ]
        machine.succeed("systemd-run --wait --pipe --uid=alice gh api user")
        # No GitHub credential rule applies to device login or unrelated origins.
        machine.succeed("curl --fail https://github.com/login/device/code "
                        "--data 'client_id=test-app&scope=offline_access'")
        machine.succeed("curl --fail https://example.test/passthrough "
                        "--cacert /srv/git/tls/upstream-ca-cert.pem --data unchanged")

    with subtest("service restart preserves authorization and the guest capability"):
        machine.succeed("cp /run/mitm-proxy/alice/hosts.yml /run/saved-hosts.yml; "
                        "cp /run/mitm-proxy-ca/mitmproxy-ca.pem /run/saved-ca; "
                        "systemctl restart mitm-proxy.service")
        machine.wait_for_open_port(3128)
        machine.succeed("cmp /run/saved-hosts.yml /run/mitm-proxy/alice/hosts.yml; "
                        "cmp /run/saved-ca /run/mitm-proxy-ca/mitmproxy-ca.pem")
        machine.succeed(git)

    with subtest("logout denies new Git requests without restarting guests or service"):
        machine.succeed(as_alice("python3 ${control} logout"))
        machine.fail(git)
        machine.fail(gh)
        machine.succeed("test ! -e /var/lib/mitm-proxy-auth/alice.json")

    with subtest("the app owner can enroll but another host user cannot control that account"):
        machine.succeed(as_alice("python3 ${control} login"))
        machine.succeed(git)
        machine.fail("su -s /bin/sh bob -c 'python3 ${control} logout'")
        machine.succeed(git)
        machine.fail(as_alice("test -r /var/lib/mitm-proxy-auth/alice.json"))
        machine.succeed("mitm-proxy logout --user alice")
        machine.fail(git)
  '';
}

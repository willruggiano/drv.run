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
      virtualisation.memorySize = 768;
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
        uid = 1000;
        group = "alice";
      };
      users.groups.alice.gid = 1000;
      users.users.bob = {
        isNormalUser = true;
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

    # Publish the same seed paths and permissions used by the guest module.
    machine.succeed("install -d -m 0750 -g alice /run/drv-run-seed/mitm-proxy/gh; "
                    "cp -p /run/mitm-proxy/alice/{config,hosts}.yml /run/drv-run-seed/mitm-proxy/gh/")
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
        gh = "env GH_CONFIG_DIR=/run/drv-run-seed/mitm-proxy/gh gh"
        machine.succeed(gh + " api user")
        machine.succeed(gh + " pr list --repo alice/repo")
        requests = json.loads(machine.succeed("cat /srv/git/api-requests.json"))
        assert requests[-2:] == [
            {"method": "GET", "url": "https://api.github.com/user"},
            {"method": "POST", "url": "https://api.github.com/graphql"},
        ]
        machine.succeed("systemd-run --wait --pipe --setenv=GH_CONFIG_DIR=/run/drv-run-seed/mitm-proxy/gh gh api user")
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
        machine.fail(gh + " api user")
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

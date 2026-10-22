{
  nixosModules,
  pkgs,
}: let
  inherit (pkgs) lib;
  nixpkgs = builtins.path {
    name = "source";
    path = pkgs.path;
  };
  python = pkgs.python3.withPackages (ps: [ps.mitmproxy]);
  shell = pkgs.mkShell {packages = [pkgs.git pkgs.gh pkgs.curl pkgs.python3];};
  flake = pkgs.writeText "flake.nix" ''
    {
      inputs.nixpkgs.url = "path:${nixpkgs}";
      outputs = { nixpkgs, ... }: {
        devShells.${pkgs.stdenv.hostPlatform.system}.default =
          let pkgs = nixpkgs.legacyPackages.${pkgs.stdenv.hostPlatform.system};
          in pkgs.mkShell {
            packages = [pkgs.git pkgs.gh pkgs.curl pkgs.python3];
          };
      };
    }
  '';
  keys = import (pkgs.path + "/nixos/tests/ssh-keys.nix") pkgs;
in {
  name = "mitm-proxy";
  imports = [./common.nix];
  nodes = {
    upstream = {
      networking = {
        interfaces.lo.ipv4.addresses = [
          {
            address = "93.184.216.34";
            prefixLength = 32;
          }
        ];
        firewall.allowedTCPPorts = [53 443];
        firewall.allowedUDPPorts = [53];
      };
      services.dnsmasq = {
        enable = true;
        settings = {
          no-resolv = true;
          no-hosts = true;
          address = "/github.com/93.184.216.34";
        };
      };
      environment.systemPackages = [pkgs.git pkgs.python3 pkgs.curl];
      systemd.services.fixture = {
        wantedBy = ["multi-user.target"];
        after = ["network-addresses-lo.service"];
        requires = ["network-addresses-lo.service"];
        path = [pkgs.git];
        serviceConfig = {
          ExecStart = "${python}/bin/python3 ${../../packages/mitm-proxy/tests/fixture.py} /srv/git";
        };
      };
    };
    host = {nodes, ...}: {
      imports = [nixosModules.host];
      environment.systemPackages = [pkgs.curl pkgs.python3];
      services.drv-run = {
        network = {
          uplink = "eth1";
          dnsServers = [nodes.upstream.networking.primaryIPAddress];
        };
        guest.extraModules = [
          ({config, ...}: {
            assertions = [
              {
                assertion = let
                  setup = config.systemd.services.mitm-proxy;
                  session = config.systemd.services."sshd@";
                in
                  !(lib.elem "sshd-vsock.socket" setup.before)
                  && !(lib.elem "sshd-vsock.socket" setup.requiredBy)
                  && lib.elem "mitm-proxy.service" session.requires
                  && lib.elem "mitm-proxy.service" session.after;
                message = "Proxy setup must gate SSH sessions, not the early-boot VSOCK socket.";
              }
            ];
          })
        ];
        mitm-proxy.owners = {
          alice.tokenFile = "/run/mitm-proxy-token-alice";
          bob.tokenFile = "/run/mitm-proxy-token-bob";
        };
      };
      systemd.services.mitm-proxy = {
        # The driver installs the fixture CA and runtime tokens before startup.
        wantedBy = lib.mkForce [];
        environment.NIX_SSL_CERT_FILE = lib.mkForce "/run/upstream.pem";
      };
      networking = {
        hosts."93.184.216.34" = ["github.com"];
        interfaces.eth1.ipv4.routes = [
          {
            address = "93.184.216.34";
            prefixLength = 32;
            via = nodes.upstream.networking.primaryIPAddress;
          }
        ];
      };
      users.users = lib.listToAttrs (lib.imap0 (index: name:
        lib.nameValuePair name {
          isNormalUser = true;
          uid = 1000 + index;
          group = name;
          openssh.authorizedKeys.keys = [keys.snakeOilPublicKey];
        }) ["alice" "bob" "carol"]);
      users.groups = {
        alice.gid = 1000;
        bob.gid = 1001;
        carol.gid = 1002;
      };
      virtualisation = {
        # Four concurrent 512 MiB guests also need room for the host and proxy.
        memorySize = lib.mkForce 4096;
        additionalPaths = [shell nixpkgs];
      };
      nix.settings = {
        experimental-features = ["nix-command" "flakes"];
        substituters = lib.mkForce [];
      };
    };
  };
  testScript = ''
    import json
    import shlex
    from datetime import timedelta

    def as_user(owner, command):
        uid = {"alice": 1000, "bob": 1001, "carol": 1002}[owner]
        return "su --login " + owner + " --command " + shlex.quote(
            f"export XDG_RUNTIME_DIR=/run/user/{uid}; " + command)

    def guest(owner, target, command, success=True):
        invocation = as_user(owner, "ssh -T " + target + " " + shlex.quote(command) + " </dev/null")
        if success:
            host.succeed(invocation, timeout=timedelta(minutes=5))
        else:
            host.fail(invocation, timeout=timedelta(minutes=1))

    def instances(owner):
        # Inventory comes from durable state, never from launcher output.
        return set(json.loads(host.succeed("python3 -c " + shlex.quote(
            f"import json; from pathlib import Path; print(json.dumps([p.name for p in Path('/home/{owner}/.local/state/drv.run').glob('*') if p.is_dir()]))"))))

    def create(owner):
        before = instances(owner)
        host.succeed(as_user(owner,
            "SSH_ORIGINAL_COMMAND='path:/home/" + owner + "/flake exit' drv.run </dev/null"),
            timeout=timedelta(minutes=15))
        created = instances(owner) - before
        t.assertEqual(len(created), 1)
        return "drv.run." + created.pop()

    upstream.wait_for_unit("fixture.service")
    upstream.wait_for_open_port(443)
    upstream.succeed("cp /srv/git/tls/upstream-ca-cert.pem /tmp/shared/upstream.pem")
    with subtest("boot activation publishes seed files without proxy credentials"):
        host.fail("systemctl is-active --quiet mitm-proxy.service")
        for owner in ["alice", "bob"]:
            host.fail(f"test -e /run/mitm-proxy-token-{owner}")
            host.succeed(as_user(owner, f"test -r /run/mitm-proxy/{owner}/placeholder && test -r /run/mitm-proxy/{owner}/ca.pem"))

    host.succeed("cp /tmp/shared/upstream.pem /run/upstream.pem; "
                 "umask 077; printf alice_token > /run/mitm-proxy-token-alice; "
                 "printf bob_token > /run/mitm-proxy-token-bob")
    host.succeed("systemctl start mitm-proxy.service")
    host.wait_for_open_port(3128)

    with subtest("publications and real credentials have separate trust boundaries"):
        for owner in ["alice", "bob"]:
            host.succeed(as_user(owner, f"test -r /run/mitm-proxy/{owner}/placeholder && test -r /run/mitm-proxy/{owner}/ca.pem"))
            for path in ["/var/lib/mitm-proxy/mitmproxy-ca.pem", "/run/mitm-proxy-token-alice", "/run/mitm-proxy-token-bob"]:
                host.fail(as_user(owner, "test -r " + path))
        host.fail(as_user("alice", "test -r /run/mitm-proxy/bob/placeholder"))
        host.fail(as_user("bob", "test -r /run/mitm-proxy/alice/placeholder"))
        host.fail("test -e /run/mitm-proxy/carol")
        host.fail("su -s /bin/sh mitm-proxy -c 'test -w /var/lib/mitm-proxy/mitmproxy-ca.pem'")
        upstream.fail("curl --max-time 2 --proxy http://host:3128 https://github.com/ -o /dev/null")

    for owner in ["alice", "bob", "carol"]:
        host.wait_for_unit("default.target", user=owner)
        host.succeed(as_user(owner, f"mkdir /home/{owner}/flake; cp ${flake} /home/{owner}/flake/flake.nix; nix flake lock --offline path:/home/{owner}/flake"))
    for owner in ["alice", "bob"]:
        upstream.succeed(f"git init --bare --initial-branch=main /srv/git/{owner}/repo.git")

    alice = create("alice")
    bob = create("bob")
    with subtest("activation prepares guest restarts before the system proxy starts"):
        host.succeed("systemctl stop mitm-proxy.service; "
                     "cp /run/mitm-proxy/alice/placeholder /run/activation-placeholder; "
                     "cp /run/mitm-proxy/alice/ca.pem /run/activation-ca; "
                     "rm -r /run/mitm-proxy")
        for owner in ["alice", "bob"]:
            host.succeed(f"mv /run/mitm-proxy-token-{owner} /run/saved-token-{owner}")
        host.succeed("/run/current-system/activate")
        host.fail("systemctl is-active --quiet mitm-proxy.service")
        host.succeed("cmp /run/activation-placeholder /run/mitm-proxy/alice/placeholder; "
                     "cmp /run/activation-ca /run/mitm-proxy/alice/ca.pem")
        unit = "drv.run@" + alice.removeprefix("drv.run.") + ".service"
        host.succeed(as_user("alice", "systemctl --user restart " + unit), timeout=timedelta(minutes=15))
        guest("alice", alice, 'test "$GH_TOKEN" = "$(cat /run/drv-run-seed/mitm-proxy/placeholder)"')
        host.fail("systemctl is-active --quiet mitm-proxy.service")
        for owner in ["alice", "bob"]:
            host.succeed(f"mv /run/saved-token-{owner} /run/mitm-proxy-token-{owner}")
        host.succeed("systemctl start mitm-proxy.service")
        host.wait_for_open_port(3128)

    with subtest("gh supplies the placeholder inside nix develop; Git clone and push work"):
        for owner, target in [("alice", alice), ("bob", bob)]:
            guest(owner, target, 'test "$GH_TOKEN" = "$(cat /run/drv-run-seed/mitm-proxy/placeholder)"; systemctl is-active --quiet mitm-proxy.service')
            guest(owner, target, f"git clone https://github.com/{owner}/repo.git /workspace/repo; "
                  "git -C /workspace/repo config user.name Test; git -C /workspace/repo config user.email test@example.test; "
                  "printf initial > /workspace/repo/value; git -C /workspace/repo add value; "
                  "git -C /workspace/repo commit -m initial; git -C /workspace/repo push origin main")
            upstream.succeed(f"git --git-dir=/srv/git/{owner}/repo.git cat-file -e refs/heads/main:value")
        # Credential helper invocation must not depend on the flake's GH_TOKEN.
        guest("alice", alice, "GH_TOKEN=wrong git -C /workspace/repo fetch origin")

    with subtest("another owner does not grant access to its private repository"):
        guest("alice", alice, "GIT_TERMINAL_PROMPT=0 git ls-remote https://github.com/bob/repo.git", success=False)
        guest("bob", bob, "GIT_TERMINAL_PROMPT=0 git ls-remote https://github.com/alice/repo.git", success=False)

    with subtest("pull and branch fetch preserve repository state"):
        upstream.succeed("git clone /srv/git/alice/repo.git /srv/admin; "
                         "git -C /srv/admin config user.name Test; git -C /srv/admin config user.email test@example.test; "
                         "printf upstream > /srv/admin/value; git -C /srv/admin commit -am upstream; "
                         "git -C /srv/admin branch another; git -C /srv/admin push origin main another")
        guest("alice", alice, "git -C /workspace/repo pull --ff-only; printf upstream > /workspace/expected; cmp /workspace/expected /workspace/repo/value; "
              "git -C /workspace/repo fetch origin another; git -C /workspace/repo cat-file -e refs/remotes/origin/another:value")

    with subtest("same-owner instances share capability; unconfigured owners receive none"):
        second = create("alice")
        guest("alice", second, "git ls-remote https://github.com/alice/repo.git")
        carol = create("carol")
        guest("carol", carol, "test ! -e /run/drv-run-seed/mitm-proxy; test ! -e /run/mitm-proxy/gitconfig; test -z \"''${GH_TOKEN:-}\"")
        host.succeed("drv.run stop " + second + "; drv.run stop " + carol)

    with subtest("restart and token rotation need no guest reprovisioning"):
        host.succeed("cp /run/mitm-proxy/alice/placeholder /run/saved-placeholder; cp /run/mitm-proxy/alice/ca.pem /run/saved-ca")
        host.succeed("printf rotated_token > /run/mitm-proxy-token-alice; systemctl restart mitm-proxy.service")
        host.wait_for_open_port(3128)
        host.succeed("cmp /run/saved-placeholder /run/mitm-proxy/alice/placeholder; cmp /run/saved-ca /run/mitm-proxy/alice/ca.pem")
        guest("alice", alice, "git -C /workspace/repo fetch origin")
        host.succeed("drv.run stop " + alice)
        unit = "drv.run@" + alice.removeprefix("drv.run.") + ".service"
        host.succeed(as_user("alice", "systemctl --user start " + unit), timeout=timedelta(minutes=15))
        guest("alice", alice, "git -C /workspace/repo fetch origin")

    with subtest("proxy failure cannot fall back to authenticated direct access"):
        host.succeed("systemctl stop mitm-proxy.service")
        guest("alice", alice, "GIT_TERMINAL_PROMPT=0 git -C /workspace/repo fetch origin", success=False)
        # Non-proxy networking is unchanged, with normal certificate validation.
        host.succeed(as_user("alice", "ssh -T " + alice + " 'cat > /workspace/upstream.pem' < /run/upstream.pem"))
        guest("alice", alice, "curl --noproxy '*' --cacert /workspace/upstream.pem -sS --max-time 5 https://github.com/ -o /workspace/direct-response")
        host.succeed("systemctl start mitm-proxy.service")
        host.wait_for_open_port(3128)

    with subtest("untrusted upstream certificates fail before HTTP authorization"):
        upstream.succeed("touch /srv/git/invalid-certificate; systemctl restart fixture.service")
        upstream.wait_for_open_port(443)
        guest("alice", alice, "GIT_TERMINAL_PROMPT=0 git -C /workspace/repo fetch origin", success=False)
        upstream.succeed("rm /srv/git/invalid-certificate; systemctl restart fixture.service")
        upstream.wait_for_open_port(443)
        guest("alice", alice, "git -C /workspace/repo fetch origin")

    host.succeed("drv.run stop --all; drv.run clean --all")
  '';
}

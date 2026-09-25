{
  nixosModules,
  pkgs,
}: let
  shell = pkgs.mkShell {};
  keys = import (pkgs.path + "/nixos/tests/ssh-keys.nix") pkgs;
  fixture = pkgs.writeText "flake.nix" ''
    {
      inputs.nixpkgs.url = "path:${pkgs.path}";
      outputs = { nixpkgs, ... }: {
        devShells.x86_64-linux.default = nixpkgs.legacyPackages.x86_64-linux.mkShell {};
      };
    }
  '';
in {
  name = "host-basic";
  qemu.forceAccel = true;
  nodes = {
    client = {
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
      virtualisation = {
        memorySize = 6144;
        cores = 2;
        diskSize = 20480;
        qemu.options = ["-cpu" "host"];
        additionalPaths = [shell shell.drvPath pkgs.path];
      };
      users.users = {
        operator = {
          isNormalUser = true;
          uid = 1000;
          openssh.authorizedKeys.keys = [keys.snakeOilPublicKey];
        };
        other = {
          isNormalUser = true;
          uid = 1001;
          openssh.authorizedKeys.keys = [keys.snakeOilPublicKey];
        };
        disabled = {
          enable = false;
          isNormalUser = true;
          uid = 1002;
        };
        root.openssh.authorizedKeys.keys = [keys.snakeOilPublicKey];
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
  testScript = ''
    import shlex

    def as_user(user: str, command: str):
        return "su --login " + shlex.quote(user) + " --command " + shlex.quote(command)

    def operator(command: str):
        return host.succeed(as_user("operator",
            "export XDG_RUNTIME_DIR=/run/user/1000; " + command
        ))

    def guest(command: str):
        # Supply a terminal while exercising the exact reconnect command.
        operator("printf '%s\\n' " + shlex.quote("set -e; test -t 0; " + command + "; exit")
            + " | ${pkgs.util-linux}/bin/script --quiet --return --command "
            + shlex.quote("ssh " + target) + " /dev/null")

    start_all()
    host.wait_for_unit("default.target")
    host.wait_for_unit("sshd.service")
    client.wait_for_unit("default.target")

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
            client.fail(f"ssh {user}@host 'touch /home/{user}/not-a-launcher-command'")
            host.fail(f"test -e /home/{user}/not-a-launcher-command")

    with subtest("system accounts retain ordinary SSH behavior"):
        client.succeed("ssh root@host 'touch /root/ordinary-ssh'")
        host.succeed("test -f /root/ordinary-ssh")

    with subtest("SSH creation runs as the authenticated owner"):
        operator("mkdir /home/operator/flake")
        operator("cp ${fixture} /home/operator/flake/flake.nix")
        operator("nix flake lock --offline path:/home/operator/flake")
        client.succeed("printf '%s\\n' " + shlex.quote(
            "set -e; test -t 0; touch /workspace/created; exit"
        ) + " | ssh -tt host path:/home/operator/flake", timeout=900)

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
        host.succeed(f'test -S {runtime}/ssh.sock && test "$(stat -c %u {runtime}/ssh.sock)" -eq 1000')

    with subtest("owner reconnects without sudo or connection flags"):
        guest("systemctl is-system-running --wait || { journalctl -b -u 'persist-*.service' --no-pager; exit 1; }")
        guest("test $(id -u) -eq 0; test -f /workspace/created; cp /etc/hostname /workspace/retained; touch /root/discarded")
        guest("test -f /root/discarded; cmp /etc/hostname /workspace/retained")
        operator(f"systemctl --user is-active --quiet {unit}")

    with subtest("other users cannot access the owner's Instance"):
        for path in [f"{runtime}/client.conf", f"{runtime}/client-key", f"{state}/host-key", f"{state}/state.img"]:
            host.fail(as_user("other", f"test -r {path}"))
        host.fail(as_user("other", f"ssh {target} </dev/null"))
        # Supplying the owner's configuration explicitly must not bypass isolation.
        host.fail(as_user("other", f"ssh -F {runtime}/client.conf {target} </dev/null"))
        host.fail(as_user("operator", "ssh drv.run.nonexistent </dev/null"))

    with subtest("declared state survives a fresh Guest boot"):
        operator(f"systemctl --user stop {unit}")
        operator(f"${pkgs.e2fsprogs}/bin/e2fsck -fn {state}/state.img")
        host.fail(f"test -e {runtime}")
        host.fail(as_user("operator", f"ssh {target} </dev/null"))
        operator(f"systemctl --user start {unit}")
        guest("systemctl is-system-running --wait || { journalctl -b -u 'persist-*.service' --no-pager; exit 1; }")
        guest("test -f /workspace/created; cmp /etc/hostname /workspace/retained; test ! -e /root/discarded")
        operator(f"systemctl --user stop {unit}")
        operator(f"${pkgs.e2fsprogs}/bin/e2fsck -fn {state}/state.img")
  '';
}

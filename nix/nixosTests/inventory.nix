{
  pkgs,
  nixosModules,
}: let
  inherit (pkgs) lib;
  environment = pkgs.writeText "inventory-environment" "{}";
  prepare = pkgs.writeShellScript "inventory-prepare" ''
    set -euo pipefail
    if [[ ! -e $STATE_DIRECTORY/reference ]]; then
      printf 'fixture:%s\n' "''${STATE_DIRECTORY##*/}" > "$STATE_DIRECTORY/reference"
    fi
    mkdir -p "$STATE_DIRECTORY/ready"
    ln -sfn ${environment} "$STATE_DIRECTORY/environment"
    printf 'private connection configuration\n' > "$RUNTIME_DIRECTORY/ssh_config"
  '';
  # The outbound SSH boundary blocks acknowledgement, not systemd's lifecycle.
  ssh = pkgs.writeShellScriptBin "ssh" ''
    set -euo pipefail
    touch "$STATE_DIRECTORY/provisioning"
    until [[ -e $STATE_DIRECTORY/release ]]; do sleep 0.1; done
    read -r expected
    test "$expected" = ${environment}
    test ! -e "$STATE_DIRECTORY/fail"
    printf '%s\n' '{}'
  '';
  provision = pkgs.writeShellApplication {
    name = "inventory-provision";
    runtimeInputs = [pkgs.coreutils pkgs.jq ssh];
    text = lib.replaceStrings ["@service-ssh@" "@timing@"] ["/dev/null" (builtins.readFile ../../nixosModules/timing.sh)] (
      builtins.readFile ../../nixosModules/host/post.sh
    );
  };
in
  pkgs.testers.runNixOSTest {
    name = "owner-inventory";
    nodes.machine = {
      imports = [nixosModules.host];
      # Inventory needs no network policy or nsresourced/BTF-enabled systemd build.
      disabledModules = [../../nixosModules/host/network.nix];
      nix.settings.experimental-features = ["nix-command" "flakes"];
      boot.kernelParams = ["systemd.tty.term.console=dumb"];
      # These lifecycle fixtures need no RSA keys; generation is costly under TCG.
      services.openssh.hostKeys = lib.mkForce [
        {
          type = "ed25519";
          path = "/etc/ssh/ssh_host_ed25519_key";
        }
      ];
      # Keep the driver reachable during slow TCG boot; assertions wait for units.
      systemd.services.backdoor = {
        unitConfig.DefaultDependencies = false;
        after = ["local-fs.target"];
      };
      virtualisation = {
        memorySize = 768;
        cores = 2;
        graphics = false;
        useNixStoreImage = true;
        mountHostNixStore = false;
        writableStore = true;
        writableStoreUseTmpfs = false;
      };
      users.users = {
        alice = {
          isNormalUser = true;
          uid = 1000;
          group = "alice";
        };
        bob = {
          isNormalUser = true;
          uid = 1001;
          group = "bob";
        };
      };
      users.groups = {
        alice.gid = 1000;
        bob.gid = 1001;
      };
      # Keep production StateDirectory, runtime cleanup, and stop-post behavior.
      # No guest, image build, or nested hypervisor is needed to test inventory.
      systemd.user.services = {
        "drv.run-prepare@".serviceConfig.ExecStart = lib.mkForce (toString prepare);
        "drv.run-image@" = {
          requires = lib.mkForce ["drv.run-prepare@%i.service"];
          after = lib.mkForce ["drv.run-prepare@%i.service"];
          serviceConfig.ExecStart = lib.mkForce "${pkgs.coreutils}/bin/true";
        };
        "drv.run@".serviceConfig = {
          Type = lib.mkForce "simple";
          ExecStart = lib.mkForce "${pkgs.coreutils}/bin/sleep infinity";
          ExecStartPost = lib.mkForce (lib.getExe provision);
          ExecStop = lib.mkForce [];
        };
      };
    };
    testScript = ''
      import json
      import shlex
      from uuid import UUID

      def as_user(owner, command):
          return "runuser --login " + shlex.quote(owner) + " --command " + shlex.quote(command)

      def run(owner, command):
          return machine.succeed(as_user(owner, "export XDG_RUNTIME_DIR=/run/user/" + str({"alice": 1000, "bob": 1001}[owner]) + "; " + command))

      def inventory(owner, arguments="list --json"):
          command = "SSH_ORIGINAL_COMMAND=fixture:must-not-launch drv.run " + arguments
          document = json.loads(machine.succeed(command) if owner is None else run(owner, command))
          assert document["version"] == 1
          assert set(document) == {"version", "instances"}
          return document["instances"]

      def record(user, name, active, sub, ready, result="success"):
          return {"user": user, "id": name, "reference": "fixture:" + name, "host": "drv.run." + name,
                  "activeState": active, "subState": sub, "result": result, "ready": ready}

      machine.start()
      machine.wait_for_unit("multi-user.target")
      for owner, uid in [("alice", 1000), ("bob", 1001)]:
          machine.wait_for_unit(f"user@{uid}.service")
          machine.wait_until_succeeds(f"test -S /run/user/{uid}/bus")
          assert inventory(owner) == []
          machine.fail(f"test -e /home/{owner}/.local/state/drv.run")
      assert inventory(None) == []
      assert inventory(None, "list --json -u alice") == []

      state = "/home/alice/.local/state/drv.run/zeta"
      runtime = "/run/user/1000/drv.run/zeta"
      unit = "drv.run@zeta.service"

      with subtest("provisioning, running, stopped, and restart keep one stable identity"):
          run("alice", f"systemctl --user start --no-block {unit}")
          machine.wait_until_succeeds(f"test -f {state}/provisioning")
          assert inventory("alice") == [record("alice", "zeta", "activating", "start-post", False)]
          assert inventory("bob") == []
          machine.succeed(f"test -f {runtime}/ssh_config")
          run("alice", f"touch {state}/release")
          machine.wait_until_succeeds(as_user("alice", f"XDG_RUNTIME_DIR=/run/user/1000 systemctl --user is-active --quiet {unit}"))
          assert inventory("alice") == [record("alice", "zeta", "active", "running", True)]
          invocation = UUID(run("alice", f"systemctl --user show {unit} -p InvocationID --value").strip())
          for _ in range(2):
              assert inventory("alice") == [record("alice", "zeta", "active", "running", True)]
              assert UUID(run("alice", f"systemctl --user show {unit} -p InvocationID --value").strip()) == invocation
          run("alice", f"systemctl --user stop {unit}")
          machine.wait_until_fails(f"test -e {runtime}")
          # Exact-name queries must include retained units after systemd unloads them.
          machine.wait_until_fails(as_user("alice", f"XDG_RUNTIME_DIR=/run/user/1000 busctl --user call org.freedesktop.systemd1 /org/freedesktop/systemd1 org.freedesktop.systemd1.Manager GetUnit s {unit}"))
          assert inventory("alice") == [record("alice", "zeta", "inactive", "dead", False)]
          run("alice", f"rm {state}/release {state}/provisioning; systemctl --user start --no-block {unit}")
          machine.wait_until_succeeds(f"test -f {state}/provisioning")
          machine.succeed(f"test -d {state}/ready")
          machine.succeed(f"test -f {runtime}/ssh_config")
          assert inventory("alice") == [record("alice", "zeta", "activating", "start-post", False)]
          run("alice", f"touch {state}/release")
          machine.wait_until_succeeds(as_user("alice", f"XDG_RUNTIME_DIR=/run/user/1000 systemctl --user is-active --quiet {unit}"))
          assert inventory("alice") == [record("alice", "zeta", "active", "running", True)]
          assert UUID(run("alice", f"systemctl --user show {unit} -p InvocationID --value").strip()) != invocation

      with subtest("failed provisioning remains visible without retry or failure reset"):
          run("alice", f"systemctl --user stop {unit}; touch {state}/fail")
          machine.fail(as_user("alice", f"XDG_RUNTIME_DIR=/run/user/1000 systemctl --user start {unit}"))
          for _ in range(2):
              assert inventory("alice") == [record("alice", "zeta", "failed", "failed", False, "exit-code")]
              run("alice", f"systemctl --user is-failed --quiet {unit}")
          machine.fail(f"test -e {runtime}/ssh_config")

      with subtest("two real owners have separate inventories and cannot select each other"):
          run("bob", "mkdir -p ~/.local/state/drv.run/beta; touch ~/.local/state/drv.run/beta/release; systemctl --user start drv.run@beta.service")
          assert inventory("bob") == [record("bob", "beta", "active", "running", True)]
          assert inventory("alice") == [record("alice", "zeta", "failed", "failed", False, "exit-code")]
          for owner, other in [("alice", "bob"), ("bob", "alice")]:
              for arguments in [f"list --json -u {other}", f"list -u {other} --json"]:
                  machine.fail(as_user(owner, "drv.run " + arguments))
              machine.fail(as_user(owner, f"XDG_STATE_HOME=/home/{other}/.local/state drv.run list --json"))
          # Output format does not change root's existing owner selection.
          assert inventory(None) == [record("bob", "beta", "active", "running", True), record("alice", "zeta", "failed", "failed", False, "exit-code")]
          for owner in ["alice", "bob"]:
              run(owner, "drv.run list")
              machine.succeed("drv.run list -u " + owner)
              for arguments in [f"list --json -u {owner}", f"list -u {owner} --json"]:
                  assert inventory(None, arguments) == inventory(owner)
              machine.fail(as_user(owner, "drv.run list -u " + {"alice": "bob", "bob": "alice"}[owner]))
          machine.succeed("drv.run list")
          machine.fail("drv.run list --json -u nobody")
          # The same ID can be retained by different users without ambiguity.
          run("bob", "mkdir -p ~/.local/state/drv.run/zeta; touch ~/.local/state/drv.run/zeta/release; systemctl --user start drv.run@zeta.service")
          assert inventory("bob") == [record("bob", "beta", "active", "running", True), record("bob", "zeta", "active", "running", True)]
          assert inventory(None) == [record("bob", "beta", "active", "running", True), record("alice", "zeta", "failed", "failed", False, "exit-code"), record("bob", "zeta", "active", "running", True)]

      with subtest("unreadable state fails discovery instead of returning an empty or partial inventory"):
          for path, inaccessible, original in [
              ("/home/alice/.local/state", "600", "700"),
              ("/home/alice/.local/state/drv.run", "300", "700"),
              (state, "600", "700"),
              (state + "/reference", "000", "600"),
          ]:
              machine.succeed(f"chmod {inaccessible} {path}")
              for arguments in ["list", "list --json"]:
                  machine.fail(as_user("alice", "drv.run " + arguments))
              machine.succeed(f"chmod {original} {path}")
              assert inventory("alice") == [record("alice", "zeta", "failed", "failed", False, "exit-code")]
          # Even readable foreign state is not an alternate-owner inventory source.
          machine.succeed("chmod 755 /home/bob /home/bob/.local /home/bob/.local/state /home/bob/.local/state/drv.run")
          for arguments in ["list", "list --json"]:
              machine.fail(as_user("alice", "XDG_STATE_HOME=/home/bob/.local/state drv.run " + arguments))
          assert inventory("bob") == [record("bob", "beta", "active", "running", True), record("bob", "zeta", "active", "running", True)]

      with subtest("multi-user discovery withholds the document if any selected user fails"):
          machine.succeed("chmod 000 /home/bob/.local/state/drv.run/beta/reference")
          for arguments in ["list --json", "list --json -u bob"]:
              status, output = machine.execute("drv.run " + arguments + " 2>/dev/null")
              assert status != 0
              try:
                  json.loads(output)
              except json.JSONDecodeError:
                  pass
              else:
                  raise AssertionError("discovery failure published a JSON document")
          assert inventory(None, "list --json -u alice") == inventory("alice")
          machine.succeed("chmod 600 /home/bob/.local/state/drv.run/beta/reference")
          assert inventory(None) == [record("bob", "beta", "active", "running", True), record("alice", "zeta", "failed", "failed", False, "exit-code"), record("bob", "zeta", "active", "running", True)]

      with subtest("clean targets the main unit without touching a running or foreign instance"):
          machine.fail("drv.run clean -u bob beta")
          assert inventory("bob") == [record("bob", "beta", "active", "running", True), record("bob", "zeta", "active", "running", True)]
          machine.succeed("drv.run stop -u alice zeta")
          machine.wait_until_fails(f"test -e {runtime}")
          machine.succeed("drv.run clean -u alice zeta")
          machine.fail(f"test -e {state}")
          assert inventory("alice") == []
          assert inventory("bob") == [record("bob", "beta", "active", "running", True), record("bob", "zeta", "active", "running", True)]
    '';
  }

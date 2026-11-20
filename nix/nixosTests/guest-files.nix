{
  pkgs,
  nixosModules,
}: let
  inherit (pkgs) lib;
  environment = pkgs.writeText "guest-files-environment" "{}";
  gate = phase: ''
    touch "$STATE_DIRECTORY/entered-${phase}"
    while test -e "$STATE_DIRECTORY/wait-${phase}"; do sleep 0.1; done
    test ! -e "$STATE_DIRECTORY/fail-${phase}"
  '';
  prepare = pkgs.writeShellApplication {
    name = "fixture-prepare";
    runtimeInputs = [pkgs.coreutils pkgs.openssh];
    text = ''
      runtime=$1
      if [[ ! -f $STATE_DIRECTORY/host-key ]]; then
        ssh-keygen -q -t ed25519 -N "" -f "$STATE_DIRECTORY/host-key"
      fi
      ssh-keygen -q -t ed25519 -N "" -f "$runtime/id_ed25519"
      printf 'drv.run.%s %s\n' "''${STATE_DIRECTORY##*/}" \
        "$(ssh-keygen -y -f "$STATE_DIRECTORY/host-key")" > "$runtime/known_hosts"
      ln -sfn ${environment} "$STATE_DIRECTORY/environment"
      printf 'fixture:%s\n' "''${STATE_DIRECTORY##*/}" > "$STATE_DIRECTORY/reference"
      mkdir -p "$STATE_DIRECTORY/ready"
      ${gate "prepare"}
    '';
  };
  producer = pkgs.writeShellApplication {
    name = "fixture-files";
    runtimeInputs = [pkgs.coreutils pkgs.python3];
    text = ''
      install -d -m 0700 "$RUNTIME_DIRECTORY/root" "$RUNTIME_DIRECTORY/root/.config" "$RUNTIME_DIRECTORY/root/.config/fixture"
      install -m 0600 "$STATE_DIRECTORY/value.json" "$RUNTIME_DIRECTORY/root/.config/fixture/value.json"
      file="$RUNTIME_DIRECTORY/root/.config/fixture/value.json"
      if test -e "$STATE_DIRECTORY/setuid"; then chmod 4700 "$file"; fi
      if test -e "$STATE_DIRECTORY/setgid"; then chmod 2700 "$RUNTIME_DIRECTORY/root/.config/fixture"; fi
      if test -e "$STATE_DIRECTORY/xattr"; then
        python3 -c "import os, sys; os.setxattr(sys.argv[1], 'user.fixture', b'fixture')" "$file"
      fi
      ${gate "producer"}
    '';
  };
in
  pkgs.testers.runNixOSTest {
    name = "guest-files";
    nodes.machine = {
      imports = [nixosModules.host];
      disabledModules = [../../nixosModules/host/network.nix];
      nix.settings.experimental-features = ["nix-command" "flakes"];
      boot.supportedFilesystems = ["erofs"];
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
      environment.systemPackages = [pkgs.python3];
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
      systemd.user.services = {
        # Only environment realization and the guest process are doubles. Core
        # SSH preparation, assembly, dependencies and runtime ownership are real.
        "drv.run-prepare@" = {
          serviceConfig.ExecStart = lib.mkForce "${lib.getExe prepare} %t/drv.run/%i";
          postStop = lib.mkBefore (gate "preparation-stop");
        };
        "fixture-files@" = {
          requires = ["drv.run-prepare@%i.service"];
          after = ["drv.run-prepare@%i.service"];
          partOf = ["drv.run@%i.service"];
          unitConfig.StopWhenUnneeded = true;
          serviceConfig = {
            Type = "oneshot";
            RemainAfterExit = true;
            StateDirectory = "drv.run/%i";
            StateDirectoryMode = "0700";
            RuntimeDirectory = "drv.run/%i/inputs/fixture";
            RuntimeDirectoryMode = "0700";
            UMask = "0077";
            ExecStart = lib.getExe producer;
          };
        };
        "drv.run-image@" = {
          requires = ["fixture-files@%i.service"];
          after = ["fixture-files@%i.service"];
          serviceConfig.ExecStartPost = lib.getExe (pkgs.writeShellApplication {
            name = "fixture-image-barrier";
            runtimeInputs = [pkgs.coreutils];
            text = gate "image";
          });
        };
        "drv.run@".serviceConfig = {
          ExecStartPre = lib.mkForce [];
          ExecStart = lib.mkForce (lib.getExe (pkgs.writeShellApplication {
            name = "fixture-guest";
            runtimeInputs = [pkgs.coreutils pkgs.systemd];
            text = ''
              systemd-notify --ready
              exec sleep infinity
            '';
          }));
          ExecStartPost = lib.mkForce (lib.getExe (pkgs.writeShellApplication {
            name = "fixture-acknowledgement";
            runtimeInputs = [pkgs.coreutils];
            # Model an SSH acknowledgement whose transport ends with the guest.
            text = ''
              touch "$STATE_DIRECTORY/entered-post"
              while test -e "$STATE_DIRECTORY/wait-post"; do
                kill -0 "''${MAINPID:?}"
                sleep 0.1
              done
              test ! -e "$STATE_DIRECTORY/fail-post"
            '';
          }));
          ExecStop = lib.mkForce [];
          ExecStopPost = lib.getExe (pkgs.writeShellApplication {
            name = "fixture-stop-barrier";
            runtimeInputs = [pkgs.coreutils];
            text = gate "stop";
          });
        };
      };
    };
    testScript = ''
      import json
      import shlex
      from uuid import UUID

      uids = {"alice": 1000, "bob": 1001}
      instance = "example"

      def command(owner, script):
          return "runuser --login " + shlex.quote(owner) + " --command " + shlex.quote("export XDG_RUNTIME_DIR=/run/user/" + str(uids[owner]) + "; " + script)

      def run(owner, script):
          return machine.succeed(command(owner, script))

      def ctl(owner, operation):
          return run(owner, "systemctl --user " + operation)

      def state(owner):
          return "/home/" + owner + "/.local/state/drv.run/" + instance

      def root(owner):
          return "/run/user/" + str(uids[owner]) + "/drv.run/" + instance

      def value(owner, generation):
          document = {"owner": owner, "generation": generation}
          run(owner, "printf '%s' " + shlex.quote(json.dumps(document)) + " > " + state(owner) + "/value.json")
          return document

      def snapshot(owner):
          image = root(owner) + "/image/seed.img"
          assert int(machine.succeed("stat -c %a " + image), 8) == 0o600
          assert int(machine.succeed("stat -c %u " + image)) == uids[owner]
          machine.succeed("mkdir -p /mnt/seed; mount -t erofs -o ro,loop " + image + " /mnt/seed")
          try:
              for path in ["root/.ssh/authorized_keys", "etc/ssh/ssh_host_ed25519_key", "root/.config/fixture/value.json"]:
                  assert int(machine.succeed("stat -c %u /mnt/seed/rootfs/" + path)) == 0
                  assert int(machine.succeed("stat -c %g /mnt/seed/rootfs/" + path)) == 0
                  assert int(machine.succeed("stat -c %a /mnt/seed/rootfs/" + path), 8) == 0o600
              machine.fail("test -e /mnt/seed/rootfs/id_ed25519 || test -e /mnt/seed/rootfs/root/.config/fixture/stale")
              machine.succeed("cmp /mnt/seed/environment " + "<(printf '%s\\n' ${environment})")
              return json.loads(machine.succeed("cat /mnt/seed/rootfs/root/.config/fixture/value.json"))
          finally:
              machine.succeed("umount /mnt/seed")

      def cleaned(owner):
          machine.wait_until_fails("test -e " + root(owner), timeout=30)

      machine.start()
      machine.wait_for_unit("multi-user.target")
      for owner, uid in uids.items():
          machine.wait_for_unit(f"user@{uid}.service")
          run(owner, "mkdir -p " + state(owner))

      with subtest("two owners get private canonical snapshots and fresh restart inputs"):
          for owner in uids:
              expected = value(owner, 1)
              ctl(owner, "start drv.run@" + instance + ".service")
              assert snapshot(owner) == expected
              machine.fail(command(owner, "systemctl --user clean --what=state drv.run@" + instance + ".service"))
              invocation = UUID(ctl(owner, "show drv.run@" + instance + ".service -p InvocationID --value").strip())
              assert invocation.int != 0
              run(owner, "touch " + root(owner) + "/inputs/fixture/root/.config/fixture/stale")
              next_value = value(owner, 2)
              assert snapshot(owner) == expected
              ctl(owner, "restart drv.run@" + instance + ".service")
              assert snapshot(owner) == next_value
              assert UUID(ctl(owner, "show drv.run@" + instance + ".service -p InvocationID --value").strip()) != invocation
          for owner, other in [("alice", "bob"), ("bob", "alice")]:
              machine.fail(command(owner, "cat " + root(other) + "/image/seed.img"))
              machine.fail(command(owner, "XDG_RUNTIME_DIR=/run/user/" + str(uids[other]) + " systemctl --user stop drv.run@" + instance + ".service"))
              ctl(other, "is-active --quiet drv.run@" + instance + ".service")
          for owner in uids:
              ctl(owner, "stop drv.run@" + instance + ".service")
              cleaned(owner)
              machine.succeed("test -f " + state(owner) + "/host-key")

      # These syscalls are blocked in Nix 2.35 builds. Exercise rejection against
      # the real guest kernel and owner, not by disabling or skipping coverage.
      for metadata in ["setuid", "setgid", "xattr"]:
          instance = "metadata" + metadata
          with subtest("unsupported " + metadata + " metadata gates guest activation"):
              run("alice", "mkdir -p " + state("alice"))
              expected = value("alice", 3)
              run("alice", "touch " + state("alice") + "/" + metadata)
              machine.fail(command("alice", "systemctl --user start drv.run@" + instance + ".service"))
              ctl("alice", "is-failed --quiet drv.run-image@" + instance + ".service")
              machine.fail("test -f " + root("alice") + "/image/seed.img")
              run("alice", "rm " + state("alice") + "/" + metadata)
              # No reset-failed, and no wait for asynchronous cleanup before retry.
              ctl("alice", "start drv.run@" + instance + ".service")
              assert snapshot("alice") == expected
              ctl("alice", "stop drv.run@" + instance + ".service")
              cleaned("alice")

      for phase in ["prepare", "producer", "image", "post"]:
          instance = "failed" + phase
          with subtest("failed " + phase + " removes partial outputs and retries"):
              run("alice", "mkdir -p " + state("alice"))
              expected = value("alice", 4)
              run("alice", "touch " + state("alice") + "/fail-" + phase)
              machine.fail(command("alice", "systemctl --user start drv.run@" + instance + ".service"))
              machine.fail(command("alice", "systemctl --user is-active --quiet drv.run@" + instance + ".service"))
              if phase == "post":
                  cleaned("alice")
              machine.fail("test -f " + root("alice") + "/image/seed.img")
              run("alice", "rm " + state("alice") + "/fail-" + phase)
              ctl("alice", "start drv.run@" + instance + ".service")
              assert snapshot("alice") == expected
              ctl("alice", "stop drv.run@" + instance + ".service")
              cleaned("alice")

          instance = "cancelled" + phase
          with subtest("cancelling during " + phase + " stops preparation before a fresh start"):
              run("alice", "mkdir -p " + state("alice"))
              value("alice", 5)
              run("alice", "touch " + state("alice") + "/wait-" + phase)
              ctl("alice", "start --no-block drv.run@" + instance + ".service")
              machine.wait_until_succeeds("test -f " + state("alice") + "/entered-" + phase)
              machine.fail(command("alice", "systemctl --user is-active --quiet drv.run@" + instance + ".service"))
              machine.fail(command("alice", "systemctl --user clean --what=state drv.run@" + instance + ".service"))
              run("alice", "touch " + state("alice") + "/wait-preparation-stop")
              ctl("alice", "stop --no-block drv.run@" + instance + ".service")
              machine.wait_until_succeeds("test -f " + state("alice") + "/entered-preparation-stop")
              inventory = json.loads(machine.succeed("drv.run list --json -u alice"))
              entry = next(entry for entry in inventory["instances"] if entry["id"] == instance)
              assert entry["activeState"] in ["inactive", "failed"]
              machine.fail("drv.run clean -u alice " + instance)
              machine.succeed("test -f " + state("alice") + "/host-key")
              run("alice", "rm " + state("alice") + "/wait-preparation-stop")
              machine.succeed("drv.run stop -u alice " + instance)
              cleaned("alice")
              run("alice", "rm " + state("alice") + "/wait-" + phase)
              expected = value("alice", 6)
              ctl("alice", "start drv.run@" + instance + ".service")
              assert snapshot("alice") == expected
              ctl("alice", "stop drv.run@" + instance + ".service")
              cleaned("alice")
      instance = "mainexit"
      with subtest("main process exit during acknowledgement fails activation"):
          run("alice", "mkdir -p " + state("alice"))
          value("alice", 7)
          run("alice", "touch " + state("alice") + "/wait-post")
          ctl("alice", "start --no-block drv.run@" + instance + ".service")
          machine.wait_until_succeeds("test -f " + state("alice") + "/entered-post")
          ctl("alice", "kill --kill-whom=main --signal=KILL drv.run@" + instance + ".service")
          machine.wait_until_succeeds(command("alice", "systemctl --user is-failed --quiet drv.run@" + instance + ".service"))
          cleaned("alice")

      instance = "teardown"
      with subtest("main-unit clean refuses teardown and removes stopped state"):
          run("alice", "mkdir -p " + state("alice"))
          value("alice", 7)
          ctl("alice", "start drv.run@" + instance + ".service")
          run("alice", "touch " + state("alice") + "/wait-stop")
          ctl("alice", "stop --no-block drv.run@" + instance + ".service")
          machine.wait_until_succeeds("test -f " + state("alice") + "/entered-stop")
          machine.fail(command("alice", "systemctl --user clean --what=state drv.run@" + instance + ".service"))
          run("alice", "rm " + state("alice") + "/wait-stop")
          ctl("alice", "stop drv.run@" + instance + ".service")
          cleaned("alice")
          ctl("alice", "clean --what=state drv.run@" + instance + ".service")
          machine.fail("test -e " + state("alice"))
    '';
  }

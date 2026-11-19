{
  pkgs,
  impermanence,
}: let
  inherit (pkgs) lib;
  tool = pkgs.writeShellScriptBin "guest-file-environment" ''
    set -euo pipefail
    test "$DRV_RUN_FIXTURE_ACTIVATED" = yes
    printf '%s\n' activated > "$1"
  '';
  environment = pkgs.writeText "guest-files-env" (builtins.toJSON {
    variables = {
      PATH = {
        type = "exported";
        value = lib.makeBinPath [tool pkgs.coreutils pkgs.gh];
      };
      shellHook = {
        type = "exported";
        value = "export DRV_RUN_FIXTURE_ACTIVATED=yes";
      };
      outputs = {
        type = "array";
        value = [];
      };
    };
    bashFunctions = {};
  });
  image = import ../mkEnvironmentImage.nix {inherit pkgs;} {inherit environment;};
  # These keys authenticate only this disposable, offline fixture.
  keys = pkgs.runCommand "guest-files-test-keys" {nativeBuildInputs = [pkgs.openssh];} ''
    mkdir "$out"
    ssh-keygen -q -t ed25519 -N "" -f "$out/host"
    ssh-keygen -q -t ed25519 -N "" -f "$out/client"
    printf 'fixture %s\n' "$(ssh-keygen -y -f "$out/host")" > "$out/known_hosts"
  '';
  seed = pkgs.runCommand "guest-files-test-seed" {nativeBuildInputs = [pkgs.drvr.guest-files];} ''
    install -d -m 0755 inputs/core/etc inputs/core/etc/ssh
    install -d -m 0700 inputs/core/root inputs/core/root/.ssh inputs/integration/root inputs/integration/root/.config inputs/integration/root/.config/gh
    install -m 0600 ${keys}/host inputs/core/etc/ssh/ssh_host_ed25519_key
    install -m 0600 ${keys}/client.pub inputs/core/root/.ssh/authorized_keys
    printf '%s\n' '{"github.com":{"oauth_token":"fake-capability","git_protocol":"https"}}' > inputs/integration/root/.config/gh/hosts.yml
    chmod 0600 inputs/integration/root/.config/gh/hosts.yml
    drv-run-guest-files --inputs inputs --environment ${environment} --output "$out"
  '';
in
  pkgs.testers.runNixOSTest {
    name = "guest-files-boot";
    includeTestScriptReferences = false;
    extraPythonPackages = ps: [ps.pyyaml];
    nodes.machine = {config, ...}: {
      imports = [
        impermanence.nixosModules.impermanence
        ../../nixosModules/nix.nix
        (import ../../nixosModules/guest/mitm-proxy.nix {port = 3128;})
        # qemu-vm overrides fileSystems. Keep the actual production initrd and
        # environment services, adapting only the test driver's option namespace.
        (args @ {
          config,
          lib,
          pkgs,
          ...
        }: let
          module = import ../../nixosModules/guest/files.nix args;
        in
          builtins.removeAttrs module ["fileSystems"] // {virtualisation.fileSystems = module.fileSystems // {"/" = lib.mkForce module.fileSystems."/";};})
        (args @ {
          config,
          lib,
          pkgs,
          ...
        }: let
          module = import ../../nixosModules/guest/environment.nix args;
        in
          builtins.removeAttrs module ["fileSystems"] // {virtualisation.fileSystems = module.fileSystems;})
      ];
      virtualisation = {
        memorySize = 768;
        cores = 2;
        graphics = false;
        useNixStoreImage = true;
        mountHostNixStore = false;
        writableStore = true;
        writableStoreUseTmpfs = false;
        sharedDirectories = lib.mkForce {};
        qemu.options = [
          "-drive file=${image}/store.erofs,format=raw,if=virtio,readonly=on"
          "-drive file=${seed},format=raw,if=virtio,readonly=on"
        ];
        fileSystems."/persist" = {
          device = config.virtualisation.rootDevice;
          fsType = "ext4";
          neededForBoot = true;
        };
      };
      environment.persistence."/persist".directories = ["/nix" "/workspace" "/var/lib/nixos"];
      services.openssh = {
        enable = true;
        generateHostKeys = false;
        hostKeys = [];
        settings = {
          PermitRootLogin = "prohibit-password";
          PasswordAuthentication = false;
          KbdInteractiveAuthentication = false;
        };
      };
      # The test driver registers the generic closure through this service.
      systemd.services.drv-run-environment = {
        after = ["register-nix-paths.service"];
        requires = ["register-nix-paths.service"];
      };
      systemd.managerEnvironment.SYSTEMD_DEFAULT_MOUNT_RATE_LIMIT_BURST = "64";
      boot.initrd.systemd.managerEnvironment.SYSTEMD_DEFAULT_MOUNT_RATE_LIMIT_BURST = "64";
      nix.settings = {
        experimental-features = ["nix-command" "flakes"];
        substituters = lib.mkForce [];
        flake-registry = "";
      };
      boot.kernelParams = ["systemd.tty.term.console=dumb"];
      system.extraDependencies = [keys];
    };
    testScript = ''
      import json
      import shlex
      import yaml

      def ssh(command):
          return machine.succeed("ssh -F /dev/null -o BatchMode=yes -o IdentityAgent=none -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o HostKeyAlias=fixture -o UserKnownHostsFile=${keys}/known_hosts -o GlobalKnownHostsFile=/dev/null -i /root/client-key root@localhost " + shlex.quote(command))

      def verify():
          machine.wait_for_unit("multi-user.target")
          machine.wait_for_unit("drv-run-environment.service")
          machine.wait_for_unit("sshd.service")
          machine.wait_until_succeeds("systemctl --quiet is-system-running")
          mounts = json.loads(machine.succeed("findmnt --json --mountpoint /"))["filesystems"]
          assert mounts[0]["fstype"] == "overlay"
          assert int(machine.succeed("stat -c %a /"), 8) == 0o755
          for path in ["/root/.ssh/authorized_keys", "/etc/ssh/ssh_host_ed25519_key", "/root/.config/gh/hosts.yml"]:
              machine.succeed("cmp /run/drv-run-seed/rootfs" + path + " " + path)
              assert int(machine.succeed("stat -c %u " + path)) == 0
              assert int(machine.succeed("stat -c %g " + path)) == 0
              assert int(machine.succeed("stat -c %a " + path), 8) == 0o600
          machine.succeed("install -m 0600 ${keys}/client /root/client-key")
          ssh("guest-file-environment /workspace/activated")
          machine.succeed("test -f /workspace/activated; test /nix/var/nix/profiles/project -ef ${environment}")
          assert yaml.safe_load(machine.succeed("cat /root/.config/gh/hosts.yml")) == {"github.com": {"oauth_token": "fake-capability", "git_protocol": "https"}}

      machine.start()
      verify()
      with subtest("native gh configuration uses its canonical writable guest path"):
          ssh("gh config set --host github.com git_protocol ssh")
          assert yaml.safe_load(machine.succeed("cat /root/.config/gh/hosts.yml")) == {"github.com": {"oauth_token": "fake-capability", "git_protocol": "ssh"}}
          assert json.loads(machine.succeed("cat /run/drv-run-seed/rootfs/root/.config/gh/hosts.yml"))["github.com"]["git_protocol"] == "https"
      with subtest("guest writes do not change the lower snapshot; restart restores files and retains state"):
          machine.succeed("touch /workspace/retained; rm /etc/ssh/ssh_host_ed25519_key /root/.ssh/authorized_keys")
          machine.succeed("test -f /run/drv-run-seed/rootfs/etc/ssh/ssh_host_ed25519_key; test -f /run/drv-run-seed/rootfs/root/.ssh/authorized_keys")
          machine.shutdown()
          machine.start()
          verify()
          machine.succeed("test -f /workspace/retained; test ! -e /nix/var/nix/profiles/project-2-link")
    '';
  }

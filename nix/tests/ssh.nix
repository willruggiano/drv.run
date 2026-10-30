{
  pkgs,
  nixosModules,
  nixosSystem,
}: let
  inherit (pkgs) lib;
  evaluate = modules:
    (nixosSystem {
      inherit modules;
      system = pkgs.stdenv.hostPlatform.system;
    }).config;
  valid = config: let
    failures = builtins.filter (entry: !entry.assertion) config.assertions;
  in
    lib.assertMsg (failures == []) (lib.concatMapStringsSep "\n" (entry: entry.message) failures);
  guest = evaluate [nixosModules.guest];
  deployment = evaluate [
    nixosModules.guest
    {
      users.users.root.shell = pkgs.bashInteractive;
      services.openssh = {
        sftpServerExecutable = "internal-sftp";
        settings = {
          DisableForwarding = true;
          ForceCommand = "internal-sftp";
          PasswordAuthentication = true;
        };
      };
    }
  ];
  host = evaluate [
    nixosModules.host
    {
      nixpkgs.pkgs = pkgs;
      nix.settings.experimental-features = ["nix-command" "flakes"];
      services.drv-run.network = {
        uplink = "eth0";
        dnsServers = ["192.0.2.53"];
      };
      boot.loader.grub.enable = false;
      fileSystems."/" = {
        device = "none";
        fsType = "tmpfs";
      };
      users.users.owner = {
        isNormalUser = true;
        uid = 1000;
        group = "owner";
      };
      users.groups.owner.gid = 1000;
      system.stateVersion = lib.trivial.release;
    }
  ];
  fixtureTool = pkgs.writeShellScriptBin "environment-tool" ''
    set -euo pipefail
    test "''${activated:-}" = 1
    test "''${__ETC_PROFILE_DONE:-}" = 1
    test ! -e /proc/self/fd/3
    test ! -e /proc/self/fd/4
    : > "$1"
  '';
  environment = pkgs.writeText "ssh-shell-fixture-env" (builtins.toJSON {
    variables = {
      PATH = {
        type = "exported";
        value = lib.makeBinPath [fixtureTool];
      };
      shellHook = {
        type = "exported";
        value = ''
          test -f "$HOME/profile-ready" || exit 90
          export activated=1
        '';
      };
      outputs = {
        type = "array";
        value = [];
      };
    };
    bashFunctions = {};
  });
  fixtureShell = pkgs.writeTextFile {
    name = "guest-shell-fixture";
    executable = true;
    text =
      lib.replaceStrings
      ["/nix/var/nix/profiles/project" "/run/drv-run-environment/ready" "/workspace"]
      ["$HOME/project" "$HOME/ready" "$HOME/workspace"]
      guest.users.users.root.shell.text;
  };
in
  assert valid guest;
  assert valid deployment;
  assert valid host;
  assert !(guest.services.openssh.settings.DisableForwarding or false);
  assert !(guest.services.openssh.settings ? ForceCommand);
  assert builtins.elem "/run/drv-run-ssh/%u/authorized_keys" guest.services.openssh.authorizedKeysFiles;
  assert builtins.elem "/etc/ssh/authorized_keys.d/%u" guest.services.openssh.authorizedKeysFiles;
  assert guest.users.users.root.shell.shellPath == "/bin/drv-run-shell";
  assert deployment.users.users.root.shell.shellPath == pkgs.bashInteractive.shellPath;
  assert deployment.services.openssh.sftpServerExecutable == "internal-sftp";
  assert deployment.services.openssh.settings.DisableForwarding;
  assert deployment.services.openssh.settings.PasswordAuthentication;
  assert !(host.systemd.user.services ? "drv-run-ssh@");
  assert !(host.security.wrappers ? "sshx.bind");
    pkgs.runCommand "ssh-policy-check" {} ''
      test -x ${lib.getExe guest.users.users.root.shell}
      export NIX_REMOTE="local?state=$PWD/state&log=$PWD/log"
      ${lib.getExe' guest.nix.package "nix-store"} --load-db < ${(pkgs.closureInfo {rootPaths = [environment];})}/registration
      mkdir -p home/workspace
      ln -s ${environment} home/project
      touch home/ready
      # Model NixOS's profile reset and Bash's SSH startup guard. The unset
      # variable also checks that profile initialization precedes nounset.
      cat > home/.bash_profile <<'EOF'
      if [ -n "$__ETC_PROFILE_SOURCED" ]; then return; fi
      __ETC_PROFILE_SOURCED=1
      export __ETC_PROFILE_DONE=1
      export PATH=${lib.makeBinPath [pkgs.coreutils pkgs.bashInteractive]}
      : > "$HOME/profile-ready"
      EOF
      cat > home/.bashrc <<'EOF'
      if [ -z "$__ETC_PROFILE_DONE" ]; then . "$HOME/.bash_profile"; fi
      EOF
      run_shell() {
        env -i HOME="$PWD/home" USER=fixture TERM=dumb NIX_REMOTE="$NIX_REMOTE" \
          PATH=${lib.makeBinPath [pkgs.coreutils pkgs.bashInteractive]} \
          NIX_CONFIG=$'experimental-features = nix-command flakes\nflake-registry =\nsubstituters =\n' \
          SSH_CLIENT='127.0.0.1 12345 22' \
          ${fixtureShell} "$@"
      }
      printf 'input\n' | run_shell -c 'read -r value && test "$value" = input && environment-tool "$HOME/executed"'
      test -f home/profile-ready
      test -f home/executed
      if run_shell -c 'exit 37'; then
        exit 1
      else
        test "$?" -eq 37
      fi
      touch "$out"
    ''

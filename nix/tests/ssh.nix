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
      touch "$out"
    ''

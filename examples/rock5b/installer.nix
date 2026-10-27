{target}: {
  config,
  lib,
  pkgs,
  ...
}: let
  host = target.config;
  stateDirectory = "rock5b-installer";
  handoffSource = pkgs.writeText "rock5b-nvme-boot.cmd" ''
    nvme scan
    if part number nvme 0 ${host.disko.devices.disk.main.content.partitions.ESP.label} nvme_esp; then
      if load nvme 0:''${nvme_esp} ''${kernel_addr_r} /EFI/BOOT/BOOTAA64.EFI; then
        setenv bootargs
        bootefi ''${kernel_addr_r} - ''${fdtcontroladdr}
      fi
    fi
    echo NVMe EFI boot failed
    false
  '';
  handoffScript = pkgs.runCommand "rock5b-nvme-boot.scr" {nativeBuildInputs = [pkgs.ubootTools];} ''
    mkimage -A arm64 -T script -C none -n 'Boot NVMe' -d ${handoffSource} "$out"
    dumpimage -l "$out" >/dev/null
  '';
  install = pkgs.writeShellApplication {
    name = "rock5b-install";
    runtimeInputs = with pkgs; [coreutils util-linux jq openssh ssh-to-age sops nix systemd];
    text = builtins.readFile ./installer.sh;
  };
in {
  system.stateVersion = host.system.stateVersion;
  networking.hostName = lib.mkForce "rock5b-installer";

  # Never share partition labels with the NVMe: disko formats by these labels.
  disko.devices.disk.main = {
    device = lib.mkForce "/dev/mmcblk1";
    content.partitions = {
      ESP = {
        label = "rock5b-installer-ESP";
        content.mountOptions = lib.mkForce ["umask=0077"];
      };
      root.label = "rock5b-installer-root";
    };
  };

  services.openssh = {
    enable = true;
    settings = {
      PermitRootLogin = "prohibit-password";
      PasswordAuthentication = false;
      KbdInteractiveAuthentication = false;
    };
  };
  users.users.root = {
    hashedPassword = "!";
    openssh.authorizedKeys.keys = host.users.users.root.openssh.authorizedKeys.keys;
  };
  nix.settings.experimental-features = ["nix-command" "flakes"];

  assertions = [
    {
      assertion =
        builtins.attrNames host.disko.devices.disk
        == ["main"]
        && host.disko.devices.disk.main.device == "/dev/nvme0n1"
        && host.disko.rootMountPoint == "/mnt";
      message = "The ROCK 5B installer must provision only NVMe at /mnt.";
    }
    {
      assertion = config.disko.devices.disk.main.content.partitions.ESP.start == "16M";
      message = "The ROCK 5B installer must retain the firmware reservation.";
    }
  ];

  systemd.services.rock5b-install = {
    description = "Install drv.run on NVMe once, then boot NVMe through U-Boot";
    wantedBy = ["multi-user.target"];
    after = ["local-fs.target" "dev-nvme0n1.device"];
    requires = ["local-fs.target" "dev-nvme0n1.device"];
    unitConfig = {
      ConditionPathExists = "!/var/lib/${stateDirectory}/started";
      RequiresMountsFor = ["/boot" "/var/lib/${stateDirectory}"];
    };
    environment = {
      BOOT = "/boot";
      INSTALLER_ROOT_DEVICE = config.fileSystems."/".device;
      INSTALLER_ESP_DEVICE = config.fileSystems."/boot".device;
      INSTALL_ROOT = host.disko.rootMountPoint;
      DISKO = toString host.system.build.destroyFormatMount;
      HOST_SYSTEM = toString host.system.build.toplevel;
      NIXOS_INSTALL = toString host.system.build.nixos-install;
      CLOSURE = toString (pkgs.closureInfo {rootPaths = [host.system.build.toplevel];});
      HANDOFF_SCRIPT = toString handoffScript;
      SECRETS = toString (pkgs.linkFarm "rock5b-installer-secrets" (lib.mapAttrsToList (name: secret: {
          inherit name;
          path = secret.sopsFile;
        })
        host.sops.secrets));
    };
    serviceConfig = {
      Type = "oneshot";
      ExecStart = lib.getExe install;
      StateDirectory = stateDirectory;
      StateDirectoryMode = "0700";
      RuntimeDirectory = stateDirectory;
      RuntimeDirectoryMode = "0700";
      UMask = "0077";
      TimeoutStartSec = "infinity";
      Restart = "no";
    };
  };
}

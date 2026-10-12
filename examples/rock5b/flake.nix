{
  description = "An example of running drv.run on a Radxa ROCK 5B";

  inputs = {
    self.submodules = true;
    drv-run.url = "path:../..";
    nixos-hardware = {
      url = "github:NixOS/nixos-hardware/4bc63156b109ee7b4103e3ec30565c8c92bde435";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nixpkgs.follows = "drv-run/nixpkgs";
  };

  outputs = {
    self,
    drv-run,
    nixos-hardware,
    nixpkgs,
    ...
  }: let
    systems = ["x86_64-linux" "aarch64-linux"];
    eachSystem = f:
      nixpkgs.lib.genAttrs systems (system: let
        pkgs = import nixpkgs {inherit system;};
      in
        f pkgs);
  in {
    devShells = eachSystem (pkgs: {
      default = pkgs.mkShellNoCC {};
    });

    apps = eachSystem (pkgs: {
      deploy = {
        type = "app";
        meta.description = "Deploy and reboot the rock5b host";
        program = nixpkgs.lib.getExe self.packages.${pkgs.stdenv.hostPlatform.system}.deploy;
      };
    });

    packages = eachSystem (pkgs: let
      toplevel = self.nixosConfigurations.rock5b.config.system.build.toplevel;
    in {
      deploy = pkgs.writeShellApplication {
        name = "deploy";
        runtimeInputs = [pkgs.nix pkgs.openssh];
        text = ''
          if [[ $# -ne 1 || -z $1 ]]; then
            echo 'Usage: deploy <ip-address>' >&2
            exit 2
          fi

          store_host=$1
          if [[ $store_host == *:* ]]; then
            store_host="[$store_host]"
          fi

          nix copy --no-check-sigs --to "ssh-ng://root@$store_host" "${toplevel}"
          ssh -l root -- "$1" \
            'nix-env --profile /nix/var/nix/profiles/system --set ${toplevel} &&
             ${toplevel}/bin/switch-to-configuration boot &&
             systemctl reboot'
        '';
      };
    });

    nixosConfigurations.rock5b = nixpkgs.lib.nixosSystem {
      modules = [
        nixos-hardware.nixosModules.rock-5b
        drv-run.nixosModules.host
        ({
          config,
          lib,
          pkgs,
          modulesPath,
          ...
        }: let
          firmware = config.hardware.rockchip.platformFirmware;
        in {
          imports = [(modulesPath + "/installer/sd-card/sd-image.nix")];
          nixpkgs.hostPlatform = "aarch64-linux";

          assertions = [
            {
              assertion = pkgs.stdenv.hostPlatform.system == "aarch64-linux";
              message = "ROCK 5B requires aarch64-linux.";
            }
            {
              assertion = config.sdImage.firmwarePartitionOffset >= 16;
              message = "ROCK 5B SPL/U-Boot require at least 16 MiB before the first partition.";
            }
          ];

          boot = {
            loader = {
              grub.enable = false;
              systemd-boot.enable = false;
              generic-extlinux-compatible.enable = true;
            };
            initrd = {
              systemd.enable = true;
              availableKernelModules = ["dw_mmc_rockchip" "sdhci_of_dwcmshc"];
            };
            # The hardware profile enables bcachefs; this image only uses ext4/vfat.
            supportedFilesystems.bcachefs = lib.mkForce false;
            # Unlike the SD-image expander, growpart handles mmcblk1p2 correctly.
            growPartition = true;
          };
          fileSystems."/".autoResize = true;
          hardware.deviceTree.name = "rockchip/rk3588-rock-5b.dtb";

          networking = {
            hostName = "rock5b";
            useDHCP = false;
            useNetworkd = true;
            firewall.enable = true;
          };
          systemd.network.networks."10-ethernet" = {
            matchConfig.Name = "en* eth*";
            networkConfig.DHCP = "ipv4";
          };
          services.drv-run.network = {
            uplink = "enP4p65s0";
            dnsServers = ["192.168.4.1"];
          };

          users = {
            mutableUsers = false;
            users = {
              root = {
                hashedPassword = "!";
                openssh.authorizedKeys.keys =
                  config.users.users.me.openssh.authorizedKeys.keys
                  ++ config.users.users.pi.openssh.authorizedKeys.keys;
              };
              me = {
                isNormalUser = true;
                uid = 1000;
                group = "me";
                hashedPassword = "!";
                openssh.authorizedKeys.keys = [
                  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEWXJHDkOTwqq+3W5JgBxGWyDNlhxVcQB/2lwBRwg8/f me@local"
                ];
              };
              pi = {
                isNormalUser = true;
                uid = 1001;
                group = "pi";
                hashedPassword = "!";
                openssh.authorizedKeys.keys = [
                  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILyrIElca7UIajXHQmmFhmpbrVfs9ceui8r9wjNL0zs+ pi@local"
                ];
              };
            };
            groups = {
              me.gid = 1000;
              pi.gid = 1001;
            };
          };
          services.openssh = {
            enable = true;
            openFirewall = true;
            settings = {
              AuthenticationMethods = "publickey";
              PermitRootLogin = "prohibit-password";
              PasswordAuthentication = false;
              KbdInteractiveAuthentication = false;
            };
          };
          nix.settings = {
            experimental-features = ["nix-command" "flakes"];
            sandbox = true;
          };

          image.baseName = "rock5b";
          sdImage = {
            firmwarePartitionOffset = 16;
            expandOnBoot = false;
            # U-Boot/extlinux reads /boot on the root FS.
            populateFirmwareCommands = "";
            populateRootCommands = ''
              mkdir -p ./files/boot
              ${config.boot.loader.generic-extlinux-compatible.populateCmd} \
                -c ${config.system.build.toplevel} -d ./files/boot
            '';
            # Offsets from nixos-hardware's Rockchip firmware installation hook.
            # TODO: citation?
            postBuildCommands = ''
              test "$(stat -c %s ${firmware}/idbloader.img)" -le $(((16384 - 64) * 512))
              test "$(stat -c %s ${firmware}/u-boot.itb)" -le $((${toString config.sdImage.firmwarePartitionOffset} * 1024 * 1024 - 16384 * 512))
              dd if=${firmware}/idbloader.img of="$img" bs=512 seek=64 conv=notrunc
              dd if=${firmware}/u-boot.itb of="$img" bs=512 seek=16384 conv=notrunc
            '';
          };

          system.stateVersion = "26.11";
        })
      ];
    };
  };
}

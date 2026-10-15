{
  description = "An example of running drv.run on a Radxa ROCK 5B";

  inputs = {
    self.submodules = true;
    drv-run.url = "path:../..";
    deploy-rs = {
      url = "github:serokell/deploy-rs/45ba3f8c5cb28396fff71671806e2550b464ac86";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    sops-nix = {
      url = "github:Mic92/sops-nix/ee48786c6f9160d2c1a084aac841f68195b8420c";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nixos-hardware = {
      url = "github:NixOS/nixos-hardware/4bc63156b109ee7b4103e3ec30565c8c92bde435";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nixpkgs.url = "github:NixOS/nixpkgs/a32edd7654519351e48e80372a928df336394670";
  };

  outputs = {
    self,
    drv-run,
    deploy-rs,
    nixos-hardware,
    nixpkgs,
    sops-nix,
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
      default = pkgs.mkShellNoCC {
        packages = [pkgs.age pkgs.sops pkgs.ssh-to-age];
      };
    });

    apps = eachSystem (pkgs: {
      deploy = {
        type = "app";
        program = nixpkgs.lib.getExe (pkgs.writeShellApplication {
          name = "deploy";
          runtimeInputs = [
            pkgs.nix
            pkgs.openssh
            deploy-rs.packages.${pkgs.stdenv.hostPlatform.system}.default
          ];
          text = ''
            exec deploy --fast-connection=true --hostname=192.168.4.38 --skip-checks ./examples/rock5b "$@"
          '';
        });
      };
    });

    deploy.nodes.rock5b = {
      hostname = "rock5b";
      sshUser = "root";
      remoteBuild = true;
      # Runtime paths relative to the repository root, not Nix path literals.
      # Connecting to the IP does not match .ssh/config's Host rock5b block.
      sshOpts = [
        "-F"
        "/dev/null"
        "-i"
        "examples/rock5b/.ssh/id_ed25519"
        "-o"
        "IdentitiesOnly=yes"
        "-o"
        "IdentityAgent=none"
        "-o"
        "UserKnownHostsFile=examples/rock5b/.ssh/known_hosts"
        "-o"
        "GlobalKnownHostsFile=/dev/null"
        "-o"
        "StrictHostKeyChecking=yes"
        "-o"
        "BatchMode=yes"
        "-o"
        "ForwardAgent=no"
        "-o"
        "ForwardX11=no"
        "-o"
        "ClearAllForwardings=yes"
        "-o"
        "ConnectTimeout=10"
        "-o"
        "ServerAliveInterval=15"
        "-o"
        "ServerAliveCountMax=3"
      ];
      profiles.system = {
        user = "root";
        path = deploy-rs.lib.aarch64-linux.activate.nixos self.nixosConfigurations.rock5b;
      };
    };

    checks =
      eachSystem (pkgs:
        deploy-rs.lib.${pkgs.stdenv.hostPlatform.system}.deployChecks self.deploy);

    nixosConfigurations.rock5b = nixpkgs.lib.nixosSystem {
      modules = [
        nixos-hardware.nixosModules.rock-5b
        drv-run.nixosModules.host
        sops-nix.nixosModules.sops
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

          sops.age.sshKeyPaths = ["/etc/ssh/ssh_host_ed25519_key"];
          sops.gnupg.sshKeyPaths = [];

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

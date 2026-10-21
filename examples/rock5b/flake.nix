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
      profiles.system = {
        path = deploy-rs.lib.aarch64-linux.activate.nixos self.nixosConfigurations.rock5b;
        user = "root";
      };
      remoteBuild = true;
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
      sshUser = "root";
    };

    checks =
      eachSystem (pkgs:
        deploy-rs.lib.${pkgs.stdenv.hostPlatform.system}.deployChecks self.deploy);

    nixosConfigurations.rock5b = nixpkgs.lib.nixosSystem {
      modules = [
        self.nixosModules.base
        self.nixosModules.dev
        self.nixosModules.rock5b
      ];
    };

    nixosModules = {
      base = {
        config,
        pkgs,
        ...
      }: {
        imports = [sops-nix.nixosModules.sops];

        sops.age.sshKeyPaths = ["/etc/ssh/ssh_host_ed25519_key"];
        sops.gnupg.sshKeyPaths = [];

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

        environment.systemPackages = with pkgs; [
          kitty.terminfo
          sysz
        ];

        programs.htop = {
          enable = true;
          package = pkgs.htop-vim;
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

        system.stateVersion = "26.11";
      };

      dev = {
        config,
        lib,
        pkgs,
        ...
      }: {
        imports = [
          drv-run.nixosModules.host
          drv-run.nixosModules.pi
        ];

        sops.secrets.tailscale-auth-key = {
          sopsFile = ./secrets/tailscale-auth-key;
          format = "binary";
          restartUnits = ["tailscaled-autoconnect.service"];
        };

        networking.firewall.interfaces.${config.services.tailscale.interfaceName}.allowedTCPPorts = [config.services.pi.port];

        services = {
          tailscale = {
            enable = true;
            openFirewall = true;
            authKeyFile = config.sops.secrets.tailscale-auth-key.path;
            # Keep the host's LAN DNS and routing; only join the tailnet.
            extraUpFlags = ["--accept-dns=false" "--accept-routes=false"];
          };

          drv-run = {
            guest.extraModules = [
              {
                microvm.vcpu = 4;
                microvm.mem = 4096;

                zramSwap = {
                  enable = true;
                  algorithm = "zstd";
                  memoryPercent = 50;
                };

                programs.git = {
                  enable = true;
                  config.user = {
                    name = "root";
                    email = "root@guest";
                  };
                };

                environment.etc."jj/config.toml".text = ''
                  [user]
                  name = "root"
                  email = "root@guest"
                '';

                environment.systemPackages = with pkgs; [
                  kitty.terminfo
                ];

                environment.persistence."/persist".users.root.directories = [
                  {
                    directory = ".pi/agent";
                    mode = "0700";
                  }
                ];
                systemd.tmpfiles.rules = [
                  "d /root/.pi 0700 root root - -"
                  "d /root/.pi/agent 0700 root root - -"
                  "C /root/.pi/agent/settings.json 0600 root root - ${./.pi/settings.json}"
                  "C /root/.pi/agent/keybindings.json 0600 root root - ${./.pi/keybindings.json}"
                ];
              }
            ];

            network = {
              uplink = "enP4p65s0";
              dnsServers = ["192.168.4.1"];
            };
          };

          pi = {
            enable = true;
            user = "me";
            host = "0.0.0.0";
          };
        };
      };

      rock5b = {
        config,
        lib,
        pkgs,
        modulesPath,
        ...
      }: {
        imports = [
          nixos-hardware.nixosModules.rock-5b
          (modulesPath + "/installer/sd-card/sd-image.nix")
        ];

        nixpkgs.hostPlatform = "aarch64-linux";

        assertions = [
          {
            assertion = pkgs.stdenv.hostPlatform.system == "aarch64-linux";
            message = "ROCK 5B requires aarch64-linux.";
          }
          {
            # Match nixos-hardware's 16 MiB firmware backoff before the ESP:
            # https://github.com/NixOS/nixos-hardware/blob/4bc63156b109ee7b4103e3ec30565c8c92bde435/rockchip/disko.nix#L28-L32
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
          # The Radxa profile enables bcachefs; this image only uses ext4/vfat:
          # https://github.com/NixOS/nixos-hardware/blob/4bc63156b109ee7b4103e3ec30565c8c92bde435/radxa/default.nix#L15-L22
          supportedFilesystems.bcachefs = lib.mkForce false;
          # The SD-image expander mistakes the device minor number for the partition number:
          # https://github.com/NixOS/nixpkgs/blob/a32edd7654519351e48e80372a928df336394670/nixos/modules/installer/sd-card/sd-image.nix#L400-L406
          # growPartition parses the partition suffix instead, handling mmcblk1p2 correctly:
          # https://github.com/NixOS/nixpkgs/blob/a32edd7654519351e48e80372a928df336394670/nixos/modules/system/boot/grow-partition.nix#L47-L58
          growPartition = true;
        };

        fileSystems."/".autoResize = true;
        hardware.deviceTree.name = "rockchip/rk3588-rock-5b.dtb";

        networking = {
          hostName = "rock5b";
          useDHCP = false;
          firewall = {
            enable = true;
            interfaces.enP4p65s0.allowedTCPPorts = [8080];
          };
        };

        systemd.network.networks."10-ethernet" = {
          matchConfig.Name = "en* eth*";
          networkConfig.DHCP = "ipv4";
        };

        image.baseName = "rock5b";
        sdImage = {
          firmwarePartitionOffset = 16;
          expandOnBoot = false;
          # In this image, U-Boot/extlinux reads /boot on the bootable root partition:
          # https://github.com/NixOS/nixpkgs/blob/a32edd7654519351e48e80372a928df336394670/nixos/modules/installer/sd-card/sd-image.nix#L171-L178
          # https://github.com/NixOS/nixpkgs/blob/a32edd7654519351e48e80372a928df336394670/nixos/modules/installer/sd-card/sd-image.nix#L330-L339
          populateFirmwareCommands = "";
          populateRootCommands = ''
            mkdir -p ./files/boot
            ${config.boot.loader.generic-extlinux-compatible.populateCmd} \
              -c ${config.system.build.toplevel} -d ./files/boot
          '';
          # Offsets from nixos-hardware's Rockchip firmware installation hook:
          # https://github.com/NixOS/nixos-hardware/blob/4bc63156b109ee7b4103e3ec30565c8c92bde435/rockchip/default.nix#L34-L39
          postBuildCommands = let
            firmware = config.hardware.rockchip.platformFirmware;
          in ''
            test "$(stat -c %s ${firmware}/idbloader.img)" -le $(((16384 - 64) * 512))
            test "$(stat -c %s ${firmware}/u-boot.itb)" -le $((${toString config.sdImage.firmwarePartitionOffset} * 1024 * 1024 - 16384 * 512))
            dd if=${firmware}/idbloader.img of="$img" bs=512 seek=64 conv=notrunc
            dd if=${firmware}/u-boot.itb of="$img" bs=512 seek=16384 conv=notrunc
          '';
        };
      };
    };
  };
}

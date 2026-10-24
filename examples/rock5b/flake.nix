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
        pkgs = import nixpkgs {
          inherit system;
          overlays = [drv-run.overlays.default];
        };
      in
        f pkgs);
  in {
    devShells = eachSystem (pkgs: {
      default = pkgs.mkShellNoCC {
        packages = with pkgs; [age sops ssh-to-age];
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
            nix-fast-build \
              --flake ./examples/rock5b \
              --select 'flake: {
                host  = flake.nixosConfigurations.rock5b.config.system.build.toplevel;
                guest = flake.deploy.nodes.rock5b.profiles.system.path;
                shell = flake.inputs.drv-run.devShells.aarch64-linux.default;
              }' \
              --systems aarch64-linux \
              --cachix-cache drv-run \
              --push-build-closure

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
      sshUser = "root";
    };

    checks = eachSystem (
      pkgs: deploy-rs.lib.${pkgs.stdenv.hostPlatform.system}.deployChecks self.deploy
    );

    nixosConfigurations.rock5b = nixpkgs.lib.nixosSystem {
      modules = [
        self.nixosModules.rock5b # hardware: https://radxa.com/products/rock5/5b
        self.nixosModules.system # users, ssh, and a few helpful sysadmin tools
        self.nixosModules.drv-run # serve nixos microvms over ssh
        self.nixosModules.mitm # proxies guest credentials, eg. for git access
        self.nixosModules.tailscale # so we can serve guest https over tailscale
      ];
    };

    nixosModules = {
      drv-run = {
        config,
        lib,
        pkgs,
        ...
      }: {
        imports = [
          drv-run.nixosModules.host
          drv-run.nixosModules.pi
        ];

        services = {
          # Configure drv.run to serve nixos microvms over ssh. Later on we'll
          # setup pi over https and connect it to drv.run as the harness's
          # execution environment. This gives us microvms over ssh, and also
          # (some lines down) an assistant (pi) over private https that executes
          # tools and runs code in a nixos microvm!
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

                # avoid cli warnings that annoy agents (lmao)
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

                environment.systemPackages = [pkgs.kitty.terminfo];
              }
            ];

            network = {
              uplink = "enP4p65s0";
              dnsServers = ["192.168.4.1"];
            };
          };

          # Configure our homegrown pi-based frontend application and serve it over
          # tailscale dns. Access it on your phone from anywhere!
          pi = {
            enable = true;
            env = {
              HOST = "127.0.0.1";
              ORIGIN = "https://rock5b.tailc7072.ts.net";
              PARALLEL_API_KEY_FILE = config.sops.secrets.parallel-api-key.path;
            };
            user = "me";
          };
          sops.secrets.parallel-api-key = {
            sopsFile = ./secrets/parallel-api-key;
            format = "binary";
            owner = config.services.pi.user;
            mode = "0400";
          };
        };
      };

      mitm = {config, ...}: {
        assertions = [
          {
            assertion = builtins.pathExists ./secrets/mitm-proxy-ca-key;
            message = "run scripts/setup-proxy-ca.sh and try again";
          }
        ];
        sops.secrets.mitm-proxy-ca-key = {
          sopsFile = ./secrets/mitm-proxy-ca-key;
          format = "binary";
          mode = "0400";
          restartUnits = ["mitm-proxy.service"];
        };
        system.activationScripts.mitm-proxy.deps = ["setupSecrets"];

        services.drv-run.mitm-proxy = {
          # A trusted CA is required to proxy HTTPS.
          caPrivateKeyFile = config.sops.secrets.mitm-proxy-ca-key.path;
          caCertificate = ''
            -----BEGIN CERTIFICATE-----
            MIIEPTCCAqWgAwIBAgIUeborlbdunarvp2zF6Pqt1TJGNXUwDQYJKoZIhvcNAQEL
            BQAwJjEkMCIGA1UEAwwbZHJ2LnJ1biBjcmVkZW50aWFsIHByb3h5IENBMB4XDTI2
            MTAyNDA5NTEyMFoXDTM2MTAyMTA5NTEyMFowJjEkMCIGA1UEAwwbZHJ2LnJ1biBj
            cmVkZW50aWFsIHByb3h5IENBMIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKC
            AYEAyjubrO5fdMgrHIMg50mYaCvtRr7391FoJvo2vWGb+LuSXjIBmbps9vM4AQjC
            SlYjNu/3uciACt3EVWWqpSa0aqa7AXPklx23HES2K88tZ+9MjIB+AYHRQHreQcKr
            zn5b8CISFraXN7wx70KZjUf7fn7SKYoPirjdGSRW6Q/TKJCxeUzPpc81NGibrdvA
            mxr5h3Pt0aSxr4VWXw467+SW+mHUj2hKUKK0WHjs9OT/JMAkd4rgaGSL0mlCiLvf
            tZOfCdGEFEsMsRtpl6vTRJo60GGwVYBca5FnjB8EAGr3GYF80f9KGWJzAxAGU9X1
            8XT3MxVy/w3YaRT9CoGzNlhh6UhYBvPbclwH9jvU8J0+bRjyuyO8ajXxY5Fqt8pQ
            LyEnZnxbYvpLAS8uxChU5bthRLI573TicMQzFE8isdeiMc1+CHEfxh+WrWmGjE5f
            V4CvWJmHgkLTaoYrvUWSoipGA4MetBQJwb2gKhK2BZfEhrc4n4I12wv5cPxr+m4B
            J9vTAgMBAAGjYzBhMB8GA1UdIwQYMBaAFHOFuerKpdBZ1pQfeu6GSLHKsH9pMA8G
            A1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMB0GA1UdDgQWBBRzhbnqyqXQ
            WdaUH3ruhkixyrB/aTANBgkqhkiG9w0BAQsFAAOCAYEAfh+wSWHd4faO8rxSApjK
            2qCPqyhtvVf+U5z41EVGarEpzOPTDvQH2oZ7qvJ53hJcviNpp45hwjn5tWxesMsw
            9lATlp6pOTEzCZSEquyt403mPHg3Ewy7BnE25PI+8yS8x1fzo1WsP/jbfpaF6UJZ
            kIycCirF6maLGi7R6XvOoMXcc4KPq8GP6F1kBkdeJCvxGzObdcRIOOCWLidTARkT
            GG3o940sDu/PNWLRzCMZ/nODnYSjrTX613TFXcXUVrLBvMndqA1NPP9NIikqL2d8
            Ly0y877zVH6CVh77EcegA/M/i3dME3Sh2szejdLcMADNX8aFd0Ft/9Yx5GjvPTM4
            Lfqx7p6Sb7bohGPBw+qZwej3W6O7WXiuFQIt8Rcj71Nonenb7AvbR6fxyMu0vMko
            ywi/63nzMOUmPb9ca/luSyf9uNHUUGKlIwQ+WJoDD5pDqlKBUVILBKyu+a0MeoE5
            sjH8lkqOo+5/2tUp7YecLF+58LK4Y7DjgZYZFlmgTdZN
            -----END CERTIFICATE-----
          '';

          owners.me.githubUserId = 11872440;
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

      system = {
        config,
        pkgs,
        ...
      }: {
        system.stateVersion = "26.11";
        imports = [sops-nix.nixosModules.sops];
        nixpkgs.overlays = [drv-run.overlays.default];

        environment.systemPackages = with pkgs; [
          htop-vim
          kitty.terminfo
          otel-cli
          otel-desktop-viewer
          subtrace
          sysz
        ];

        nix.settings = {
          experimental-features = ["nix-command" "flakes"];
          sandbox = true;
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
      };

      tailscale = {
        config,
        lib,
        ...
      }: {
        services = {
          tailscale = {
            enable = true;
            openFirewall = true;
            authKeyFile = config.sops.secrets.tailscale-auth-key.path;
            # Keep the host's LAN DNS and routing; only join the tailnet.
            extraUpFlags = ["--accept-dns=false" "--accept-routes=false"];
          };
        };
        sops.secrets.tailscale-auth-key = {
          sopsFile = ./secrets/tailscale-auth-key;
          format = "binary";
          restartUnits = ["tailscaled-autoconnect.service"];
        };
        systemd.services.pi-https = {
          description = "serve pi over https via tailscale";
          wantedBy = ["multi-user.target"];
          wants = ["tailscaled-autoconnect.service"];
          after = ["tailscaled-autoconnect.service"];
          serviceConfig = {
            Type = "exec";
            ExecStart = "${lib.getExe config.services.tailscale.package} serve --https=443 http://127.0.0.1:${toString config.services.pi.port}";
            Restart = "always";
            RestartSec = 5;
          };
        };
      };
    };
  };
}

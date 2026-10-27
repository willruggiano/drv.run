{
  description = "An example of running drv.run on a Radxa ROCK 5B";

  inputs = {
    self.submodules = true;
    drv-run.url = "path:../..";
    deploy-rs = {
      url = "github:serokell/deploy-rs/45ba3f8c5cb28396fff71671806e2550b464ac86";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    disko = {
      url = "github:nix-community/disko/cedd626e11b635470fa6f9fdb8ad79b0075dd7f9";
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
    disko,
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

    apps = eachSystem (pkgs: let
      build = pkgs.writeShellApplication {
        name = "rock5b.build";
        runtimeInputs = [
          pkgs.cachix
          pkgs.nixVersions.latest
        ];
        text = let
          system = "aarch64-linux";
        in ''
          nix-fast-build \
            --flake ./examples/rock5b \
            --systems ${system}   \
            --select 'flake: {
              host  = flake.nixosConfigurations.rock5b.config.system.build.toplevel;
              guest = flake.deploy.nodes.rock5b.profiles.system.path;
              shell = flake.inputs.drv-run.devShells.${system}.default;
            }' "$@"
        '';
      };
      deploy = pkgs.writeShellApplication {
        name = "rock5b.deploy";
        runtimeInputs = [
          build
          deploy-rs.packages.${pkgs.stdenv.hostPlatform.system}.default
          pkgs.openssh
        ];
        text = ''
          rock5b.build --cachix-cache drv-run --push-build-closure
          exec deploy --fast-connection=true --hostname=rock5b --skip-checks ./examples/rock5b "$@"
        '';
      };
      installerKey = pkgs.writeShellApplication {
        name = "rock5b.installer-key";
        runtimeInputs = with pkgs; [coreutils openssh ssh-to-age sops];
        text = ''
          if [[ $# != 1 ]]; then
            echo "Usage: rock5b.installer-key /private/identity-directory (from the repository root)" >&2
            exit 1
          fi
          test -f examples/rock5b/flake.nix
          identity=$(realpath -m "$1")
          case "$identity/" in
            "$(pwd -P)/"* | "${builtins.storeDir}/"*) echo "Keep private keys outside the repository and Nix store." >&2; exit 1 ;;
          esac
          umask 077
          mkdir -m 0700 "$identity"
          ssh-keygen -q -t ed25519 -N "" -f "$identity/ssh_host_ed25519_key"
          recipient=$(ssh-to-age -i "$identity/ssh_host_ed25519_key.pub")
          ciphertext=$(mktemp -d "$identity/ciphertext.XXXXXX")
          trap 'rm -rf "$ciphertext"' EXIT
          secrets=examples/rock5b/secrets
          for name in ${nixpkgs.lib.concatStringsSep " " (builtins.attrNames self.nixosConfigurations.rock5b.config.sops.secrets)}; do
            sops decrypt --input-type json --output-type binary "$secrets/$name" |
              sops encrypt --input-type binary --output-type json --age "$recipient" /dev/stdin >"$ciphertext/$name"
          done
          # Publish only after every existing secret has been decrypted and re-encrypted.
          for file in "$ciphertext"/*; do
            mv "$file" "$secrets/$(basename "$file")"
          done
          ssh-keygen -lf "$identity/ssh_host_ed25519_key.pub"
        '';
      };
    in
      {
        installer-key = {
          type = "app";
          program = nixpkgs.lib.getExe installerKey;
          meta.description = "generate a fresh host identity and re-encrypt the host's SOPS secrets";
        };
        build = {
          type = "app";
          program = nixpkgs.lib.getExe build;
          meta.description = "nix-fast-build the host, guest, and shell outputs";
        };
        deploy = {
          type = "app";
          program = nixpkgs.lib.getExe deploy;
          meta.description = "build and deploy the rock5b";
        };
      }
      // nixpkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isAarch64 {
        installer-image = {
          type = "app";
          program = nixpkgs.lib.getExe (pkgs.writeShellApplication {
            name = "rock5b.installer-image";
            runtimeInputs = with pkgs; [coreutils openssh ssh-to-age sops];
            text = ''
              if [[ $# != 2 ]]; then
                echo "Usage: rock5b.installer-image /private/ssh_host_ed25519_key /new/image-directory (from the repository root)" >&2
                exit 1
              fi
              test -f examples/rock5b/flake.nix
              identity=$(realpath -e "$1")
              output=$(realpath -m "$2")
              for path in "$identity" "$output"; do
                case "$path/" in
                  "$(pwd -P)/"* | "${builtins.storeDir}/"*) echo "Keep private keys and images outside the repository and Nix store." >&2; exit 1 ;;
                esac
              done
              umask 077
              validation=$(mktemp -d)
              trap 'rm -rf "$validation"' EXIT
              ssh-to-age -private-key -i "$identity" > "$validation/age-key"
              for secret in ${nixpkgs.lib.escapeShellArgs (map (secret: toString secret.sopsFile) (builtins.attrValues self.nixosConfigurations.rock5b.config.sops.secrets))}; do
                env -i PATH="$PATH" HOME="$validation" SOPS_AGE_KEY_FILE="$validation/age-key" \
                  sops decrypt --input-type json --output-type binary "$secret" >/dev/null
              done
              rm -rf "$validation"
              trap - EXIT
              mkdir -m 0700 "$output"
              cd "$output"
              ${self.nixosConfigurations.rock5b-installer.config.system.build.diskoImagesScript} \
                --post-format-files "$identity" /boot/ssh_host_ed25519_key
              chmod 0600 main.raw
            '';
          });
          meta.description = "assemble a private MMC installer image on an aarch64-linux builder";
        };
      });

    checks = eachSystem (pkgs:
      deploy-rs.lib.${pkgs.stdenv.hostPlatform.system}.deployChecks self.deploy
      // {
        installer = let
          host = self.nixosConfigurations.rock5b.config;
          installer = self.nixosConfigurations.rock5b-installer.config;
          disk = installer.disko.devices.disk.main;
          service = installer.systemd.services.rock5b-install;
        in
          assert disk.device == "/dev/mmcblk1";
          assert disk.content.partitions.ESP.label != host.disko.devices.disk.main.content.partitions.ESP.label;
          assert disk.content.partitions.root.label != host.disko.devices.disk.main.content.partitions.root.label;
          assert service.unitConfig.ConditionPathExists == "!/var/lib/rock5b-installer/started";
          assert service.serviceConfig.Restart == "no";
          assert service.environment.INSTALL_ROOT == host.disko.rootMountPoint;
            pkgs.runCommand "rock5b-installer-tests" {nativeBuildInputs = with pkgs; [nodejs bash coreutils];} ''
              test -x ${service.serviceConfig.ExecStart}
              test -s ${service.environment.HANDOFF_SCRIPT}
              node --test ${./.}/tests/installer.test.ts
              touch "$out"
            '';
        installer-identity =
          pkgs.runCommand "rock5b-installer-identity-tests" {
            nativeBuildInputs = with pkgs; [age sops ssh-to-age openssh coreutils];
          } ''
            mkdir -p repo/examples/rock5b/secrets
            cd repo
            touch examples/rock5b/flake.nix
            export SOPS_AGE_KEY_FILE="$TMPDIR/old-age-key"
            age-keygen -o "$SOPS_AGE_KEY_FILE"
            recipient=$(age-keygen -y "$SOPS_AGE_KEY_FILE")
            printf '\x00test credential\n' > "$TMPDIR/plaintext"
            for name in ${nixpkgs.lib.concatStringsSep " " (builtins.attrNames self.nixosConfigurations.rock5b.config.sops.secrets)}; do
              sops encrypt --input-type binary --output-type json --age "$recipient" "$TMPDIR/plaintext" \
                > "examples/rock5b/secrets/$name"
            done
            cp -a examples/rock5b/secrets "$TMPDIR/original"
            ${self.apps.${pkgs.stdenv.hostPlatform.system}.installer-key.program} "$TMPDIR/identity"
            ssh-to-age -private-key -i "$TMPDIR/identity/ssh_host_ed25519_key" > "$TMPDIR/new-age-key"
            for secret in examples/rock5b/secrets/*; do
              SOPS_AGE_KEY_FILE="$TMPDIR/new-age-key" sops decrypt --input-type json --output-type binary "$secret" > "$TMPDIR/decrypted"
              cmp "$TMPDIR/plaintext" "$TMPDIR/decrypted"
            done
            if ${self.apps.${pkgs.stdenv.hostPlatform.system}.installer-key.program} "$PWD/leaked-key"; then
              exit 1
            fi
            test ! -e leaked-key
            cp -a examples/rock5b/secrets "$TMPDIR/before"
            # The old identity must no longer decrypt anything, and failure must not publish ciphertext.
            if ${self.apps.${pkgs.stdenv.hostPlatform.system}.installer-key.program} "$TMPDIR/rejected-identity"; then
              exit 1
            fi
            for secret in examples/rock5b/secrets/*; do
              cmp "$secret" "$TMPDIR/before/$(basename "$secret")"
            done
            # Fail after several successful decryptions; none may have been published.
            cp "$TMPDIR/original/tailscale-auth-key" examples/rock5b/secrets/tailscale-auth-key
            cp -a examples/rock5b/secrets "$TMPDIR/partial-before"
            if SOPS_AGE_KEY_FILE="$TMPDIR/new-age-key" ${self.apps.${pkgs.stdenv.hostPlatform.system}.installer-key.program} "$TMPDIR/partial-identity"; then
              exit 1
            fi
            for secret in examples/rock5b/secrets/*; do
              cmp "$secret" "$TMPDIR/partial-before/$(basename "$secret")"
            done
            touch "$out"
          '';
        storage-layout = let
          inherit (nixpkgs) lib;
          host = self.nixosConfigurations.rock5b.config;
          disk = host.disko.devices.disk.main;
        in
          assert lib.assertMsg (
            builtins.attrNames host.disko.devices.disk
            == ["main"]
            && disk.device == "/dev/nvme0n1"
            && disk.content.type == "gpt"
            && disk.content.partitions.ESP.start == "16M"
            && disk.content.partitions.ESP.size == "500M"
            && disk.content.partitions.root.size == "100%"
          ) "Disko must provision only NVMe using the Radxa GPT layout.";
          assert lib.assertMsg (
            builtins.attrNames host.fileSystems
            == ["/" "/boot"]
            && host.fileSystems."/".device == disk.content.partitions.root.device
            && host.fileSystems."/".fsType == "bcachefs"
            && host.fileSystems."/boot".device == disk.content.partitions.ESP.device
            && host.fileSystems."/boot".fsType == "vfat"
            && host.boot.loader.systemd-boot.enable
            && !host.boot.loader.generic-extlinux-compatible.enable
            && !host.boot.growPartition
            && !host.disko.imageBuilder.useVirtualDevices
          ) "The host and image builder must support the Radxa bcachefs/ESP layout, without MMC mounts.";
            pkgs.runCommand "rock5b-storage-layout" {nativeBuildInputs = [pkgs.kmod];} ''
              for module in bcachefs 9p; do
                modprobe --show-depends \
                  --dirname ${host.disko.imageBuilder.kernelPackages.kernel.modules} \
                  --set-version ${host.boot.kernelPackages.kernel.modDirVersion} \
                  "$module" >/dev/null
              done
              touch "$out"
            '';
      });

    deploy.nodes.rock5b = {
      hostname = "rock5b";
      profiles.system = {
        path = deploy-rs.lib.aarch64-linux.activate.nixos self.nixosConfigurations.rock5b;
        user = "root";
      };
      sshUser = "root";
    };

    nixosConfigurations.rock5b = nixpkgs.lib.nixosSystem {
      modules = [
        self.nixosModules.rock5b # hardware: https://radxa.com/products/rock5/5b
        self.nixosModules.system # users, ssh, and a few helpful sysadmin tools
        self.nixosModules.drv-run # serve nixos microvms over ssh
        self.nixosModules.mitm # proxies guest credentials, eg. for git access
        self.nixosModules.tailscale # so we can serve guest https over tailscale
      ];
    };

    nixosConfigurations.rock5b-installer = nixpkgs.lib.nixosSystem {
      modules = [
        self.nixosModules.rock5b
        (import ./installer.nix {target = self.nixosConfigurations.rock5b;})
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

        # Configure drv.run to serve nixos microvms over ssh. Later on we'll
        # setup pi over https and connect it to drv.run as the harness's
        # execution environment. This gives us microvms over ssh, and also
        # (some lines down) an assistant (pi) over private https that executes
        # tools and runs code in a nixos microvm!
        services.drv-run = {
          notifications.enable = true;
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

              environment.systemPackages = with pkgs; [
                gdu
                kitty.terminfo
                otel-cli
                subtrace
              ];
            }
          ];

          network = {
            uplink = "enP4p65s0";
            dnsServers = ["192.168.4.1"];
          };
        };

        # Configure our homegrown pi-based frontend application and serve it over
        # tailscale dns. Access it on your phone from anywhere!
        services.pi = {
          enable = true;
          notifications = {
            enable = true;
            push = {
              enable = true;
              subject = "https://github.com/willruggiano";
              privateKeyFile = config.sops.secrets.notifications-vapid.path;
              origins = [
                "https://fcm.googleapis.com"
                "https://web.push.apple.com"
              ];
            };
          };
          env = {
            ORIGIN = "https://rock5b.tailc7072.ts.net";
            PARALLEL_API_KEY_FILE = config.sops.secrets.parallel-api-key.path;
          };
          user = "me";
        };
        sops.secrets.notifications-vapid = {
          sopsFile = ./secrets/notifications-vapid;
          format = "binary";
          owner = config.services.pi.user;
          mode = "0400";
        };
        sops.secrets.parallel-api-key = {
          sopsFile = ./secrets/parallel-api-key;
          format = "binary";
          owner = config.services.pi.user;
          mode = "0400";
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
        pkgs,
        ...
      }: {
        imports = [
          nixos-hardware.nixosModules.rock-5b
          disko.nixosModules.disko
          "${nixos-hardware}/radxa/disko.nix"
        ];

        nixpkgs.hostPlatform = "aarch64-linux";

        assertions = [
          {
            assertion = pkgs.stdenv.hostPlatform.system == "aarch64-linux";
            message = "ROCK 5B requires aarch64-linux.";
          }
        ];

        boot.initrd = {
          systemd.enable = true;
          availableKernelModules = ["dw_mmc_rockchip" "sdhci_of_dwcmshc" "nvme"];
        };

        disko = {
          checkScripts = true;
          devices.disk.main = {
            device = "/dev/nvme0n1";
            imageSize = "16G";
          };
          imageBuilder = {
            useVirtualDevices = false;
            # Disko includes kernel.modules in the builder VM's module tree.
            # bcachefs is an out-of-tree module in the pinned nixpkgs.
            kernelPackages =
              config.boot.kernelPackages
              // {
                kernel =
                  config.boot.kernelPackages.kernel
                  // {
                    modules = pkgs.aggregateModules [
                      config.boot.kernelPackages.kernel.modules
                      config.boot.bcachefs.modulePackage
                    ];
                  };
              };
          };
        };

        hardware = {
          enableAllHardware = true;
          deviceTree.name = "rockchip/rk3588-rock-5b.dtb";
        };

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
          gdu
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

{
  nixpkgs,
  microvm,
  impermanence,
  self,
  ...
} @ inputs: {
  config,
  lib,
  pkgs,
  ...
}: {
  imports = [
    microvm.nixosModules.microvm
    impermanence.nixosModules.impermanence
    ./cloud-hypervisor.nix
    ./environment.nix
    ./notifications.nix
    ../nix.nix
  ];

  assertions = [
    {
      assertion = config.microvm.storeOnDisk && config.microvm.registerClosure && config.nix.enable && config.microvm.writableStoreOverlay != null;
      message = "drv.run environment images require a registered generic store and a private writable overlay.";
    }
  ];

  boot = {
    initrd.systemd = {
      # Persistence and store overlays exceed systemd's five mount events/s.
      managerEnvironment.SYSTEMD_DEFAULT_MOUNT_RATE_LIMIT_BURST = "64";
    };
    tmp.useTmpfs = false;
  };
  systemd.managerEnvironment.SYSTEMD_DEFAULT_MOUNT_RATE_LIMIT_BURST = "64";
  fileSystems = {
    "/" = {
      device = "rootfs";
      fsType = "tmpfs";
      neededForBoot = true;
      options = ["size=50%" "mode=0755"];
    };
    "/persist".neededForBoot = true;
  };
  # Bound coldplug concurrency to the Guest CPUs without skipping device events.
  environment.etc."udev/udev.conf.d/10-drv-run.conf".text = ''
    children_max=${toString (2 * config.microvm.vcpu)}
  '';
  environment.etc."xdg/llms.txt".text = ''
    drv.run core dependencies:
    deploy-rs -> ${inputs.deploy-rs.outPath}
    drv.run -> ${inputs.self.outPath}
    impermanence -> ${inputs.impermanence.outPath}
    microvm.nix -> ${inputs.microvm.outPath}
    nix -> ${pkgs.nix.doc}
    nixpkgs -> ${inputs.nixpkgs.outPath}
               `-- docs -> /doc
               `-- nixos manual -> /nixos/doc/manual
    openssh -> use `man` (${pkgs.openssh.man})
    pi -> ${pkgs.app}/lib/app/node_modules/@earendil-works
          `-- durable -> /pi-durable/{dist/,README.md}
          `-- env -> /pi-env/{docs/,README.md}
          `-- telemetry -> /pi-telemetry/
    sops-nix -> ${inputs.sops-nix.outPath}
    systemd -> use `man` (${pkgs.systemd.man})
  '';
  environment.persistence."/persist" = {
    directories = [
      # /nix is mounted in the initrd, before its nested store mounts.
      "/nix"
      "/var/lib/nixos"
      {
        directory = "/workspace";
        user = "root";
        group = "root";
        mode = "0700";
      }
    ];
    users.root = {
      directories = [
        {
          directory = ".local/state/nix";
          mode = "0700";
        }
      ];
    };
  };
  microvm = {
    mem = lib.mkDefault (3 * 1024);
    storeOnDisk = true;
    # Fresh Guests can share cached pages of the immutable Guest closure image.
    storeDiskDirect = false;
    vcpu = lib.mkDefault 2;
    volumes = [
      {
        image = "state.img";
        label = "drv-run-state";
        mountPoint = "/persist";
        fsType = "ext4";
        size = 16 * 1024;
        # The worker only formats a new sparse file, whose unwritten bytes are zero.
        mkfsExtraArgs = ["-E" "assume_storage_prezeroed=1"];
        autoCreate = false;
        size = lib.mkDefault (50 * 1024); # MiB
      }
      {
        image = "environment.erofs";
        fsType = "erofs";
        label = null;
        mountPoint = null;
        size = 0;
        autoCreate = false;
        readOnly = true;
        direct = false;
      }
    ];
    writableStoreOverlay = lib.mkDefault "/nix/.rw-store";
  };
  networking = {
    firewall.enable = true;
    hostName = "guest";
    useDHCP = false;
  };
  nix = {
    enable = true;
    registry.nixpkgs.flake = nixpkgs;
    settings = {
      accept-flake-config = true;
      experimental-features = ["nix-command" "flakes"];
      flake-registry = "";
    };
  };
  nixpkgs.overlays = [self.overlays.default];
  programs.git = {
    enable = true;
    config.url = {
      "https://github.com/".insteadOf = "github:";
      "https://git.sr.ht/".insteadOf = "sourcehut:";
      "https://codeberg.org/".insteadOf = "codeberg:";
      "https://gitlab.com/".insteadOf = "gitlab:";
    };
  };
  services.openssh = {
    enable = true;
    generateHostKeys = false;
    hostKeys = [];
    settings = {
      PermitRootLogin = "prohibit-password";
      AuthenticationMethods = "publickey";
      PasswordAuthentication = false;
      KbdInteractiveAuthentication = false;
      DisableForwarding = true;
      PermitUserRC = false;
      ForceCommand = lib.getExe (let
        command = pkgs.writeShellApplication {
          name = "prepared-command";
          runtimeInputs = [pkgs.jq];
          text =
            builtins.readFile ../timing.sh
            + ''
              timing_directory=/run/drv-run-environment
              phase shell-ready
              exec ${lib.getExe pkgs.bashInteractive} -c "$1"
            '';
        };
      in
        pkgs.writeShellApplication {
          name = "ssh-guest";
          runtimeInputs = [config.nix.package pkgs.coreutils];
          text = lib.replaceStrings ["@command@" "@notifications-stream@"] [
            (lib.getExe command)
            (
              if config.services.drv-run.notifications.enable
              then "exec ${pkgs.app}/bin/notify-stream /run/user/0/drv-run-notifications/events.sock"
              else "exit 1"
            )
          ] (builtins.readFile ./guest.sh);
        });
    };
  };
  # TODO: Why are these "extraDependencies"?
  system.extraDependencies = [
    pkgs.bashInteractive
    pkgs.bashInteractive.man
  ];
  system.stateVersion = lib.trivial.release;
}

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
    ../nix.nix
  ];

  assertions = [
    {
      assertion = config.boot.initrd.systemd.enable;
      message = "drv.run persistence requires systemd initrd mount ordering.";
    }
  ];

  boot = {
    initrd.systemd = {
      enable = true;
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
    jail.nix -> ${inputs.jail.outPath}
    microvm.nix -> ${inputs.microvm.outPath}
    nix -> ${pkgs.nix.doc}
    nixpkgs -> ${inputs.nixpkgs.outPath}
               `-- docs -> /doc
               `-- nixos manual -> /nixos/doc/manual
    openssh -> use `man` (${pkgs.openssh.man})
    pi -> ${inputs.pi.outPath}
          `-- durable -> /packages/durable/{docs/,test/examples/,README.md}
          `-- env -> /packages/pi-env/{docs/,README.md}
          `-- telemetry -> /packages/telemetry/
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
        label = null;
        mountPoint = "/persist";
        fsType = "ext4";
        size = 16 * 1024;
        # The worker only formats a new sparse file, whose unwritten bytes are zero.
        mkfsExtraArgs = ["-E" "assume_storage_prezeroed=1"];
        autoCreate = false;
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
      ForceCommand = lib.getExe (
        pkgs.writeShellApplication {
          name = "ssh-guest";
          runtimeInputs = [config.nix.package];
          text = lib.replaceStrings ["@bash@"] [(lib.getExe pkgs.bashInteractive)] (builtins.readFile ./guest.sh);
        }
      );
    };
  };
  # TODO: Why are these "extraDependencies"?
  system.extraDependencies = [
    pkgs.bashInteractive
    pkgs.bashInteractive.man
  ];
  system.stateVersion = lib.trivial.release;
}

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
    drv.run -> ${inputs.self.outPath}
    impermanence -> ${inputs.impermanence.outPath}
    microvm.nix -> ${inputs.microvm.outPath}
    nix -> ${config.nix.package.doc}
    nixpkgs -> ${inputs.nixpkgs.outPath}
               `-- docs -> /doc
               `-- nixos manual -> /nixos/doc/manual
    openssh -> use `man` (${pkgs.openssh.man})
    pi -> ${pkgs.app}/lib/app/node_modules/@earendil-works
          `-- durable -> /pi-durable/{dist/,README.md}
          `-- env -> /pi-env/{docs/,README.md}
          `-- telemetry -> /pi-telemetry/
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
      # FIXME: Do we actually *depend* on this or is it slop?
      directories = [
        {
          directory = ".local/state/nix";
          mode = "0700";
        }
      ];
    };
  };
  microvm = {
    # 8G x 4vCPU seems like a reasonable default
    mem = lib.mkDefault (8 * 1024); # MiB
    vcpu = lib.mkDefault 4;

    # Fresh guests can share cached pages of the immutable guest closure image.
    storeOnDisk = true;
    storeDiskDirect = false;

    volumes = [
      {
        image = "state.img";
        label = "drv-run-state";
        mountPoint = "/persist";
        autoCreate = false;
        fsType = "ext4";
        mkfsExtraArgs = ["-E" "assume_storage_prezeroed=1"];
        size = lib.mkDefault (50 * 1024); # MiB
      }
      {
        # TODO: Explain the weird looking settings please!
        image = "environment.erofs";
        label = null;
        fsType = "erofs";
        autoCreate = false;
        direct = false;
        mountPoint = null;
        readOnly = true;
        size = 0;
      }
    ];

    # drv.run employs a readable lower and writable upper as the guest
    # /nix/store, which... I'm not sold on but it's fine for now.
    writableStoreOverlay = lib.mkDefault "/nix/.rw-store";
  };

  networking = {
    firewall.enable = true;
    # TODO: it'd be nice if this could be the instance ID instead?
    hostName = "guest";
    useDHCP = false;
  };

  # n.b. also see the common options declared in nixosModules/nix.nix
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
    # Address your git repos the same as your flakes!
    # nix flake show github:willruggiano/drv.run
    # jj git clone github:willruggiano/drv.run
    config.url = {
      "https://codeberg.org/".insteadOf = "codeberg:";
      "https://git.sr.ht/".insteadOf = "sourcehut:";
      "https://github.com/".insteadOf = "github:";
      "https://gitlab.com/".insteadOf = "gitlab:";
    };
  };

  # ssh is one of drv.run's **core dependencies**, so much so in fact that one
  # of our mottos is "ssh all the way down" :)
  services.openssh = {
    enable = true;
    generateHostKeys = false;
    hostKeys = [];
    settings = {
      PermitRootLogin = lib.mkDefault "prohibit-password";
      PasswordAuthentication = lib.mkDefault false;
      KbdInteractiveAuthentication = lib.mkDefault false;
    };
  };
  # TODO: Why are these "extraDependencies"?
  system.extraDependencies = [
    pkgs.bashInteractive
    pkgs.bashInteractive.man
  ];
  system.stateVersion = lib.trivial.release;
}

{
  nixpkgs,
  microvm,
  impermanence,
  ...
}: {
  config,
  lib,
  pkgs,
  ...
}: {
  imports = [
    microvm.nixosModules.microvm
    impermanence.nixosModules.impermanence
    ./cloud-hypervisor.nix
  ];

  assertions = [
    {
      assertion = config.boot.initrd.systemd.enable;
      message = "drv.run persistence requires systemd initrd mount ordering.";
    }
    {
      assertion = config.microvm.shares == [];
      message = "drv.run Guests must not share Host directories.";
    }
  ];
  boot = {
    initrd.systemd.enable = true;
    tmp.useTmpfs = false;
  };
  fileSystems = {
    "/" = {
      device = "rootfs";
      fsType = "tmpfs";
      neededForBoot = true;
      options = ["size=50%" "mode=0755"];
    };
    "/persist".neededForBoot = true;
  };
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
      files = [
        {
          file = ".pi/agent/auth.json";
          parentDirectory.mode = "0700";
        }
      ];
    };
  };
  microvm = {
    mem = 3 * 1024;
    storeOnDisk = true;
    vcpu = 2;
    volumes = [
      {
        image = "state.img";
        label = null;
        mountPoint = "/persist";
        fsType = "ext4";
        size = 16 * 1024;
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
      # TODO: This may or may not be a security risk:
      accept-flake-config = true;
      experimental-features = ["nix-command" "flakes"];
      flake-registry = "";
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
      ForceCommand = lib.getExe (
        pkgs.writeShellApplication {
          name = "ssh-guest";
          runtimeInputs = [pkgs.nix];
          text = builtins.readFile ./guest.sh;
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

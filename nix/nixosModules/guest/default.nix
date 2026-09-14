# drv.run / nixosModules / guest
# -----------------------------------
# This is the base drv.run guest configuration.
{
  nixpkgs,
  microvm,
  ...
}: {
  lib,
  pkgs,
  ...
}: {
  imports = [
    microvm.nixosModules.microvm
  ];

  boot = {
    initrd.kernelModules = ["qemu_fw_cfg"];
    tmp.useTmpfs = false;
  };
  fileSystems."/" = {
    neededForBoot = true;
    options = ["defaults"];
  };
  microvm = {
    hypervisor = "qemu";
    # FIXME: See below. We probably don't need these.
    qemu.extraArgs = [
      "-fw_cfg"
      "name=opt/io.systemd.credentials/authorized-keys,file=authorized-keys"
      "-fw_cfg"
      "name=opt/io.systemd.credentials/host-key,file=host-key"
      "-fw_cfg"
      "name=opt/io.systemd.credentials/environment-path,file=environment-path"
      "-monitor"
      "none"
    ];

    interfaces = [
      {
        type = "user";
        id = "ssh";
        mac = "02:00:00:00:00:01";
      }
    ];
    extraArgsScript = lib.getExe (
      pkgs.writeShellApplication {
        name = "ssh-forward";
        text = ''
          printf '%s\n' "-set netdev.ssh.hostfwd=unix:$PWD/ssh.sock-:22"
        '';
      }
    );
    mem = 3 * 1024;
    socket = null;
    storeOnDisk = true;
    vcpu = 2;
    volumes = [
      {
        image = "root.img";
        label = "guest-root";
        mountPoint = "/";
        fsType = "ext4";
        size = 16 * 1024;
      }
    ];
    writableStoreOverlay = lib.mkDefault "/nix/.rw-store";
  };
  networking = {
    firewall.enable = true;
    hostName = "guest";
    useDHCP = false;
    useNetworkd = true;
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
    # FIXME: We know these. We don't need these shenanigans?
    authorizedKeysFiles = ["/run/credentials/sshd.service/authorized-keys"];
    generateHostKeys = false;
    hostKeys = [];
    settings = {
      # FIXME: Stupid. Use the default location.
      HostKey = "/run/credentials/sshd.service/host-key";
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
  systemd = {
    network = {
      enable = true;
      # TODO: Explain.
      networks."10-uplink" = {
        matchConfig.MACAddress = "02:00:00:00:00:01";
        networkConfig.DHCP = "ipv4";
      };
    };
    # FIXME: See above. We probably don't need these.
    services.sshd.serviceConfig.ImportCredential = [
      "authorized-keys"
      "host-key"
      "environment-path"
    ];
    tmpfiles.rules = ["d /workspace 0700 root root"];
  };
}

# Test-only VSOCK transport. No NIC, TAP pool, or production module changes.
{nixosModules}: {
  config,
  lib,
  pkgs,
  ...
}: let
  # Keep the production protocol, changing only its fixed credential pathname.
  # sshd does not propagate CREDENTIALS_DIRECTORY to login sessions.
  protocol = pkgs.writeShellApplication {
    name = "vsock-guest-protocol";
    runtimeInputs = [pkgs.nix];
    text = lib.replaceStrings ["/run/credentials/sshd.service/environment-path"] ["/run/drv-run-seed/environment-path"] (
      builtins.readFile ../../nixosModules/guest/guest.sh
    );
  };
  inspect = pkgs.writeShellApplication {
    name = "vsock-guest-inspect";
    runtimeInputs = [pkgs.bash];
    text = ''
      case ''${SSH_ORIGINAL_COMMAND:-} in
        'inspect '*) exec bash -c "''${SSH_ORIGINAL_COMMAND#inspect }" ;;
        *) exec ${lib.getExe protocol} ;;
      esac
    '';
  };
in {
  imports = [nixosModules.guest];
  assertions = [
    {
      assertion =
        config.microvm.hypervisor
        == "cloud-hypervisor"
        && config.microvm.interfaces == []
        && config.microvm.forwardPorts == []
        && config.microvm.shares == []
        && config.microvm.credentialFiles == {}
        && config.microvm.vsock.ssh.enable
        && config.microvm.declaredRunner.supportsNotifySocket;
      message = "The VSOCK gate requires Cloud Hypervisor notification and SSH without IP networking or shares.";
    }
  ];
  boot = {
    initrd.kernelModules = lib.mkForce ["virtio_pci" "virtio_blk" "vmw_vsock_virtio_transport" "overlay" "ext4"];
    kernelModules = ["button"];
    kernelParams = ["console=ttyS0" "earlyprintk=ttyS0"];
  };
  microvm = {
    hypervisor = lib.mkForce "cloud-hypervisor";
    qemu.extraArgs = lib.mkForce [];
    interfaces = lib.mkForce [];
    extraArgsScript = lib.mkForce null;
    registerWithMachined = false;
    vsock = {
      cid = 42;
      ssh.enable = true;
    };
    cloud-hypervisor.extraArgs = ["--serial" "file=serial.log"];
    volumes = lib.mkAfter [
      {
        image = "seed.img";
        mountPoint = "/run/drv-run-seed";
        fsType = "ext4";
        label = "drv-run-seed";
        size = 8;
        autoCreate = false;
        readOnly = true;
      }
    ];
  };
  fileSystems."/run/drv-run-seed" = {
    options = ["ro" "nodev" "nosuid" "noexec"];
    noCheck = true;
  };
  nix.settings.substituters = lib.mkForce [];
  services = {
    # networkd enables resolved by default; this NIC-less Guest needs no DNS/LLMNR.
    resolved.enable = false;
    logind = {
      enable = true;
      settings.Login.HandlePowerKey = "poweroff";
    };
    openssh = {
      startWhenNeeded = true;
      # [] emits a bare AuthorizedKeysFile directive. Use a valid deny-all
      # default; sshd@ overrides it with the per-connection credential path.
      authorizedKeysFiles = lib.mkForce ["none"];
      settings = {
        # Omit the inherited path; sshd@ supplies its credential with -h.
        HostKey = lib.mkForce null;
        ForceCommand = lib.mkForce (lib.getExe inspect);
      };
    };
  };
  environment.systemPackages = [pkgs.curl pkgs.jq];
  systemd = {
    network = {
      networks = lib.mkForce {};
      wait-online.enable = false;
    };
    sockets.sshd.enable = false;
    services = {
      sshd.enable = false;
      # systemd-ssh-generator aliases sshd-vsock@ to NixOS's sshd@ template.
      # %d is expanded by systemd for each connection, not by sshd.
      "sshd@" = {
        unitConfig.RequiresMountsFor = "/run/drv-run-seed";
        serviceConfig = {
          LoadCredential = [
            "authorized-keys:/run/drv-run-seed/authorized-keys"
            "host-key:/run/drv-run-seed/host-key"
          ];
          ExecStart = lib.mkForce "-${pkgs.openssh}/bin/sshd -i -D -f /etc/ssh/sshd_config -h %d/host-key -o AuthorizedKeysFile=%d/authorized-keys";
        };
      };
    };
  };
}

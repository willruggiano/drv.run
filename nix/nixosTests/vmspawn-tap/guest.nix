# Network-only Guest: a self-contained ext4 root, no Host filesystem shares.
{
  config,
  lib,
  modulesPath,
  pkgs,
  ...
}: {
  imports = [
    (modulesPath + "/profiles/minimal.nix")
    (modulesPath + "/profiles/qemu-guest.nix")
  ];
  system.stateVersion = lib.trivial.release;
  boot = {
    loader.grub.enable = false;
    initrd = {
      systemd.enable = true;
      kernelModules = ["virtio_pci" "virtio_blk" "virtio_net" "vmw_vsock_virtio_transport"];
    };
    kernelModules = ["button"];
    kernelParams = ["console=ttyS0"];
  };
  fileSystems."/" = {
    device = "/dev/disk/by-label/vmspawn-gate";
    fsType = "ext4";
  };
  networking = {
    hostName = "vmspawn-guest";
    useNetworkd = true;
    useDHCP = false;
    firewall.enable = false;
  };
  nix.enable = false;
  environment.systemPackages = with pkgs; [curl iproute2 jq netcat-openbsd (python3.withPackages (p: [p.dnspython]))];
  services = {
    resolved.enable = true;
    logind.settings.Login.HandlePowerKey = "poweroff";
    openssh = {
      enable = true;
      startWhenNeeded = true;
      generateHostKeys = false;
      hostKeys = [];
      # [] emits a bare AuthorizedKeysFile directive. Use a valid deny-all
      # default; sshd@ overrides it with the per-connection credential path.
      authorizedKeysFiles = lib.mkForce ["none"];
      settings = {
        PermitRootLogin = "prohibit-password";
        AuthenticationMethods = "publickey";
        PasswordAuthentication = false;
        KbdInteractiveAuthentication = false;
        DisableForwarding = true;
        PermitUserRC = false;
      };
    };
  };
  systemd = {
    network.networks."10-uplink" = {
      matchConfig.Type = "ether";
      networkConfig = {
        DHCP = "ipv4";
        LinkLocalAddressing = "no";
        IPv6AcceptRA = false;
      };
    };
    sockets.sshd.enable = false;
    services = {
      "sshd@".serviceConfig = {
        ImportCredential = ["authorized-keys" "host-key"];
        ExecStart = lib.mkForce "-${pkgs.openssh}/bin/sshd -i -D -f /etc/ssh/sshd_config -h %d/host-key -o AuthorizedKeysFile=%d/authorized-keys";
      };
      # A reachable peer is required before testing Host/inter-Guest isolation.
      gate-listener = {
        wantedBy = ["multi-user.target"];
        serviceConfig = {
          ExecStart = "${pkgs.python3}/bin/python3 -m http.server 8080 --bind 0.0.0.0";
          WorkingDirectory = "/tmp";
        };
      };
    };
  };
  assertions = [
    {
      assertion = config.boot.initrd.systemd.enable && !config.nix.enable;
      message = "The vmspawn TAP gate boots a self-contained, network-only Guest.";
    }
  ];
}

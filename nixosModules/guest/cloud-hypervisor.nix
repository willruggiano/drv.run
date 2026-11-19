{
  config,
  lib,
  pkgs,
  ...
}: {
  assertions = [
    {
      assertion =
        config.microvm.hypervisor
        == "cloud-hypervisor"
        && config.microvm.interfaces == []
        && config.microvm.forwardPorts == []
        && config.microvm.credentialFiles == {}
        && config.microvm.vsock.ssh.enable
        && config.microvm.declaredRunner.supportsNotifySocket;
      message = "drv.run requires Cloud Hypervisor VSOCK management and an inherited nsresourced TAP FD.";
    }
  ];
  boot = {
    # CH 53 emits SMBIOS OEM credentials only on x86. On ARM, pass the
    # non-secret readiness address via the kernel command line instead.
    kernelParams =
      [
        # The VMM console feeds the Host journal, not an interactive terminal.
        # Avoid systemd's unanswered ANSI terminal queries during both stages.
        "systemd.tty.term.console=dumb"
      ]
      ++ lib.optionals pkgs.stdenv.hostPlatform.isAarch64 [
        "systemd.set_credential=vmm.notify_socket:vsock-stream:2:8888"
      ];
    initrd.kernelModules = ["vmw_vsock_virtio_transport"];
    kernelModules = ["button" "virtio_net"];
  };
  microvm = {
    hypervisor = "cloud-hypervisor";
    cloud-hypervisor.package = pkgs.cloud-hypervisor;
    interfaces = [];
    registerWithMachined = false;
    vsock = {
      # CH's Unix socket is private to the Instance; CIDs need not be unique.
      cid = 42;
      ssh.enable = true;
    };
    socket = "control.sock";
    extraArgsScript = lib.getExe (pkgs.writeShellApplication {
      name = "cloud-hypervisor-network";
      text = ''
        [[ ''${DRV_RUN_TAP_FD:-} =~ ^[0-9]+$ ]]
        test -e "/proc/self/fd/$DRV_RUN_TAP_FD"
        printf '%s\n' "--net fd=[$DRV_RUN_TAP_FD],num_queues=2,mac=02:00:00:00:00:01"
      '';
    });
    volumes = lib.mkAfter [
      {
        image = "seed.img";
        # The assembler labels the read-only root lower; files.nix mounts it.
        label = null;
        mountPoint = null;
        fsType = "erofs";
        size = 0;
        autoCreate = false;
        readOnly = true;
        direct = false;
      }
    ];
  };
  networking.useNetworkd = true;
  services = {
    resolved = {
      enable = true;
      settings.Resolve = {
        LLMNR = false;
        MulticastDNS = false;
      };
    };
    logind = {
      enable = true;
      settings.Login.HandlePowerKey = "poweroff";
    };
    openssh = {
      startWhenNeeded = true;
      openFirewall = false;
    };
  };
  systemd = {
    network.networks."10-uplink" = {
      matchConfig.MACAddress = "02:00:00:00:00:01";
      networkConfig = {
        DHCP = "ipv4";
        LinkLocalAddressing = "no";
        IPv6AcceptRA = false;
      };
    };
    # Only systemd-ssh-generator's VSOCK socket may accept SSH connections.
    sockets.sshd.enable = false;
    services.sshd.enable = false;
  };
}

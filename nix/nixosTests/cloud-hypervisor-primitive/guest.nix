# Test-only transport prototype. Keep production on QEMU until this boots.
{nixosModules}: {
  config,
  lib,
  pkgs,
  ...
}: {
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
        && config.microvm.user == null
        && config.microvm.vsock.cid == null
        && config.microvm.vcpu == 2;
      message = "The primitive gate requires an unprivileged two-vCPU Cloud Hypervisor runner with runtime-only networking and seed credentials.";
    }
    {
      assertion = !(config.systemd.network.units ? "10-uplink.network");
      message = "The seed-generated network file must not be overridden or masked by a static networkd unit.";
    }
    {
      assertion = let
        volumes = config.microvm.volumes;
      in
        builtins.length volumes
        == 2
        && (builtins.elemAt volumes 0).image == "state.img"
        && !(builtins.elemAt volumes 0).readOnly
        && (builtins.elemAt volumes 1).image == "seed.img"
        && (builtins.elemAt volumes 1).readOnly
        && lib.all (volume: !volume.autoCreate && volume.imageType == "raw") volumes;
      message = "The primitive gate requires state.img followed by a read-only seed.img, neither automatically created by the runner.";
    }
  ];

  boot = {
    initrd.kernelModules = lib.mkForce ["virtio_pci" "virtio_blk" "virtio_net" "overlay" "ext4"];
    kernelModules = ["virtio_net" "button"];
    kernelParams = ["console=ttyS0" "earlyprintk=ttyS0"];
  };
  microvm = {
    hypervisor = lib.mkForce "cloud-hypervisor";
    qemu.extraArgs = lib.mkForce [];
    interfaces = lib.mkForce [];
    user = null;
    credentialFiles = {};
    vsock.cid = null;
    registerWithMachined = false;
    cloud-hypervisor.extraArgs = ["--serial" "file=serial.log"];
    # Exercise the runtime hook, not upstream TAP creation or metadata.
    extraArgsScript = lib.mkForce (lib.getExe (pkgs.writeShellApplication {
      name = "primitive-net-args";
      runtimeInputs = [pkgs.jq];
      text = ''
        jq -e 'type == "object" and .tap == "drv-primitive" and
          .mac == "02:00:00:00:00:01" and .queues == ${toString (2 * config.microvm.vcpu)}' slot.json >/dev/null
        printf '%s\n' '--net tap=drv-primitive,mac=02:00:00:00:00:01,num_queues=${toString (2 * config.microvm.vcpu)}'
      '';
    }));
    volumes = lib.mkAfter [
      {
        image = "seed.img";
        mountPoint = "/run/drv-run-seed";
        fsType = "ext4";
        label = "drv-run-seed";
        size = 8;
        imageType = "raw";
        autoCreate = false;
        readOnly = true;
      }
    ];
  };
  fileSystems."/run/drv-run-seed" = {
    options = ["ro" "nodev" "nosuid" "noexec"];
    noCheck = true;
  };

  services = {
    resolved.enable = true;
    logind = {
      enable = true;
      settings.Login.HandlePowerKey = "poweroff";
    };
    # Inspection only: the real launcher/guest command grammar is tested later.
    openssh.settings.ForceCommand = lib.mkForce "none";
  };
  environment.systemPackages = [pkgs.curl pkgs.jq];
  systemd = {
    # enable = false masks the /run file with a same-named /etc symlink to
    # /dev/null. Remove the inherited DHCP unit, rather than disabling it.
    network.networks = lib.mkForce {};
    services = {
      drv-run-seed = {
        description = "Load primitive Guest network configuration";
        before = ["systemd-networkd.service" "sshd.service"];
        after = ["local-fs.target"];
        unitConfig = {
          DefaultDependencies = false;
          RequiresMountsFor = "/run/drv-run-seed";
        };
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
        };
        script = ''
          set -euo pipefail
          seed=/run/drv-run-seed
          for file in authorized-keys host-key environment-path uplink.network; do
            test -f "$seed/$file" && test ! -L "$seed/$file" && test -s "$seed/$file"
          done
          ${pkgs.openssh}/bin/ssh-keygen -y -f "$seed/host-key" >/dev/null
          ${pkgs.openssh}/bin/ssh-keygen -l -f "$seed/authorized-keys" >/dev/null
          IFS= read -r environment <"$seed/environment-path"
          [[ $environment == /nix/store/*-env && $environment != *[[:space:]]* ]]
          test -d "$environment"
          install -Dm0644 "$seed/uplink.network" /run/systemd/network/10-uplink.network
        '';
      };
      systemd-networkd = {
        requires = ["drv-run-seed.service"];
        after = ["drv-run-seed.service"];
      };
      sshd = {
        requires = ["drv-run-seed.service"];
        after = ["drv-run-seed.service"];
        serviceConfig = {
          ImportCredential = lib.mkForce [];
          LoadCredential = [
            "authorized-keys:/run/drv-run-seed/authorized-keys"
            "host-key:/run/drv-run-seed/host-key"
            "environment-path:/run/drv-run-seed/environment-path"
          ];
        };
      };
    };
  };
}

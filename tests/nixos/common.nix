{
  hostPkgs,
  lib,
  ...
}: let
  inherit (hostPkgs.stdenv.hostPlatform) system;
in {
  # x86 TCG cannot expose VMX/SVM to the test host. ARM TCG can emulate EL2,
  # so Cloud Hypervisor still uses KVM inside the host without physical KVM.
  qemu.forceAccel = system == "x86_64-linux";
  requiredFeatures.kvm = system == "x86_64-linux";
  # The same lifecycle matrix runs under software emulation, including reboots.
  globalTimeout = 4 * 60 * 60;
  # TCG cold boots can exceed the driver's fixed five-minute connect deadline.
  # Wait for socket readiness first, without consuming the driver's handshake.
  testScript = lib.mkBefore ''
    import select

    for machine in machines_qemu:
        machine.start()
        assert machine.shell is not None
        assert select.select([machine.shell], [], [], 15 * 60)[0], machine.name
        machine.wait_for_unit("multi-user.target")
  '';
  defaults = {
    virtualisation.memorySize = lib.mkDefault 512;
    virtualisation.cores = 2;
    virtualisation.graphics = false;
  };
  nodes.host = {
    virtualisation = {
      memorySize = 2048;
      diskSize = 20480;
      qemu.options =
        {
          aarch64-linux = ["-machine accel=tcg,virtualization=on,gic-version=3"];
          x86_64-linux = ["-cpu" "host"];
        }.${
          system
        };
    };
    services.drv-run.guest.extraModules = [
      ({lib, ...}: {
        microvm.mem = lib.mkForce 512;
      })
    ];
  };
}

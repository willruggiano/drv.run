{...}: {
  boot.initrd.availableKernelModules = ["erofs" "overlay"];
  # Mount the lower and the private writable layer outside /sysroot. Express
  # this root mount explicitly: fstab overlay options would be replayed as an
  # unsupported overlay reconfiguration by systemd-remount-fs after switch-root.
  boot.initrd.systemd.mounts = [
    {
      what = "/dev/disk/by-label/drv-run-seed";
      where = "/run/drv-run-seed";
      type = "erofs";
      options = "ro,nodev,nosuid";
      unitConfig.DefaultDependencies = false;
      before = ["sysroot.mount"];
      requiredBy = ["sysroot.mount"];
    }
    {
      what = "tmpfs";
      where = "/run/drv-run-root";
      type = "tmpfs";
      options = "mode=0700,size=50%";
      unitConfig.DefaultDependencies = false;
      before = ["drv-run-root-directories.service"];
      requiredBy = ["drv-run-root-directories.service"];
    }
    {
      what = "overlay";
      where = "/sysroot";
      type = "overlay";
      options = "lowerdir=/run/drv-run-seed/rootfs,upperdir=/run/drv-run-root/upper,workdir=/run/drv-run-root/work";
      unitConfig.DefaultDependencies = false;
      before = ["initrd-root-fs.target"];
      requiredBy = ["initrd-root-fs.target"];
    }
  ];
  boot.initrd.systemd.services.drv-run-root-directories = {
    unitConfig.DefaultDependencies = false;
    before = ["sysroot.mount"];
    requiredBy = ["sysroot.mount"];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      ExecStart = [
        "/bin/mkdir -p -m 0700 /run/drv-run-root/work"
        "/bin/mkdir -p -m 0755 /run/drv-run-root/upper"
      ];
    };
  };
  fileSystems = {
    "/" = {
      device = "overlay";
      fsType = "overlay";
      neededForBoot = true;
      options = ["rw"];
    };
    # /run carries the initrd mount across switch-root. Do not ask the initrd
    # fstab generator to mount it below /sysroot: that creates an ordering cycle.
    "/run/drv-run-seed" = {
      device = "/dev/disk/by-label/drv-run-seed";
      fsType = "erofs";
      options = ["ro" "nodev" "nosuid"];
      noCheck = true;
    };
  };
}

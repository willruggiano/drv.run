{
  config,
  lib,
  pkgs,
  ...
}: let
  initialize = pkgs.writeShellApplication {
    name = "initialize-environment";
    runtimeInputs = [config.nix.package pkgs.coreutils pkgs.diffutils pkgs.jq pkgs.util-linux];
    text = lib.replaceStrings ["@check-metadata@" "@timing@"] ["${./environment-metadata.jq}" (builtins.readFile ../timing.sh)] (
      builtins.readFile ./environment.sh
    );
  };
  shell = pkgs.writeShellApplication {
    name = "drv-run-shell";
    runtimeInputs = [config.nix.package pkgs.coreutils];
    text = lib.replaceStrings ["@bash@"] [(lib.getExe pkgs.bashInteractive)] (
      builtins.readFile ./shell.sh
    );
    derivationArgs.passthru.shellPath = "/bin/drv-run-shell";
  };
in {
  # Override NixOS's mkDefault root shell, but allow ordinary deployment definitions.
  users.users.root.shell = lib.mkOverride 900 shell;
  assertions = [
    {
      assertion = config.fileSystems."/nix/store".overlay.lowerdir == ["/nix/.ro-store" "/nix/.environment/store"] && config.fileSystems."/nix/store".overlay.upperdir != null;
      message = "drv.run requires generic and environment lower layers, in that order, below a private writable upper layer.";
    }
  ];
  boot.initrd.availableKernelModules = ["erofs"];
  # Record the mount in the initrd, rather than counting it as free work when
  # registration moves out of ExecStartPost. /run survives switch-root.
  boot.initrd.systemd.services = lib.listToAttrs (map (phase: {
    name = "drv-run-image-mount-${phase}";
    value = {
      unitConfig.DefaultDependencies = false;
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
      };
      requiredBy = [
        (
          if phase == "start"
          then "sysroot-nix-.environment.mount"
          else "sysroot-nix-store.mount"
        )
      ];
      before = [
        (
          if phase == "start"
          then "sysroot-nix-.environment.mount"
          else "sysroot-nix-store.mount"
        )
      ];
      after = lib.optional (phase == "ready") "sysroot-nix-.environment.mount";
      script = ''
        read -r uptime _ < /proc/uptime
        printf '{"phase":"image-mount-${phase}","clock":"boottime","monotonic_s":%s,"resolution_s":0.01}\n' "$uptime" \
          > /run/drv-run-image-mount-${phase}.json
      '';
    };
  }) ["start" "ready"]);
  fileSystems = {
    "/nix/.environment" = {
      device = "/dev/disk/by-label/drv-run-env";
      fsType = "erofs";
      neededForBoot = true;
      options = ["ro" "nodev" "nosuid"];
      noCheck = true;
    };
    # microvm supplies the generic store first. NixOS derives initrd mount
    # dependencies from this list; never append a second lowerdir= option.
    "/nix/store" = {
      neededForBoot = true;
      overlay.lowerdir = lib.mkAfter ["/nix/.environment/store"];
    };
  };
  # The generic closure is registered by microvm's stage-2 postBootCommands.
  # Ordinary services require sysinit.target. Register AND root the additional
  # paths before that target, including before GC timers or daemon activation.
  # Failure fails sysinit and powers down: there is no usable partial instance.
  systemd.services.drv-run-environment = {
    description = "Register and root the immutable prepared environment";
    requiredBy = ["sysinit.target"];
    before = ["sysinit.target"];
    after = ["local-fs.target"];
    unitConfig = {
      DefaultDependencies = false;
      RequiresMountsFor = ["/nix/store" "/nix/.environment" "/run/drv-run-seed"];
      FailureAction = "poweroff-force";
    };
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      RuntimeDirectory = "drv-run-environment";
      RuntimeDirectoryMode = "0700";
      ExecStart = lib.getExe initialize;
    };
  };
}

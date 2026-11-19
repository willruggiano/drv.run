{
  nixpkgs,
  microvm,
  self,
  ...
}: {
  config,
  lib,
  pkgs,
  ...
}: let
  normalUsers = lib.filter (user: user.enable && user.isNormalUser) (lib.attrValues config.users.users);
  connector = pkgs.drvr.sshx.override {systemd = config.systemd.package;};
  # Share connection data with ordinary SSH, but do not inherit interactive policy.
  serviceSSH = pkgs.writeText "drv.run-service-ssh.conf" ''
    Include ${./ssh.conf}
    Host drv.run.*
        ControlPath none
        User root
        IdentityAgent none
        IdentitiesOnly yes
        IdentityFile none
        CertificateFile none
        BatchMode yes
        PreferredAuthentications publickey
        StrictHostKeyChecking yes
        UserKnownHostsFile /dev/null
        GlobalKnownHostsFile /dev/null
        KnownHostsCommand none
        VerifyHostKeyDNS no
        UpdateHostKeys no
        ForwardAgent no
        ForwardX11 no
        ClearAllForwardings yes
        ControlMaster no
        ControlPersist no
  '';
  features = config.nix.settings.experimental-features or [];
  enabledFeatures =
    if builtins.isString features
    then builtins.filter builtins.isString (builtins.split "[[:space:]]+" features)
    else features;
  guest = nixpkgs.lib.nixosSystem {
    inherit (pkgs.stdenv.hostPlatform) system;
    modules = [self.nixosModules.guest] ++ config.services.drv-run.guest.extraModules;
  };
  createVolumes = (import "${microvm}/lib/volumes.nix" {inherit pkgs;}).createVolumesScript (
    map (volume: volume // {autoCreate = true;}) (lib.filter (volume: !volume.readOnly) guest.config.microvm.volumes)
  );
  # The expression and builder are individual store files, not the drv.run
  # source tree. E enters as data with store context; no user flake is reevaluated.
  imageExpression = pkgs.writeText "drv-run-environment-image.nix" ''
    { environment }:
    let pkgs = import ${nixpkgs} {
      system = ${builtins.toJSON pkgs.stdenv.hostPlatform.system};
      config = {};
      overlays = [];
    };
    in import ${../../nix/mkEnvironmentImage.nix} { inherit pkgs; } {
      environment = builtins.storePath environment;
    }
  '';
  worker = pkgs.writeShellApplication {
    name = "worker";
    runtimeInputs = with pkgs; [
      config.nix.package
      coreutils
      git # we might want to use `programs.git` host-wide instead
      e2fsprogs
      jq
      openssh
    ];
    text =
      lib.replaceStrings
      ["@proxy@" "@runner@" "@create-volumes@" "@image-expression@" "@timing@"]
      [
        "${config.systemd.package}/lib/systemd/systemd-ssh-proxy"
        (toString guest.config.microvm.declaredRunner)
        createVolumes
        (toString imageExpression)
        (builtins.readFile ../timing.sh)
      ]
      (builtins.readFile ./pre.sh);
  };
  coreFiles = pkgs.writeShellApplication {
    name = "drv-run-core-files";
    runtimeInputs = [pkgs.coreutils];
    text = ''
      install -d -m 0755 "$RUNTIME_DIRECTORY/etc" "$RUNTIME_DIRECTORY/etc/ssh"
      install -d -m 0700 "$RUNTIME_DIRECTORY/root" "$RUNTIME_DIRECTORY/root/.ssh"
      install -m 0600 "$STATE_DIRECTORY/host-key" "$RUNTIME_DIRECTORY/etc/ssh/ssh_host_ed25519_key"
      install -m 0600 "$1/id_ed25519.pub" "$RUNTIME_DIRECTORY/root/.ssh/authorized_keys"
      case $(id -u) in
        ${lib.concatMapStringsSep "\n" (user: let
        keys = pkgs.writeText "drv-run-ssh-${user.name}-keys" (lib.concatStringsSep "\n" (
            user.openssh.authorizedKeys.keys ++ map builtins.readFile user.openssh.authorizedKeys.keyFiles
          )
          + "\n");
      in "${toString user.uid}) cat ${keys} >> \"$RUNTIME_DIRECTORY/root/.ssh/authorized_keys\" ;;")
      normalUsers}
      esac
    '';
  };
  # These destinations are not part of the writable root overlay: mounts hide
  # them, or NixOS owns their contents. Do not silently discard producer files.
  reservedPaths = lib.unique (
    [
      "/bin"
      "/boot"
      "/dev"
      "/lib"
      "/lib64"
      "/nix"
      "/proc"
      "/run"
      "/sbin"
      "/sys"
      "/tmp"
      "/usr"
      "/etc/passwd"
      "/etc/shadow"
      "/etc/group"
      "/etc/gshadow"
      "/etc/subuid"
      "/etc/subgid"
      "/etc/static"
      "/etc/.clean"
    ]
    ++ lib.filter (path: path != "/") (builtins.attrNames guest.config.fileSystems)
    ++ map (entry: "/etc/${entry.target}") (lib.filter (entry: entry.enable) (lib.attrValues guest.config.environment.etc))
    ++ map (mount: mount.where) guest.config.systemd.mounts
    ++ map (mount: mount.where) guest.config.systemd.automounts
  );
  assemble = pkgs.writeShellApplication {
    name = "drv-run-image";
    runtimeInputs = [pkgs.coreutils pkgs.jq pkgs.drvr.guest-files];
    text = ''
      timing_directory=$1
      ${builtins.readFile ../timing.sh}
      phase assembly-start
      drv-run-guest-files --inputs "$2" --environment "$STATE_DIRECTORY/environment" \
        --output "$RUNTIME_DIRECTORY/seed.img" ${lib.escapeShellArgs (lib.concatMap (path: ["--reserved-path" path]) reservedPaths)}
      phase preparation-ready
    '';
  };
  provision = pkgs.writeShellApplication {
    name = "provision";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.jq
      pkgs.openssh
    ];
    text = lib.replaceStrings ["@service-ssh@" "@timing@"] [(toString serviceSSH) (builtins.readFile ../timing.sh)] (
      builtins.readFile ./post.sh
    );
  };
  launcher = pkgs.writeShellApplication {
    name = "drv.run";
    runtimeInputs = with pkgs; [coreutils findutils jq openssh config.systemd.package];
    text = lib.replaceStrings ["@timing@" "@connect@"] [
      (builtins.readFile ../timing.sh)
      (lib.getExe connector)
    ] (builtins.readFile ./command.sh);
  };
in {
  imports = [../nix.nix ./network.nix ./mitm-proxy.nix self.nixosModules.pi];

  options.services.drv-run.guest.extraModules = lib.mkOption {
    type = lib.types.listOf lib.types.deferredModule;
    default = [];
    example = lib.literalExpression "[ ./guest.nix ]";
    description = ''
      Additional NixOS modules to include in the guest nixosConfiguration.
    '';
  };

  options.users.users = lib.mkOption {
    type = with lib.types;
      attrsOf (submodule ({config, ...}: {
        config = lib.mkIf (config.enable && config.isNormalUser) {
          extraGroups = ["kvm"];
          linger = true;
        };
      }));
  };

  config = {
    assertions = [
      {
        # systemd 261.2 create_tap() calls userns_get_base_uid(..., &uid, NULL).
        # NULL omits the separate GID output and makes the helper reject unequal
        # Host UID/GID mappings with -EUCLEAN. TAP setup only uses TUNSETOWNER;
        # why it requires equality here is undocumented, not a CH/Linux rule.
        # Matching group names are our convention, not an upstream requirement.
        # https://github.com/systemd/systemd/blob/v261.2/src/nsresourced/nsresourcework.c
        # https://github.com/systemd/systemd/blob/v261.2/src/basic/namespace-util.c
        assertion =
          builtins.length (lib.unique (map (user: user.uid) normalUsers))
          == builtins.length normalUsers
          && lib.all (
            user:
              user.uid
              != null
              && user.uid > 0
              && user.group == user.name
              && (config.users.groups.${user.group}.gid or null) == user.uid
          )
          normalUsers;
        message = "drv.run nsresourced TAPs require each normal owner to have a distinct explicit UID and a private primary group of the same name and numeric GID.";
      }
      {
        assertion = lib.all (user: user.linger == true && builtins.elem "kvm" user.extraGroups) normalUsers;
        message = "drv.run requires lingering and KVM group membership for every enabled normal Host user.";
      }
      {
        assertion = let
          directories = lib.toList config.systemd.user.services."drv.run@".serviceConfig.StateDirectory;
        in
          builtins.length directories
          == 1
          && builtins.head directories == "drv.run/%i";
        message = "drv.run requires StateDirectory = drv.run/%i for durable Instance inventory.";
      }
      {
        assertion = let
          volumes = guest.config.microvm.volumes;
        in
          builtins.length volumes
          == 3
          && lib.count (volume: volume.image == "state.img" && !volume.readOnly && volume.label == "drv-run-state") volumes == 1
          && lib.count (volume: volume.image == "seed.img" && volume.readOnly) volumes == 1
          && lib.count (volume: volume.image == "environment.erofs" && volume.readOnly && !volume.direct) volumes == 1
          && lib.all (volume: !volume.autoCreate) volumes;
        message = "drv.run requires labeled writable state.img, read-only seed.img and cached read-only environment.erofs, with automatic creation disabled.";
      }
      {
        assertion = builtins.elem pkgs.stdenv.hostPlatform.system ["x86_64-linux" "aarch64-linux"];
        message = "drv.run requires an x86_64-linux or aarch64-linux Host with working Cloud Hypervisor KVM support.";
      }
      {
        assertion = config.nix.enable;
        message = "drv.run requires nix.enable.";
      }
      {
        assertion = lib.all (feature: builtins.elem feature enabledFeatures) [
          "nix-command"
          "flakes"
        ];
        message = "drv.run requires nix-command and flakes in nix.settings.experimental-features.";
      }
      {
        assertion = config.nix.settings.sandbox == true;
        message = "drv.run requires nix.settings.sandbox = true.";
      }
    ];

    environment.systemPackages = let
      bench = self.packages.${pkgs.stdenv.hostPlatform.system}.bench.override {
        nix = config.nix.package;
      };
      drvrun = pkgs.writeShellApplication {
        name = "drv.run";
        runtimeInputs = with pkgs; [
          config.systemd.package
          coreutils
          e2fsprogs
          jq
          util-linux
        ];
        text =
          lib.replaceStrings
          ["@launcher@" "@owners@"]
          [(lib.getExe launcher) (lib.escapeShellArgs (map (user: user.name) normalUsers))]
          (builtins.readFile ./cli.sh);
      };
    in [
      bench
      connector
      drvrun
    ];

    programs.ssh.extraConfig = lib.mkBefore (builtins.readFile ./ssh.conf);

    services.openssh = {
      enable = true;
      # Normal accounts are Instance owners; their SSH sessions enter the launcher.
      extraConfig = lib.optionalString (normalUsers != []) ''
        Match User ${lib.concatMapStringsSep "," (user: user.name) normalUsers}
          ForceCommand ${lib.getExe launcher}

        Match all
      '';
    };

    # Preparation owns one private runtime parent; assembly sees only inputs/.
    # Ordered dependencies stop consumers before the parent disappears.
    systemd.user.services."drv.run-prepare@" = {
      description = "Prepare drv.run instance %i";
      partOf = ["drv.run@%i.service"];
      unitConfig.StopWhenUnneeded = true;
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        StateDirectory = "drv.run/%i";
        StateDirectoryMode = "0700";
        RuntimeDirectory = "drv.run/%i";
        RuntimeDirectoryMode = "0700";
        RuntimeDirectoryPreserve = "no";
        UMask = "0077";
        TimeoutStartSec = "infinity";
        ExecStart = lib.getExe worker;
      };
    };
    systemd.user.services."drv.run-core@" = {
      description = "Prepare core guest files for drv.run instance %i";
      requires = ["drv.run-prepare@%i.service"];
      after = ["drv.run-prepare@%i.service"];
      partOf = ["drv.run@%i.service"];
      unitConfig.StopWhenUnneeded = true;
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        StateDirectory = "drv.run/%i";
        StateDirectoryMode = "0700";
        RuntimeDirectory = "drv.run/%i/inputs/core";
        RuntimeDirectoryMode = "0700";
        UMask = "0077";
        ExecStart = "${lib.getExe coreFiles} %t/drv.run/%i";
      };
    };
    systemd.user.services."drv.run-image@" = {
      description = "Assemble guest files for drv.run instance %i";
      requires = ["drv.run-core@%i.service"];
      after = ["drv.run-core@%i.service"];
      partOf = ["drv.run@%i.service"];
      unitConfig.StopWhenUnneeded = true;
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        StateDirectory = "drv.run/%i";
        StateDirectoryMode = "0700";
        RuntimeDirectory = "drv.run/%i/image";
        RuntimeDirectoryMode = "0700";
        UMask = "0077";
        TimeoutStartSec = "infinity";
        ExecStart = "${lib.getExe assemble} %t/drv.run/%i %t/drv.run/%i/inputs";
      };
    };
    systemd.user.services."drv.run@" = {
      description = "drv.run instance %i";
      requires = ["drv.run-image@%i.service"];
      after = ["drv.run-image@%i.service"];
      # Preparation manages this directory's lifetime; the instance only uses it.
      environment.RUNTIME_DIRECTORY = "%t/drv.run/%i";
      serviceConfig = {
        StateDirectory = "drv.run/%i";
        StateDirectoryMode = "0700";
        ExecStart = "${lib.getExe pkgs.drvr.tap} %S/drv.run/%i/runner/bin/microvm-run";
        ExecStartPost = lib.getExe provision;
        ExecStop = "%S/drv.run/%i/runner/bin/microvm-shutdown";
        KillMode = "control-group";
        CPUAccounting = true;
        IOAccounting = true;
        Restart = "no";
        StandardError = "journal";
        StandardOutput = "journal";
        TimeoutStartSec = "infinity";
        TimeoutStopSec = 30;
        Type = "notify";
        NotifyAccess = "all";
        UMask = "0077";
        WorkingDirectory = "%t/drv.run/%i";
      };
    };
  };
}

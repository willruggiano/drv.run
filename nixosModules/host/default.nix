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
  # Include must precede fallbacks: OpenSSH uses the first obtained value.
  # IdentityFile is additive; 'none' suppresses default identity discovery.
  clientPolicy = ''
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
    ControlPath none
    ControlPersist no
  '';
  serviceSSH = pkgs.writeText "drv.run-service-ssh.conf" ''
    Host drv.run.*
        Include /run/user/%i/%n/service-connection.conf
        ProxyCommand false
        # Only provisioning uses this private control socket.
        ControlPath /run/user/%i/%n/provision-ssh
        ${clientPolicy}
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
      ["@proxy@" "@runner@" "@create-volumes@" "@mitm-proxy-seed@" "@image-expression@" "@timing@" "@notification-seed@" "@owner-keys@"]
      [
        "${config.systemd.package}/lib/systemd/systemd-ssh-proxy"
        (toString guest.config.microvm.declaredRunner)
        createVolumes
        (lib.optionalString (config.services.drv-run.mitm-proxy.owners != {}) ''
          case $(id -un) in
            ${lib.concatStringsSep "|" (builtins.attrNames config.services.drv-run.mitm-proxy.owners)})
              install -d -m 0700 "$staging/mitm-proxy" "$staging/mitm-proxy/gh"
              install -m 0600 "/run/mitm-proxy/$(id -un)/"{config,hosts}.yml "$staging/mitm-proxy/gh/"
              ;;
          esac
        '')
        (toString imageExpression)
        (builtins.readFile ../timing.sh)
        (lib.optionalString config.services.drv-run.notifications.enable ''
          if [[ $(id -un) == ${lib.escapeShellArg config.services.pi.user} ]]; then
            cat /proc/sys/kernel/random/uuid > "$RUNTIME_DIRECTORY/notification-incarnation"
            cp "$RUNTIME_DIRECTORY/notification-incarnation" "$staging/notification-incarnation"
          fi
        '')
        (lib.optionalString (config.services.drv-run.ssh.owners != {}) ''
          case $(id -u) in
            ${lib.concatStringsSep "\n" (lib.mapAttrsToList (name: _: let
            user = config.users.users.${name};
            keys = pkgs.writeText "drv-run-ssh-${name}-keys" (lib.concatStringsSep "\n" (
                user.openssh.authorizedKeys.keys ++ map builtins.readFile user.openssh.authorizedKeys.keyFiles
              )
              + "\n");
          in ''${toString user.uid}) cat ${keys} >> "$RUNTIME_DIRECTORY/authorized-keys" ;;'')
          config.services.drv-run.ssh.owners)}
          esac
        '')
      ]
      (builtins.readFile ./pre.sh);
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
  tap = import ./tap.nix {inherit pkgs;};
  launcher = pkgs.writeShellApplication {
    name = "drv.run";
    runtimeInputs = with pkgs; [coreutils jq openssh systemd];
    text = lib.replaceStrings ["@timing@"] [(builtins.readFile ../timing.sh)] (builtins.readFile ./command.sh);
  };
in {
  imports = [../nix.nix ./network.nix ./mitm-proxy.nix ./ssh.nix self.nixosModules.pi];

  options.services.drv-run.notifications.enable = lib.mkEnableOption "instance-bound guest D-Bus notifications for services.pi.user";

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
    services.drv-run.guest.extraModules = lib.mkIf config.services.drv-run.notifications.enable [
      {
        services.drv-run.notifications.enable = true;
        services.drv-run.notifications.active = lib.mkDefault config.services.pi.notifications.limits.records;
      }
    ];
    services.pi.notifications.guests = lib.mkIf config.services.drv-run.notifications.enable {
      enable = true;
      sshConfigFile = toString serviceSSH;
    };
    assertions = [
      {
        assertion = !config.services.drv-run.notifications.enable || (config.services.pi.enable && config.services.pi.notifications.enable);
        message = "Guest notifications require services.pi.enable and services.pi.notifications.enable; services.pi.user selects their owner.";
      }
      {
        assertion = !config.services.drv-run.notifications.enable || (guest.config.services.drv-run.notifications.enable && guest.config.services.drv-run.notifications.active <= config.services.pi.notifications.limits.records);
        message = "Guest notifications must be enabled in the guest closure and fit the host's active-record quota.";
      }
      {
        # systemd 261.2 create_tap() calls userns_get_base_uid(..., &uid, NULL).
        # NULL omits the separate GID output and makes the helper reject unequal
        # Host UID/GID mappings with -EUCLEAN. TAP setup only uses TUNSETOWNER;
        # why it requires equality here is undocumented, not a CH/Linux rule.
        # Matching group names are our convention, not an upstream requirement.
        # https://github.com/systemd/systemd/blob/v261.2/src/nsresourced/nsresourcework.c
        # https://github.com/systemd/systemd/blob/v261.2/src/basic/namespace-util.c
        assertion =
          lib.all (
            user:
              user.uid
              != null
              && user.uid > 0
              && user.group == user.name
              && (config.users.groups.${user.group}.gid or null) == user.uid
          )
          normalUsers;
        message = "drv.run nsresourced TAPs require each normal owner to have an explicit UID and a private primary group of the same name and numeric GID.";
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
      drvrun
    ];

    programs.ssh.extraConfig = lib.mkBefore ''
      Host drv.run.*
          Include /run/user/%i/%n/client.conf
          ProxyCommand false
          RequestTTY yes
          ${clientPolicy}
      Host *
    '';

    services.openssh = {
      enable = true;
      # Normal accounts are Instance owners; their SSH sessions enter the launcher.
      extraConfig = lib.optionalString (normalUsers != []) ''
        Match User ${lib.concatMapStringsSep "," (user: user.name) normalUsers}
          AuthenticationMethods publickey
          DisableForwarding yes
          ForceCommand ${lib.getExe launcher}
          PermitTTY yes
          PermitUserRC no

        Match all
      '';
    };

    systemd.user.services."drv.run@" = {
      description = "drv.run instance %i";
      serviceConfig = {
        StateDirectory = "drv.run/%i";
        StateDirectoryMode = "0700";
        ExecStartPre = lib.getExe worker;
        ExecStart = "${tap}/bin/drv-run-tap %S/drv.run/%i/runner/bin/microvm-run";
        ExecStartPost = lib.getExe provision;
        ExecStop = "%S/drv.run/%i/runner/bin/microvm-shutdown";
        ExecStopPost = "${lib.getExe' pkgs.coreutils "rm"} -f %t/drv.run.%i/client.conf";
        KillMode = "control-group";
        CPUAccounting = true;
        IOAccounting = true;
        Restart = "no";
        RuntimeDirectory = "drv.run.%i";
        RuntimeDirectoryMode = "0700";
        RuntimeDirectoryPreserve = "no";
        StandardError = "journal";
        StandardOutput = "journal";
        TimeoutStartSec = "infinity";
        TimeoutStopSec = 30;
        Type = "notify";
        NotifyAccess = "all";
        UMask = "0077";
        WorkingDirectory = "%t/drv.run.%i";
      };
    };
  };
}

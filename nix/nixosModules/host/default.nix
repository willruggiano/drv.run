# drv.run / nixosModules / host
# -----------------------------------
# Importing this module into a nixosConfiguration enables the minimum set of
# functionality required to operate a drv.run host. A drv.run host is
# responsible for (1) client ssh authentication, and (2) microvm lifecycle.
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
  serviceSSH = pkgs.writeText "drvrun-service-ssh.conf" ''
    Host drv.run.*
        Include /run/user/%i/%n/service-connection.conf
        ProxyCommand false
        ${clientPolicy}
  '';
  features = config.nix.settings.experimental-features or [];
  enabledFeatures =
    if builtins.isString features
    then builtins.filter builtins.isString (builtins.split "[[:space:]]+" features)
    else features;
  guest = nixpkgs.lib.nixosSystem {
    inherit (pkgs.stdenv.hostPlatform) system;
    modules = [
      self.nixosModules.guest
      {
        # TODO: Seems we should put more here (eg. authorized keys). See
        # comments in guest.nix for more detail.
        nix.settings = {
          inherit (config.nix.settings) substituters trusted-public-keys;
        };
      }
    ];
  };
  createVolumes = (import "${microvm}/lib/volumes.nix" {inherit pkgs;}).createVolumesScript (
    map (volume: volume // {autoCreate = true;}) guest.config.microvm.volumes
  );
  worker = pkgs.writeShellApplication {
    name = "worker";
    runtimeInputs = [
      pkgs.coreutils
      config.nix.package
      pkgs.openssh
    ];
    text =
      lib.replaceStrings
      ["@nc@" "@runner@" "@create-volumes@"]
      [(lib.getExe' pkgs.netcat-openbsd "nc") (toString guest.config.microvm.declaredRunner) createVolumes]
      (builtins.readFile ./worker.sh);
  };
  provision = pkgs.writeShellApplication {
    name = "provision";
    runtimeInputs = [
      pkgs.coreutils
      config.nix.package
      pkgs.openssh
    ];
    text = lib.replaceStrings ["@service-ssh@"] [(toString serviceSSH)] (
      builtins.readFile ./provision.sh
    );
  };
  launcher = pkgs.writeShellApplication {
    name = "drv.run";
    runtimeInputs = with pkgs; [coreutils openssh systemd];
    text =
      builtins.readFile ./launch.sh;
  };
in {
  assertions = [
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
        == 1
        && (builtins.head volumes).image == "state.img"
        && !(builtins.head volumes).autoCreate;
      message = "drv.run requires one state.img volume with automatic creation disabled.";
    }
    {
      assertion = pkgs.stdenv.hostPlatform.system == "x86_64-linux";
      message = "drv.run requires an x86_64-linux host.";
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

  users.groups.drvrun = {};
  users.users.drvrun = {
    extraGroups = ["drvrun" "kvm"];
    home = "/var/lib/drv.run";
    isNormalUser = true;
    linger = true;
  };

  programs.ssh.extraConfig = lib.mkBefore ''
    Host drv.run.*
        Include /run/user/%i/%n/client.conf
        ProxyCommand false
        ${clientPolicy}
    Host *
  '';

  # FIXME: this is exposed solely for nix/nixosTests/host-basic.nix right now
  environment.systemPackages = [launcher];
  services.openssh = {
    enable = true;
    extraConfig = ''
      Match User drvrun Address *,!127.0.0.0/8,!::1
        DenyUsers drvrun

      Match User drvrun
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
      ExecStart = "%S/drv.run/%i/runner/bin/microvm-run";
      ExecStartPost = lib.getExe provision;
      ExecStartPre = lib.getExe worker;
      ExecStop = "%S/drv.run/%i/runner/bin/microvm-shutdown";
      ExecStopPost = "${pkgs.coreutils}/bin/rm -f %t/drv.run.%i/client.conf";
      KillMode = "control-group";
      Restart = "no";
      RuntimeDirectory = "drv.run.%i";
      RuntimeDirectoryMode = "0700";
      RuntimeDirectoryPreserve = "no";
      StandardError = "journal";
      StandardOutput = "journal";
      TimeoutStartSec = "infinity";
      TimeoutStopSec = 30;
      Type = "exec";
      UMask = "0077";
      WorkingDirectory = "%t/drv.run.%i";
    };
  };
}

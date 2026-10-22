{
  config,
  lib,
  pkgs,
  utils,
  ...
}: let
  cfg = config.services.drv-run.mitm-proxy;
  enabled = cfg.owners != {};
  package = pkgs.callPackage ../../packages/mitm-proxy {};
  ownerArgs = lib.concatMap (name: ["--owner" "${name}:${toString config.users.groups.${config.users.users.${name}.group}.gid}"]) (builtins.attrNames cfg.owners);
  command = operation:
    utils.escapeSystemdExecArgs (["${package}/bin/mitm-proxy" operation "--port" (toString cfg.port)] ++ ownerArgs);
in {
  options.services.drv-run.mitm-proxy = {
    port = lib.mkOption {
      type = lib.types.port;
      default = 3128;
      description = "Host listener for the guest credential proxy.";
    };
    owners = lib.mkOption {
      default = {};
      description = "Host owners granted proxy access. Instances of an owner share a credential capability.";
      type = lib.types.attrsOf (lib.types.submodule {
        options.tokenFile = lib.mkOption {
          type = lib.types.str;
          description = "Absolute runtime path to a GitHub token. Never a Nix store path. Read at proxy startup.";
        };
      });
    };
  };

  config = lib.mkIf enabled {
    assertions =
      lib.mapAttrsToList (name: owner: {
        assertion = let
          user = config.users.users.${name} or null;
        in
          user
          != null
          && user.enable
          && user.isNormalUser
          && user.uid != null
          && user.uid > 0
          && builtins.match "[A-Za-z_][A-Za-z0-9_.-]*" name != null
          && lib.hasPrefix "/" owner.tokenFile
          && !(lib.hasPrefix "/nix/store/" owner.tokenFile)
          && !(lib.hasInfix ":" owner.tokenFile)
          && !(lib.hasInfix "\n" owner.tokenFile);
        message = "mitm-proxy owners must be enabled normal Host users with runtime token files outside the Nix store.";
      })
      cfg.owners;

    users.users.mitm-proxy = {
      isSystemUser = true;
      group = "mitm-proxy";
    };
    users.groups.mitm-proxy = {};
    systemd.services.mitm-proxy = {
      description = "drv.run credential proxy";
      wantedBy = ["multi-user.target"];
      after = ["network-online.target" "nftables.service" "systemd-tmpfiles-setup.service"];
      wants = ["network-online.target"];
      requires = ["nftables.service"];
      environment = {
        NIX_SSL_CERT_FILE = "/etc/ssl/certs/ca-certificates.crt";
        STATE_DIRECTORY = "/var/lib/mitm-proxy";
      };
      serviceConfig = {
        Type = "exec";
        User = "mitm-proxy";
        Group = "mitm-proxy";
        # Root publishes each capability to its owner's private group. The
        # long-running proxy has neither root privileges nor group membership.
        ExecStartPre = "+${command "prepare"}";
        ExecStart = command "serve";
        LoadCredential = lib.mapAttrsToList (name: owner: "token-${name}:${owner.tokenFile}") cfg.owners;
        Restart = "on-failure";
        RestartSec = 2;
        UMask = "0077";
        LimitCORE = 0;
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        RestrictAddressFamilies = ["AF_UNIX" "AF_INET" "AF_INET6"];
      };
    };
    # StateDirectory= would chown these files to the service user before every
    # Exec command. Privileged preparation must only consume root-owned state.
    systemd.tmpfiles.rules = [
      "d /var/lib/mitm-proxy 0750 root mitm-proxy -"
      "d /run/mitm-proxy 0755 root root -"
    ];
    services.drv-run.guest.extraModules = [(import ../guest/mitm-proxy.nix {inherit (cfg) port;})];
  };
}

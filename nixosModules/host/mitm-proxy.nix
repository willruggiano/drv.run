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
  settings = pkgs.writeText "mitm-proxy.json" (builtins.toJSON {
    inherit (cfg) port clientId caCertificate caPrivateKeyFile;
    owners =
      lib.mapAttrs (name: owner: {
        inherit (owner) githubUserId;
        gid = config.users.groups.${config.users.users.${name}.group}.gid;
      })
      cfg.owners;
  });
  commandArgs = operation: ["${package}/bin/mitm-proxy" operation "--config" (toString settings)];
  command = operation: utils.escapeSystemdExecArgs (commandArgs operation);
in {
  options.services.drv-run.mitm-proxy = {
    port = lib.mkOption {
      type = lib.types.port;
      default = 3128;
      description = "Host listener for the guest credential proxy.";
    };
    # This is dumb! What if we want another such client that isn't github?
    clientId = lib.mkOption {
      type = lib.types.str;
      default = "Iv23liZlNYpFfQGoQv57";
      description = "GitHub App client ID, with device flow and expiring user tokens enabled.";
    };
    caCertificate = lib.mkOption {
      type = lib.types.lines;
      default = "";
      description = "Public proxy CA certificate in PEM format, added to the guest trust store.";
    };
    caPrivateKeyFile = lib.mkOption {
      type = lib.types.str;
      default = "";
      description = "Absolute runtime path to the CA private key. Provision it before the mitm-proxy activation script; never put the key in the Nix store.";
    };
    owners = lib.mkOption {
      default = {};
      description = "Host owners granted proxy access. Instances of an owner share a credential capability.";
      type = lib.types.attrsOf (lib.types.submodule {
        options.githubUserId = lib.mkOption {
          type = lib.types.ints.positive;
          description = "Expected numeric GitHub user ID, verified during device authorization.";
        };
      });
    };
  };

  config = lib.mkIf enabled {
    assertions =
      lib.mapAttrsToList (name: _: {
        assertion = let
          user = config.users.users.${name} or null;
          group = config.users.groups.${user.group or ""} or null;
        in
          user
          != null
          && user.enable
          && user.isNormalUser
          && user.uid != null
          && user.uid > 0
          && group != null
          && group.gid != null
          && group.gid > 0
          && builtins.match "[A-Za-z_][A-Za-z0-9_.-]*" name != null;
        message = "mitm-proxy owners must be enabled normal Host users.";
      })
      cfg.owners
      ++ [
        {
          assertion = builtins.match "[A-Za-z0-9_.-]+" cfg.clientId != null;
          message = "mitm-proxy requires a GitHub App clientId.";
        }
        {
          assertion = lib.hasInfix "-----BEGIN CERTIFICATE-----" cfg.caCertificate && !(lib.hasInfix "PRIVATE KEY" cfg.caCertificate);
          message = "mitm-proxy requires a public PEM caCertificate, without a private key.";
        }
        {
          assertion = lib.hasPrefix "/" cfg.caPrivateKeyFile && !(lib.hasPrefix "/nix/store/" cfg.caPrivateKeyFile);
          message = "mitm-proxy requires a runtime caPrivateKeyFile outside the Nix store.";
        }
      ];

    environment.systemPackages = [package];
    environment.etc."mitm-proxy.json".source = settings;

    users.users.mitm-proxy = {
      isSystemUser = true;
      group = "mitm-proxy";
    };
    users.groups.mitm-proxy = {};
    # switch-to-configuration restarts user services before starting new system
    # services. Publish guest seed files before those user-service restarts.
    system.activationScripts.mitm-proxy = {
      deps = ["users" "groups"];
      text = ''
        (
          umask 0077
          ${lib.escapeShellArgs (commandArgs "prepare")}
        )
      '';
    };
    systemd.sockets = lib.mapAttrs' (name: _:
      lib.nameValuePair "mitm-proxy-auth-${name}" {
        wantedBy = ["sockets.target"];
        socketConfig = {
          ListenStream = "/run/mitm-proxy-auth/${name}.sock";
          SocketUser = name;
          SocketMode = "0600";
          DirectoryMode = "0755";
          FileDescriptorName = name;
          Service = "mitm-proxy.service";
          RemoveOnStop = true;
        };
      })
    cfg.owners;
    systemd.services.mitm-proxy = {
      description = "drv.run credential proxy";
      wantedBy = ["multi-user.target"];
      after = ["network-online.target" "nftables.service" "systemd-tmpfiles-setup.service"];
      wants = ["network-online.target"];
      requires = ["nftables.service"];
      environment = {
        NIX_SSL_CERT_FILE = "/etc/ssl/certs/ca-certificates.crt";
        SSL_CERT_FILE = "/etc/ssl/certs/ca-certificates.crt";
      };
      serviceConfig = {
        Type = "exec";
        Sockets = map (name: "mitm-proxy-auth-${name}.socket") (builtins.attrNames cfg.owners);
        User = "mitm-proxy";
        Group = "mitm-proxy";
        # Root publishes each capability to its owner's private group. The
        # long-running proxy has neither root privileges nor group membership.
        ExecStartPre = "+${command "prepare"}";
        ExecStart = command "serve";
        StateDirectory = "mitm-proxy-auth";
        StateDirectoryMode = "0700";
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
      "d /run/mitm-proxy-ca 0750 root mitm-proxy -"
      "d /var/lib/mitm-proxy-auth 0700 mitm-proxy mitm-proxy -"
    ];
    services.drv-run.guest.extraModules = [
      (import ../guest/mitm-proxy.nix {inherit (cfg) port;})
      {security.pki.certificates = [cfg.caCertificate];}
    ];
  };
}

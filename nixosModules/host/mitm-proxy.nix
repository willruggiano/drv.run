{
  config,
  lib,
  pkgs,
  utils,
  ...
}: let
  cfg = config.services.drv-run.mitm-proxy;
  package = pkgs.callPackage ../../packages/mitm-proxy {};
  settings = pkgs.writeText "mitm-proxy.json" (builtins.toJSON {
    inherit (cfg) port clientId caCertificate caPrivateKeyFile;
  });
  command = operation: utils.escapeSystemdExecArgs ["${package}/bin/mitm-proxy" operation "--config" (toString settings)];
in {
  options.services.drv-run.mitm-proxy = {
    enable = lib.mkEnableOption "the guest credential proxy (access through the mitm-proxy-access group)";
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
      description = "Absolute runtime path to the CA private key. Provision it before starting mitm-proxy; never put the key in the Nix store.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
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

    systemd.user.services = {
      "drv.run-mitm-files@" = {
        description = "Snapshot the owner's guest GitHub capability";
        requires = ["drv.run-prepare@%i.service"];
        after = ["drv.run-prepare@%i.service"];
        partOf = ["drv.run@%i.service"];
        unitConfig = {
          StopWhenUnneeded = true;
          ConditionGroup = "mitm-proxy-access";
        };
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
          # Budget includes cold socket activation, not only the HTTP response.
          TimeoutStartSec = "3min";
          RuntimeDirectory = "drv.run/%i/inputs/mitm";
          RuntimeDirectoryMode = "0700";
          UMask = "0077";
          ExecStart = lib.getExe (pkgs.writeShellApplication {
            name = "drv-run-mitm-files";
            runtimeInputs = [pkgs.coreutils pkgs.curl];
            text = ''
              install -d -m 0700 "$RUNTIME_DIRECTORY/root" "$RUNTIME_DIRECTORY/root/.config" "$RUNTIME_DIRECTORY/root/.config/gh"
              # Socket activation starts the independent shared service if needed.
              # Peer credentials select the owner; no request field selects one.
              curl --fail --silent --show-error \
                --unix-socket /run/mitm-proxy-auth/control.sock \
                http://localhost/hosts.yml \
                --output "$RUNTIME_DIRECTORY/root/.config/gh/hosts.yml"
            '';
          });
        };
      };
      "drv.run-image@" = {
        requires = ["drv.run-mitm-files@%i.service"];
        after = ["drv.run-mitm-files@%i.service"];
      };
    };

    environment.systemPackages = [package];
    environment.etc."mitm-proxy.json".source = settings;
    users.users.mitm-proxy = {
      isSystemUser = true;
      group = "mitm-proxy";
    };
    users.groups = {
      mitm-proxy = {};
      # This group can use the service, not read its upstream credentials or CA key.
      mitm-proxy-access = {};
    };
    systemd.sockets.mitm-proxy-auth = {
      wantedBy = ["sockets.target"];
      socketConfig = {
        ListenStream = "/run/mitm-proxy-auth/control.sock";
        SocketGroup = "mitm-proxy-access";
        SocketMode = "0660";
        DirectoryMode = "0755";
        FileDescriptorName = "control";
        Service = "mitm-proxy.service";
        RemoveOnStop = true;
      };
    };
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
        Sockets = ["mitm-proxy-auth.socket"];
        User = "mitm-proxy";
        Group = "mitm-proxy";
        # Only CA preparation needs privilege. It never consumes service-owned state.
        ExecStartPre = "+${command "prepare"}";
        ExecStart = command "serve";
        StateDirectory = ["mitm-proxy" "mitm-proxy-auth"];
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
    systemd.tmpfiles.rules = [
      "d /run/mitm-proxy-ca 0750 root mitm-proxy -"
    ];
    services.drv-run.guest.extraModules = [
      (import ../guest/mitm-proxy.nix {inherit (cfg) port;})
      {security.pki.certificates = [cfg.caCertificate];}
    ];
  };
}

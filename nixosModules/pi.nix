{self, ...}: {
  config,
  lib,
  pkgs,
  utils,
  ...
}: let
  cfg = config.services.pi;
  packages = self.packages.${pkgs.stdenv.hostPlatform.system};
  user = config.users.users.${cfg.user};
  notifications = cfg.notifications;
  notificationConfig = pkgs.writeText "drv-run-notifications.json" (builtins.toJSON {
    activity = notifications.limits;
    guests =
      if notifications.guests.enable
      then {
        inherit (notifications.guests) sshConfigFile scanIntervalMs maxInstances eventsPerSecond;
        runtimeDirectory = "/run/user/${toString user.uid}";
      }
      else null;
    push =
      if notifications.push.enable
      then {
        inherit (notifications.push) origins subject privateKeyFile;
      }
      else null;
  });
in {
  # The host imports this module; explicit standalone imports must deduplicate.
  key = toString ./pi.nix;
  options.services.pi = with lib;
  with types; {
    enable = mkEnableOption "pi-durable web frontend";
    package = mkOption {
      type = types.package;
      default = packages.app;
    };
    host = mkOption {
      type = str;
      default = "127.0.0.1";
    };
    port = mkOption {
      type = int;
      default = 8080;
    };
    user = mkOption {
      type = str;
      description = "Normal user to run the web server on behalf of";
    };
    notifications = {
      enable = mkEnableOption "owner-scoped activity inbox and notification delivery";
      limits = {
        records = mkOption {
          type = ints.between 64 256;
          default = 256;
        };
        sources = mkOption {
          type = ints.between 1 100000;
          default = 1024;
        };
        history = mkOption {
          type = ints.between 1 1000000;
          default = 10000;
        };
        retentionDays = mkOption {
          type = ints.between 1 3650;
          default = 30;
        };
        burst = mkOption {
          type = ints.between 1 1000;
          default = 10;
        };
        intervalMs = mkOption {
          type = ints.between 1000 86400000;
          default = 60000;
        };
      };
      guests = {
        enable = mkEnableOption "instance-bound SSH notification collection";
        sshConfigFile = mkOption {
          type = str;
          default = "";
          description = "Private management SSH configuration supplied by services.drv-run.notifications.";
        };
        scanIntervalMs = mkOption {
          type = ints.between 100 60000;
          default = 1000;
        };
        maxInstances = mkOption {
          type = ints.between 1 64;
          default = 16;
        };
        eventsPerSecond = mkOption {
          type = ints.between 1 1000;
          default = 50;
        };
      };
      push = {
        enable = mkEnableOption "Web Push delivery";
        origins = mkOption {
          type = listOf str;
          default = [];
          description = "Exact HTTPS push-service origins, including non-default ports. DNS is also checked at delivery time.";
        };
        subject = mkOption {
          type = str;
          default = "";
          description = "Operator mailto: or HTTPS contact URI for VAPID.";
        };
        privateKeyFile = mkOption {
          type = str;
          default = "";
          description = "Runtime path to a P-256 private JWK, normally config.sops.secrets.<name>.path. Provision it readable only by services.pi.user; never use a Nix path or inline secret.";
        };
      };
    };
    env = mkOption {
      type = attrs;
      default = {};
      description = "Environment variables visible to pi";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = user.enable && user.isNormalUser && user.uid != 0;
        message = "services.pi.user must name an enabled isNormalUser, not root.";
      }
      {
        assertion = user.linger;
        message = "services.pi requires user.linger.";
      }
      {
        assertion = !notifications.guests.enable || (notifications.enable && user.uid != null && lib.hasPrefix "/" notifications.guests.sshConfigFile);
        message = "Guest notification collection requires an explicit owner UID, notifications.enable and a management SSH configuration.";
      }
      {
        assertion =
          !notifications.push.enable
          || (notifications.enable
            && notifications.push.origins != []
            && lib.hasPrefix "/" notifications.push.privateKeyFile
            && !(lib.hasPrefix "/nix/store/" notifications.push.privateKeyFile)
            && (lib.hasPrefix "mailto:" notifications.push.subject || lib.hasPrefix "https://" notifications.push.subject));
        message = "Web Push requires notifications.enable, explicit origins, a VAPID contact and a runtime privateKeyFile (use a sops secret owned by services.pi.user).";
      }
    ];

    systemd.user.services.pi = {
      description = "pi server";
      wantedBy = ["default.target"];
      unitConfig.ConditionUser = cfg.user;
      environment =
        lib.attrsets.unionOfDisjoint
        ({
            HOST = cfg.host;
            PORT = toString cfg.port;
          }
          // lib.optionalAttrs notifications.enable {
            NOTIFICATIONS_CONFIG = toString notificationConfig;
          })
        cfg.env;
      serviceConfig = {
        Type = "exec";
        ExecStart = utils.escapeSystemdExecArgs [(lib.getExe cfg.package)];
        WorkingDirectory = "%h";
        UMask = "0077";
        TimeoutStopSec = 20;
        Restart = "on-failure";
        RestartSec = 5;
      };
    };

    users.users.${cfg.user}.linger = true;
  };
}

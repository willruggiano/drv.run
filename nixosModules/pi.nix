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
in {
  options.services.pi = {
    enable = lib.mkEnableOption "pi-durable web frontend";
    package = lib.mkOption {
      type = lib.types.package;
      default = packages.app;
    };
    user = lib.mkOption {
      type = lib.types.str;
      description = "Normal user to run the web server on behalf of";
    };
    host = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = "Serve pi on this interface";
    };
    origin = lib.mkOption {
      type = lib.types.nullOr lib.types.nonEmptyStr;
      default = null;
      description = "Canonical external HTTPS origin behind a Host-preserving reverse proxy. Requires loopback binding.";
    };
    parallelApiKeyFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Host-only Parallel API key file, readable by the pi user. Never a Nix store path.";
    };
    port = lib.mkOption {
      type = lib.types.port;
      default = 8080;
      description = "Serve pi on this port";
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
        assertion = cfg.origin == null || builtins.elem cfg.host ["127.0.0.1" "::1"];
        message = "services.pi.origin requires a loopback services.pi.host.";
      }
      {
        assertion = cfg.origin == null || builtins.match "https://[^/?#@[:space:]]+" cfg.origin != null;
        message = "services.pi.origin must be an HTTPS origin without credentials, path, query or fragment.";
      }
    ];

    systemd.user.services.pi = {
      description = "pi server";
      wantedBy = ["default.target"];
      unitConfig.ConditionUser = cfg.user;
      environment =
        {
          HOST = cfg.host;
          PORT = toString cfg.port;
        }
        // lib.optionalAttrs (cfg.origin != null) {
          ORIGIN = cfg.origin;
        }
        // lib.optionalAttrs (cfg.parallelApiKeyFile != null) {
          PARALLEL_API_KEY_FILE = cfg.parallelApiKeyFile;
        };
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

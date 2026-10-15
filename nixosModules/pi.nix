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
      default = packages.pi-serve;
    };
    user = lib.mkOption {
      type = lib.types.str;
      description = "Normal user to run the web server on behalf of";
    };
    host = lib.mkOption {
      type = lib.types.str;
      default = "0.0.0.0";
      description = "Serve pi on this interface";
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
    ];

    systemd.user.services.pi = {
      description = "pi server";
      wantedBy = ["default.target"];
      unitConfig.ConditionUser = cfg.user;
      serviceConfig = {
        Type = "exec";
        ExecStart = utils.escapeSystemdExecArgs [
          (lib.getExe cfg.package)
          "--host"
          cfg.host
          "--port"
          cfg.port
        ];
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

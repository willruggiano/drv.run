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
  options.services.pi = with lib;
  with types; {
    enable = mkEnableOption "pi-durable web frontend";
    package = mkOption {
      type = types.package;
      default = packages.app;
    };
    user = mkOption {
      type = str;
      description = "Normal user to run the web server on behalf of";
    };
    env = mkOption {
      type = attrs;
      default = null;
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
    ];

    systemd.user.services.pi = {
      description = "pi server";
      wantedBy = ["default.target"];
      unitConfig.ConditionUser = cfg.user;
      environment = cfg.env;
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

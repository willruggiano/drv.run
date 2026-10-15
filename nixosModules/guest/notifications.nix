{
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.services.drv-run.notifications;
  policy = pkgs.writeText "drv-run-guest-notifications.json" (builtins.toJSON {
    database = "/root/.local/state/drv-run-notifications/outbox.sqlite";
    socket = "/run/user/0/drv-run-notifications/events.sock";
    incarnationFile = "/run/drv-run-seed/notification-incarnation";
    policy = {inherit (cfg) queue active defaultTimeoutMs;};
  });
in {
  options.services.drv-run.notifications = {
    enable = lib.mkEnableOption "guest root-user D-Bus notification forwarding";
    queue = lib.mkOption {
      type = lib.types.ints.between 6 100000;
      default = 4096;
      description = "Maximum queued lifecycle operations. New requests fail when reserved close/retire capacity would be consumed.";
    };
    active = lib.mkOption {
      type = lib.types.ints.between 1 256;
      default = 256;
    };
    defaultTimeoutMs = lib.mkOption {
      type = lib.types.ints.between 0 2147483647;
      default = 5000;
      description = "Expiry for requests specifying -1. Zero disables automatic expiry.";
    };
  };
  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.queue >= cfg.active * 2 + 4;
        message = "The guest notification queue must reserve capacity for closure and server retirement.";
      }
    ];
    services.dbus.enable = true;
    users.users.root.linger = true;
    systemd.user.settings.Manager.DefaultEnvironment = "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/0/bus";
    environment.sessionVariables.DBUS_SESSION_BUS_ADDRESS = "unix:path=/run/user/0/bus";
    environment.persistence."/persist".users.root.directories = [
      {
        directory = ".local/state/drv-run-notifications";
        mode = "0700";
      }
    ];
    environment.systemPackages = [
      pkgs.libnotify
      (pkgs.writeShellScriptBin "notifications-stream" ''
        exec ${pkgs.app}/bin/notify-stream /run/user/0/drv-run-notifications/events.sock
      '')
    ];
    systemd.user.services.drv-run-notifications = {
      description = "drv.run guest notification server";
      wantedBy = ["default.target"];
      requires = ["dbus.socket"];
      after = ["dbus.socket"];
      unitConfig = {
        ConditionUser = "root";
        ConditionPathExists = "/run/drv-run-seed/notification-incarnation";
      };
      environment.DBUS_SESSION_BUS_ADDRESS = "unix:path=/run/user/0/bus";
      serviceConfig = {
        Type = "notify";
        NotifyAccess = "all";
        ExecStart = "${pkgs.app}/bin/notify-guest ${policy}";
        RuntimeDirectory = "drv-run-notifications";
        RuntimeDirectoryMode = "0700";
        UMask = "0077";
        Restart = "on-failure";
        RestartSec = 1;
        TimeoutStopSec = 10;
        MemoryMax = "256M";
        TasksMax = 32;
        NoNewPrivileges = true;
      };
    };
  };
}

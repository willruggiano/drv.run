{
  pkgs,
  nixpkgs,
  module,
  hostModule,
  guestModule,
}: let
  inherit (pkgs) lib;
  evaluate = notifications:
    (nixpkgs.lib.nixosSystem {
      inherit (pkgs.stdenv.hostPlatform) system;
      modules = [
        module
        {
          users.users.alice = {
            isNormalUser = true;
            uid = 1000;
          };
          services.pi = {
            enable = true;
            user = "alice";
            inherit notifications;
          };
          fileSystems."/" = {
            device = "none";
            fsType = "tmpfs";
          };
          boot.loader.grub.enable = false;
          system.stateVersion = "26.11";
        }
      ];
    }).config;
  accepted = config: lib.all (assertion: assertion.assertion) config.assertions;
  valid = config:
    lib.assertMsg (accepted config)
    (lib.concatMapStringsSep "\n" (assertion: assertion.message) (lib.filter (assertion: !assertion.assertion) config.assertions));
  guest =
    (nixpkgs.lib.nixosSystem {
      inherit (pkgs.stdenv.hostPlatform) system;
      modules = [guestModule {services.drv-run.notifications.enable = true;}];
    }).config;
  host =
    (nixpkgs.lib.nixosSystem {
      inherit (pkgs.stdenv.hostPlatform) system;
      modules = [
        hostModule
        module
        {
          nix.settings.experimental-features = ["nix-command" "flakes"];
          users.groups.alice.gid = 1000;
          users.users.alice = {
            isNormalUser = true;
            uid = 1000;
            group = "alice";
          };
          services.pi = {
            enable = true;
            user = "alice";
            notifications.enable = true;
          };
          services.drv-run = {
            notifications.enable = true;
            network = {
              uplink = "eth0";
              dnsServers = ["1.1.1.1"];
            };
          };
          fileSystems."/" = {
            device = "none";
            fsType = "tmpfs";
          };
          boot.loader.grub.enable = false;
          system.stateVersion = "26.11";
        }
      ];
    }).config;
  inbox = evaluate {enable = true;};
  push = {
    enable = true;
    origins = ["https://push.example"];
    subject = "mailto:owner@example.org";
    privateKeyFile = "/run/secrets/notifications-vapid";
  };
  delivery = evaluate {
    enable = true;
    inherit push;
  };
in
  assert valid inbox;
  assert valid guest;
  assert valid host;
  assert guest.services.dbus.enable;
  assert guest.users.users.root.linger;
  assert guest.systemd.user.services.drv-run-notifications.unitConfig.ConditionUser == "root";
  assert guest.systemd.user.services.drv-run-notifications.unitConfig.ConditionPathExists == "/run/drv-run-seed/notification-incarnation";
  assert guest.systemd.user.services.drv-run-notifications.serviceConfig.RuntimeDirectoryMode == "0700";
  assert guest.systemd.user.services.drv-run-notifications.serviceConfig.Type == "notify";
  assert guest.systemd.user.services.drv-run-notifications.serviceConfig.NotifyAccess == "all";
  assert host.services.pi.notifications.guests.enable;
  assert host.services.pi.notifications.guests.sshConfigFile != "";
  assert !(inbox.services.pi.notifications.guests.enable);
  assert valid delivery;
  assert inbox.users.users.alice.linger;
  assert inbox.systemd.user.services.pi.unitConfig.ConditionUser == "alice";
  assert inbox.systemd.user.services.pi.environment ? NOTIFICATIONS_CONFIG;
  assert !(accepted (evaluate {
    enable = true;
    guests.enable = true;
  }));
  assert !(accepted (evaluate {
    enable = false;
    inherit push;
  }));
  assert !(accepted (evaluate {
    enable = true;
    push = push // {origins = [];};
  }));
  assert !(accepted (evaluate {
    enable = true;
    push = push // {privateKeyFile = "/nix/store/not-a-secret";};
  }));
    pkgs.runCommand "notifications-options" {} ''
      touch "$out"
    ''

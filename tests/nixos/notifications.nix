{
  pkgs,
  piModule,
  impermanence,
}: let
  app = pkgs.app;
  sshConfig = pkgs.writeText "notification-test-ssh.conf" ''
    Host drv.run.fixture
      HostName 127.0.0.1
      HostKeyAlias drv.run.fixture
      User root
      BatchMode yes
      IdentitiesOnly yes
      IdentityAgent none
      IdentityFile /run/user/1000/drv.run.fixture/client-key
      UserKnownHostsFile /run/user/1000/drv.run.fixture/known_hosts
      GlobalKnownHostsFile /dev/null
      StrictHostKeyChecking yes
      ClearAllForwardings yes
  '';
in
  pkgs.testers.runNixOSTest {
    name = "notifications";
    nodes.machine = {
      imports = [piModule impermanence.nixosModules.impermanence ../../nixosModules/guest/notifications.nix];
      virtualisation.memorySize = 1024;
      virtualisation.cores = 2;
      virtualisation.graphics = false;
      users.groups.alice.gid = 1000;
      users.users.alice = {
        isNormalUser = true;
        uid = 1000;
        group = "alice";
      };
      fileSystems."/persist" = {
        device = "none";
        fsType = "tmpfs";
        neededForBoot = true;
      };
      services.drv-run.notifications.enable = true;
      services.pi = {
        enable = true;
        user = "alice";
        notifications = {
          enable = true;
          guests = {
            enable = true;
            sshConfigFile = toString sshConfig;
            scanIntervalMs = 100;
          };
        };
      };
      services.openssh = {
        enable = true;
        authorizedKeysFiles = ["/run/notification-test-authorized-keys"];
        settings = {
          PasswordAuthentication = false;
          KbdInteractiveAuthentication = false;
          PermitRootLogin = "prohibit-password";
          DisableForwarding = true;
          ForceCommand = "${app}/bin/notify-stream /run/user/0/drv-run-notifications/events.sock";
        };
      };
      environment.systemPackages = [pkgs.python3];
    };
    testScript = ''
      import shlex

      machine.start()
      machine.wait_for_unit("multi-user.target")
      machine.wait_for_unit("user@0.service")
      machine.wait_for_unit("user@1000.service")
      machine.wait_for_unit("sshd.service")
      root_bus = "XDG_RUNTIME_DIR=/run/user/0 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/0/bus "
      alice_bus = "XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus "
      machine.succeed("install -d -m 0700 /run/drv-run-seed")
      machine.succeed("cat /proc/sys/kernel/random/uuid > /run/drv-run-seed/notification-incarnation")
      machine.succeed("install -d -m 0700 -o alice -g alice /run/user/1000/drv.run.fixture")
      machine.succeed("cp /run/drv-run-seed/notification-incarnation /run/user/1000/drv.run.fixture/")
      machine.succeed("ssh-keygen -q -t ed25519 -N \"\" -f /run/user/1000/drv.run.fixture/client-key")
      machine.succeed("cp /run/user/1000/drv.run.fixture/client-key.pub /run/notification-test-authorized-keys")
      machine.succeed("printf 'drv.run.fixture ' > /run/user/1000/drv.run.fixture/known_hosts; cat /etc/ssh/ssh_host_ed25519_key.pub >> /run/user/1000/drv.run.fixture/known_hosts")
      machine.succeed("chown -R alice:alice /run/user/1000/drv.run.fixture")
      machine.succeed(root_bus + "systemctl --user start drv-run-notifications.service")
      machine.succeed(root_bus + "systemctl --user is-active drv-run-notifications.service")

      host_db = "/home/alice/.local/state/drv-run-notifications/activity.sqlite"
      guest_db = "/root/.local/state/drv-run-notifications/outbox.sqlite"
      def expect(database, sql, expected):
          code = f"import sqlite3; db=sqlite3.connect({database!r}); assert db.execute({sql!r}).fetchall() == {expected!r}"
          machine.wait_until_succeeds("python3 -c " + shlex.quote(code))

      # A user unit, not an SSH session or terminal, owns this producer.
      machine.succeed(root_bus + "systemd-run --user --wait --collect notify-send --expire-time=0 detached 'plain body'")
      expect(host_db, "SELECT count(*) FROM activity WHERE json_extract(event,'$.type')='notify'", [(1,)])
      expect(guest_db, "SELECT count(*) FROM queue", [(0,)])
      expect(host_db, "SELECT json_extract(key,'$[0]'),available,gap FROM source", [("drv.run.fixture", 1, 0)])

      # Host outage buffers work; restart replays it without losing the first item.
      machine.succeed("su -s /bin/sh alice -c " + shlex.quote(alice_bus + "systemctl --user stop pi"))
      machine.succeed(root_bus + "systemd-run --user --wait --collect notify-send --expire-time=0 buffered")
      expect(guest_db, "SELECT count(*) FROM queue", [(1,)])
      machine.succeed("su -s /bin/sh alice -c " + shlex.quote(alice_bus + "systemctl --user start pi"))
      expect(host_db, "SELECT count(*) FROM activity WHERE json_extract(event,'$.type')='notify'", [(2,)])
      expect(guest_db, "SELECT count(*) FROM queue", [(0,)])

      machine.succeed(root_bus + "systemctl --user restart drv-run-notifications")
      expect(host_db, "SELECT retired FROM source", [(1,)])
      machine.succeed(root_bus + "systemd-run --user --wait --collect notify-send --expire-time=0 new-server")
      expect(host_db, "SELECT count(*) FROM source", [(2,)])
      expect(host_db, "SELECT count(*) FROM activity WHERE json_extract(event,'$.type')='notify'", [(3,)])
      machine.succeed("rm /run/user/1000/drv.run.fixture/notification-incarnation")
      expect(host_db, "SELECT count(*) FROM source WHERE retired=0", [(0,)])
    '';
  }

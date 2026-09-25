{
  nixosModules,
  nixpkgs,
  pkgs,
}: let
  inherit (pkgs) lib;
  # No Flake provisioning in this gate: only transport of a captured store path.
  environment = pkgs.runCommand "primitive-env" {} "mkdir -p $out";
  payload = pkgs.writeText "primitive-payload" "offline routed Guest egress\n";
  webroot = pkgs.runCommand "primitive-webroot" {} ''
    mkdir -p $out
    cp ${payload} $out/payload
  '';
  guest = nixpkgs.lib.nixosSystem {
    inherit (pkgs.stdenv.hostPlatform) system;
    modules = [
      (import ./cloud-hypervisor-primitive/guest.nix {inherit nixosModules;})
      {
        system.extraDependencies = [environment payload];
        nix.settings.substituters = lib.mkForce [];
      }
    ];
  };
  runner = guest.config.microvm.declaredRunner;
  network = pkgs.writeText "primitive-uplink.network" ''
    [Match]
    MACAddress=02:00:00:00:00:01
    [Network]
    Address=10.231.0.2/30
    Gateway=10.231.0.1
    DNS=93.184.216.34
    DHCP=no
    LinkLocalAddressing=no
    IPv6AcceptRA=no
  '';
  prepare = pkgs.writeShellApplication {
    name = "prepare-primitive";
    runtimeInputs = with pkgs; [coreutils e2fsprogs openssh util-linux];
    text = lib.replaceStrings ["@environment@" "@network@"] [(toString environment) (toString network)] (
      builtins.readFile ./cloud-hypervisor-primitive/prepare.sh
    );
  };
  attach = pkgs.writeText "attach-tap.py" ''
    import errno
    import fcntl
    import os
    import struct
    import sys

    # Opening /dev/net/tun must work for both users. Only attachment is denied.
    fd = os.open("/dev/net/tun", os.O_RDWR)
    try:
        # TUNSETIFF: IFF_TAP | IFF_NO_PI | IFF_VNET_HDR | IFF_MULTI_QUEUE.
        fcntl.ioctl(fd, 0x400454ca, struct.pack("16sH", b"drv-primitive", 0x5102))
    except PermissionError as error:
        assert sys.argv[1] == "denied" and error.errno == errno.EPERM
    else:
        assert sys.argv[1] == "allowed"
    finally:
        os.close(fd)
  '';
in {
  name = "cloud-hypervisor-primitive";
  qemu.forceAccel = true;
  nodes = {
    host = {lib, ...}: {
      virtualisation = {
        memorySize = 6144;
        cores = 2;
        diskSize = 20480;
        qemu.options = ["-cpu" "host"];
      };
      users.users = {
        operator = {
          isNormalUser = true;
          uid = 1000;
          extraGroups = ["kvm"];
          linger = true;
        };
        other = {
          isNormalUser = true;
          uid = 1001;
        };
      };
      environment.systemPackages = with pkgs; [curl e2fsprogs iproute2 jq openssh python3];
      boot.kernelModules = ["tun"];
      boot.kernel.sysctl."net.ipv4.ip_forward" = 1;
      networking = {
        interfaces.eth1.ipv4 = {
          addresses = lib.mkForce [
            {
              address = "192.168.1.1";
              prefixLength = 24;
            }
          ];
          # A public address on the isolated test VLAN, never the real Internet.
          routes = [
            {
              address = "93.184.216.34";
              prefixLength = 32;
              via = "192.168.1.2";
            }
          ];
        };
        nftables.enable = true;
        firewall = {
          enable = true;
          filterForward = true;
          extraForwardRules = ''
            iifname "drv-primitive" oifname "eth1" ip saddr 10.231.0.2 ip daddr 93.184.216.34 accept
          '';
        };
        # Fixture only, not the production pool or its isolation policy.
        nftables.tables.primitive-nat = {
          family = "ip";
          content = ''
            chain postrouting {
              type nat hook postrouting priority srcnat; policy accept;
              oifname "eth1" ip saddr 10.231.0.2 ip daddr 93.184.216.34 masquerade
            }
          '';
        };
      };
      systemd.services.primitive-tap = {
        wantedBy = ["multi-user.target"];
        requires = ["nftables.service"];
        after = ["nftables.service" "systemd-sysctl.service"];
        path = [pkgs.iproute2];
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
        };
        script = ''
          ip tuntap add dev drv-primitive mode tap user 1000 vnet_hdr multi_queue
          echo 1 > /proc/sys/net/ipv6/conf/drv-primitive/disable_ipv6
          echo 0 > /proc/sys/net/ipv4/conf/drv-primitive/send_redirects
          ip addr add 10.231.0.1/30 dev drv-primitive
          ip link set dev drv-primitive up
        '';
      };
      systemd.user.services.primitive = {
        description = "Unprivileged primitive Cloud Hypervisor Guest";
        serviceConfig = {
          Type = "exec";
          ExecStartPre = lib.getExe prepare;
          ExecStart = "${runner}/bin/microvm-run";
          ExecStop = "${runner}/bin/microvm-shutdown";
          # Capture exit state before systemd can garbage-collect the unit,
          # and bounded serial diagnostics before RuntimeDirectory removal.
          ExecStopPost = "${pkgs.writeShellScript "primitive-diagnostics" ''
            set -eu
            ${pkgs.jq}/bin/jq -n \
              --arg result "''${SERVICE_RESULT:-}" \
              --arg code "''${EXIT_CODE:-}" \
              --arg status "''${EXIT_STATUS:-}" \
              '{result: $result, code: $code, status: $status}' > "$STATE_DIRECTORY/exit-status.json"
            if test -f "$RUNTIME_DIRECTORY/serial.log"; then
              ${pkgs.coreutils}/bin/tail -c 65536 "$RUNTIME_DIRECTORY/serial.log" > "$STATE_DIRECTORY/serial-tail.log"
            fi
          ''}";
          StateDirectory = "drv.run-primitive";
          StateDirectoryMode = "0700";
          RuntimeDirectory = "drv.run-primitive";
          RuntimeDirectoryMode = "0700";
          WorkingDirectory = "%t/drv.run-primitive";
          UMask = "0077";
          KillMode = "control-group";
          Restart = "no";
          TimeoutStartSec = 60;
          TimeoutStopSec = 30;
        };
      };
    };
    endpoint = {lib, ...}: {
      # Scripted networking does not activate loopback address units through
      # a device dependency. Pull this one in before binding the DNS socket.
      systemd.services.dnsmasq = {
        requires = ["network-addresses-lo.service"];
        after = ["network-addresses-lo.service"];
      };
      networking = {
        interfaces = {
          eth1.ipv4.addresses = lib.mkForce [
            {
              address = "192.168.1.2";
              prefixLength = 24;
            }
          ];
          lo.ipv4.addresses = [
            {
              address = "93.184.216.34";
              prefixLength = 32;
            }
          ];
        };
        firewall = {
          allowedTCPPorts = [53 80];
          allowedUDPPorts = [53];
        };
      };
      services = {
        dnsmasq = {
          enable = true;
          resolveLocalQueries = false;
          settings = {
            no-resolv = true;
            no-hosts = true;
            bind-interfaces = true;
            listen-address = "93.184.216.34";
            address = "/primitive.test/93.184.216.34";
          };
        };
        nginx = {
          enable = true;
          virtualHosts."primitive.test" = {
            default = true;
            root = webroot;
            # Record the peer address as structured state, not diagnostic text.
            extraConfig = "access_log /var/log/nginx/primitive.json primitive;";
          };
          commonHttpConfig = ''
            log_format primitive escape=json '{"peer":"$remote_addr"}';
          '';
        };
      };
    };
  };
  testScript = ''
    import datetime as dt
    import json
    import shlex

    runtime = "/run/user/1000/drv.run-primitive"
    state = "/home/operator/.local/state/drv.run-primitive"
    unit = "primitive.service"

    def as_user(user: str, command: str) -> str:
        return "su --login " + shlex.quote(user) + " --command " + shlex.quote(command)

    def owner_command(command: str) -> str:
        return as_user("operator", "export XDG_RUNTIME_DIR=/run/user/1000; " + command)

    def owner(command: str) -> str:
        return host.succeed(owner_command(command))

    def ssh(command: str) -> str:
        return owner_command(f"ssh -F {runtime}/connection.conf drv.run.primitive " + shlex.quote(command))

    def guest(command: str) -> str:
        return host.succeed(ssh("set -eu; " + command))

    def stop_cleanly() -> None:
        owner(f"systemctl --user stop {unit}")
        # A stopped unit may already have been unloaded, losing ExecMain*.
        # Assert the exit state captured by ExecStopPost, not reloaded defaults.
        exit_status = json.loads(owner(f"cat {state}/exit-status.json"))
        t.assertEqual(exit_status, {"result": "success", "code": "exited", "status": "0"})
        properties = dict(line.split("=", 1) for line in owner(
            f"systemctl --user show {unit} -p ActiveState -p MainPID"
        ).splitlines())
        t.assertEqual(properties, {"ActiveState": "inactive", "MainPID": "0"})
        host.fail(f"test -e {runtime}")
        owner(f"e2fsck -fn {state}/state.img")
        host.succeed(f"test -s {state}/serial-tail.log")

    def boot() -> None:
        owner(f"systemctl --user start {unit}")
        host.wait_until_succeeds(ssh("true"), timeout=dt.timedelta(seconds=120))
        guest("timeout 60 systemctl is-system-running --wait")

    start_all()
    host.wait_for_unit("primitive-tap.service")
    host.wait_for_unit("user@1000.service")
    host.wait_for_unit("default.target", user="operator")
    endpoint.wait_for_unit("dnsmasq.service")
    endpoint.succeed("systemctl is-active --quiet network-addresses-lo.service")
    endpoint_addresses = json.loads(endpoint.succeed("ip -j -4 addr show dev lo"))
    t.assertIn(("93.184.216.34", 32), [
        (a["local"], a["prefixlen"]) for a in endpoint_addresses[0]["addr_info"]
    ])
    endpoint.wait_for_unit("nginx.service")

    try:
        with subtest("preallocated TAP permits only its unprivileged owner"):
            owner("test -r /dev/kvm && test -w /dev/kvm && test -w /dev/net/tun")
            owner("python3 ${attach} allowed")
            host.succeed(as_user("other", "python3 ${attach} denied"))
            host.succeed("test $(cat /sys/class/net/drv-primitive/owner) -eq 1000")
            flags = int(host.succeed("cat /sys/class/net/drv-primitive/tun_flags").strip(), 16)
            t.assertEqual(flags & 0x5102, 0x5102)
            addresses = json.loads(host.succeed("ip -j -4 addr show dev drv-primitive"))
            t.assertEqual([(a["local"], a["prefixlen"]) for a in addresses[0]["addr_info"]], [("10.231.0.1", 30)])

        with subtest("Cloud Hypervisor boots without network capabilities"):
            boot()
            pid = int(owner(f"systemctl --user show {unit} -p MainPID --value"))
            status = dict(line.split(":", 1) for line in host.succeed(f"cat /proc/{pid}/status").splitlines())
            t.assertEqual([int(uid) for uid in status["Uid"].split()], [1000] * 4)
            t.assertEqual(int(status["CapEff"].strip(), 16), 0)
            executable = host.succeed(f"readlink /proc/{pid}/exe").strip()
            t.assertEqual(executable, "${guest.config.microvm.cloud-hypervisor.package}/bin/cloud-hypervisor")
            info = json.loads(owner(f"curl --fail --silent --unix-socket {runtime}/control.sock http://localhost/api/v1/vm.info"))
            t.assertEqual(info["config"]["net"][0]["tap"], "drv-primitive")
            t.assertEqual(info["config"]["net"][0]["num_queues"], 4)
            t.assertEqual(len(info["config"]["net"]), 1)
            t.assertEqual([disk["readonly"] for disk in info["config"]["disks"]], [True, False, True])
            host.succeed(f"test -S {runtime}/control.sock && test -s {runtime}/serial.log")
            host.fail(f"test -e {runtime}/ssh.sock")
            guest("systemd-analyze --man=no verify /etc/systemd/system/drv-run-seed.service /etc/systemd/system/systemd-networkd.service /etc/systemd/system/sshd.service")

        with subtest("seed ownership, mount flags and service-private credentials"):
            for path in [runtime, state]:
                t.assertEqual(host.succeed(f"stat -c '%u:%a' {path}").strip(), "1000:700")
            for path in [f"{runtime}/seed.img", f"{runtime}/client-key", f"{state}/host-key"]:
                t.assertEqual(host.succeed(f"stat -c '%u:%a' {path}").strip(), "1000:600")
                host.fail(as_user("other", f"test -r {path}"))
            t.assertEqual(guest("stat -c '%u:%g:%a' /run/drv-run-seed").strip(), "0:0:700")
            mount = json.loads(guest("findmnt -J /run/drv-run-seed"))["filesystems"][0]
            t.assertEqual(mount["source"], "/dev/vdc")
            t.assertTrue({"ro", "nodev", "nosuid", "noexec"}.issubset(set(mount["options"].split(","))))
            host.fail(ssh("touch /run/drv-run-seed/write-must-fail"))
            guest("test $(cat /sys/block/vdc/ro) -eq 1; test ! -L /run/drv-run-seed/host-key")
            for credential in ["authorized-keys", "host-key", "environment-path"]:
                guest(f"cmp /run/drv-run-seed/{credential} /run/credentials/sshd.service/{credential}")
            t.assertEqual(guest("cat /run/credentials/sshd.service/environment-path").strip(), "${environment}")
            host_key = owner(f"ssh-keygen -y -f {state}/host-key").strip()
            t.assertEqual(guest("ssh-keygen -y -f /run/credentials/sshd.service/host-key").strip(), host_key)

        with subtest("static routing and resolved DNS reach the isolated endpoint through NAT"):
            interfaces = json.loads(guest("ip -j -4 addr"))
            t.assertIn(("10.231.0.2", 30), [(a["local"], a["prefixlen"]) for i in interfaces for a in i["addr_info"]])
            routes = json.loads(guest("ip -j -4 route show default"))
            t.assertEqual([r["gateway"] for r in routes], ["10.231.0.1"])
            guest("test ! -e /etc/systemd/network/10-uplink.network; test ! -L /etc/systemd/network/10-uplink.network")
            guest("cmp /run/drv-run-seed/uplink.network /run/systemd/network/10-uplink.network")
            guest("systemctl is-active --quiet systemd-resolved.service")
            guest("curl --fail --silent --show-error --max-time 15 http://primitive.test/payload -o /workspace/fetched; cmp /workspace/fetched ${payload}")
            requests = [json.loads(line) for line in endpoint.succeed("cat /var/log/nginx/primitive.json").splitlines()]
            t.assertTrue(requests)
            t.assertEqual({request["peer"] for request in requests}, {"192.168.1.1"})

        with subtest("strict authentication rejects wrong host and client keys"):
            owner(f"ssh-keygen -q -t ed25519 -N \"\" -f {runtime}/unrelated-key")
            owner(f"printf 'drv.run.primitive %s\\n' \"$(ssh-keygen -y -f {runtime}/unrelated-key)\" > {runtime}/wrong-known-hosts")
            host.fail(owner_command(f"ssh -o UserKnownHostsFile={runtime}/wrong-known-hosts -F {runtime}/connection.conf drv.run.primitive true"))
            # -F /dev/null prevents additive IdentityFile values from offering the valid key.
            host.fail(owner_command(f"ssh -F /dev/null -o BatchMode=yes -o ConnectTimeout=2 -o IdentitiesOnly=yes -o IdentityAgent=none -o StrictHostKeyChecking=yes -o HostKeyAlias=drv.run.primitive -o UserKnownHostsFile={runtime}/known_hosts -i {runtime}/unrelated-key root@10.231.0.2 true"))

        with subtest("API power button shuts down cleanly and persistence survives"):
            boot_id = guest("cat /proc/sys/kernel/random/boot_id").strip()
            client_key = owner(f"ssh-keygen -y -f {runtime}/client-key").strip()
            guest("touch /workspace/retained /root/discarded; sync")
            stop_cleanly()
            boot()
            t.assertNotEqual(guest("cat /proc/sys/kernel/random/boot_id").strip(), boot_id)
            t.assertNotEqual(owner(f"ssh-keygen -y -f {runtime}/client-key").strip(), client_key)
            t.assertEqual(owner(f"ssh-keygen -y -f {state}/host-key").strip(), host_key)
            guest("test -f /workspace/retained; test ! -e /root/discarded; cmp /workspace/fetched ${payload}")
            stop_cleanly()
    finally:
        # Preserve boot/shutdown diagnostics even when the gate fails before SSH.
        for command in [
            owner_command(f"systemctl --user status {unit} --no-pager"),
            "journalctl -b _UID=1000 --no-pager -n 200",
            f"cat {state}/exit-status.json",
            f"tail -c 65536 {runtime}/serial.log {state}/serial-tail.log",
            "ip -details link show dev drv-primitive; ip -4 route get 10.231.0.2; ip -4 neigh show dev drv-primitive",
        ]:
            status, output = host.execute(command, timeout=dt.timedelta(seconds=10))
            host.log(f"Diagnostics ({command}, exit {status}):\n{output}")
  '';
}

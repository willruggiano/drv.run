{pkgs}: let
  inherit (pkgs) lib;
  keys = import (pkgs.path + "/nixos/tests/ssh-keys.nix") pkgs;
  python = pkgs.python3.withPackages (p: [p.dnspython]);
  tap = ./host-network/tap.py;
  emptyNscd = pkgs.runCommand "network-empty-nscd" {} "mkdir -p $out";
  payload = pkgs.writeText "network-payload" "offline pool egress\n";
  server = pkgs.writeText "network-endpoint.py" ''
    from http.server import BaseHTTPRequestHandler, HTTPServer
    from pathlib import Path

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            Path('/run/http-peer').write_text(self.client_address[0])
            self.send_response(200)
            self.end_headers()
            self.wfile.write(Path('${payload}').read_bytes())

    HTTPServer(('0.0.0.0', 8080), Handler).serve_forever()
  '';
  destinations = ["93.184.216.34" "169.254.169.254" "100.64.0.2" "10.42.0.2" "198.18.0.1"];
in {
  name = "host-network";
  qemu.forceAccel = true;
  nodes = {
    host = {lib, ...}: {
      imports = [../nixosModules/host/network.nix];
      virtualisation = {
        memorySize = 1536;
        cores = 2;
        qemu.options = ["-cpu" "host"];
      };
      users.users = {
        operator = {
          isNormalUser = true;
          uid = 1000;
          extraGroups = ["kvm"];
        };
        # Exercise runtime username -> UID resolution, not just fixed IDs.
        other = {
          isNormalUser = true;
          extraGroups = ["kvm"];
        };
        disabled = {
          enable = false;
          isNormalUser = true;
        };
        bot = {
          isSystemUser = true;
          group = "nogroup";
        };
        root.openssh.authorizedKeys.keys = [keys.snakeOilPublicKey];
      };
      services.drv-run.network = {
        uplink = "eth1";
        dnsServers = ["93.184.216.34" "192.168.1.2"];
        slots = {
          drv-op0 = {
            owner = "operator";
            subnet = "10.231.0.0/30";
          };
          drv-op1 = {
            owner = "operator";
            subnet = "10.231.0.4/30";
          };
          drv-other0 = {
            owner = "other";
            subnet = "10.231.0.8/30";
          };
        };
      };
      environment.systemPackages = with pkgs; [curl iproute2 jq netcat-openbsd python util-linux];
      environment.etc."ssh/ssh_host_ed25519_key" = {
        source = keys.snakeOilEd25519PrivateKey;
        mode = "0600";
      };
      services.openssh = {
        enable = true;
        hostKeys = [
          {
            path = "/etc/ssh/ssh_host_ed25519_key";
            type = "ed25519";
          }
        ];
        settings.PermitRootLogin = "prohibit-password";
      };
      networking = {
        enableIPv6 = true;
        interfaces.eth1.ipv4 = {
          addresses = lib.mkForce [
            {
              address = "192.168.1.1";
              prefixLength = 24;
            }
          ];
          routes =
            map (address: {
              inherit address;
              prefixLength = 32;
              via = "192.168.1.2";
            })
            destinations;
        };
        firewall.allowedTCPPorts = [8080];
      };
      systemd.services.host-listener = {
        wantedBy = ["multi-user.target"];
        serviceConfig.ExecStart = "${python}/bin/python3 -m http.server 8080 --bind 0.0.0.0";
      };
    };
    endpoint = {lib, ...}: {
      environment.systemPackages = with pkgs; [curl iproute2 netcat-openbsd openssh];
      networking = {
        interfaces.eth1.ipv4 = {
          addresses = lib.mkForce [
            {
              address = "192.168.1.2";
              prefixLength = 24;
            }
          ];
          routes = [
            {
              address = "10.231.0.0";
              prefixLength = 24;
              via = "192.168.1.1";
            }
          ];
        };
        interfaces.lo.ipv4.addresses =
          map (address: {
            inherit address;
            prefixLength = 32;
          })
          destinations;
        firewall = {
          allowedTCPPorts = [53 8080];
          allowedUDPPorts = [53];
        };
      };
      environment.etc."ssh/client-key" = {
        source = keys.snakeOilPrivateKey;
        mode = "0600";
      };
      programs.ssh = {
        extraConfig = ''
          Host host
            HostName 192.168.1.1
            HostKeyAlias host
            User root
            IdentityFile /etc/ssh/client-key
            IdentitiesOnly yes
            BatchMode yes
            StrictHostKeyChecking yes
        '';
        knownHosts.host.publicKey = keys.snakeOilEd25519PublicKey;
      };
      services.dnsmasq = {
        enable = true;
        settings = {
          no-resolv = true;
          bind-interfaces = true;
          listen-address = ["93.184.216.34" "192.168.1.2"];
          address = ["/pool.test/93.184.216.34"];
        };
      };
      systemd.services.dnsmasq = {
        requires = ["network-addresses-lo.service" "network-addresses-eth1.service"];
        after = ["network-addresses-lo.service" "network-addresses-eth1.service"];
      };
      systemd.services.endpoint = {
        wantedBy = ["multi-user.target"];
        serviceConfig.ExecStart = "${python}/bin/python3 ${server}";
      };
    };
  };
  testScript = ''
    import datetime as dt
    import json
    import shlex

    pool = "drv-run-network.service"
    root = "/run/drv.run-network"
    slots = [
        ("drv-op0", "operator", "10.231.0.1", "10.231.0.2"),
        ("drv-op1", "operator", "10.231.0.5", "10.231.0.6"),
        ("drv-other0", "other", "10.231.0.9", "10.231.0.10"),
    ]

    def as_user(owner, command):
        return "runuser -u " + shlex.quote(owner) + " -- sh -c " + shlex.quote(command)

    def lockfile(tap, owner):
        return f"{root}/leases/{owner}/{tap}.lock"

    def properties():
        return dict(line.split("=", 1) for line in host.succeed(
            f"systemctl show {pool} -p ActiveState -p Result"
        ).splitlines())

    def no_pool():
        host.fail(f"test -e {root}/ready")
        for tap, _, _, _ in slots:
            host.fail(f"ip link show dev {tap}")

    def guest(tap, command, success=True):
        # netns exec gives each command a private, recursively slave mount
        # namespace. Hide Host NSS IPC so DNS uses this namespace's resolv.conf,
        # not the Host daemon's network. A real Guest has no Host NSS socket.
        isolated = "${pkgs.util-linux}/bin/mount --bind ${emptyNscd} /run/nscd || exit 125; "
        isolated += "exec ${pkgs.runtimeShell} -c " + shlex.quote(command)
        command = f"ip netns exec {tap} ${pkgs.runtimeShell} -c " + shlex.quote(isolated)
        if success:
            return host.succeed(command)
        status, output = host.execute(command)
        # A mount failure must not count as a successful isolation assertion.
        t.assertNotIn(status, [0, 125], f"Expected traffic rejection, not setup failure: {command}")
        return output

    def source_drops():
        rules = json.loads(host.succeed("nft -j list chain inet drv-run source"))["nftables"]
        return sum(expression["counter"]["packets"] for item in rules
            for expression in item.get("rule", {}).get("expr", []) if "counter" in expression)

    def egress(tap):
        guest(tap, f"test ! -S /var/run/nscd/socket && test ! -S /run/nscd/socket && cmp /etc/resolv.conf /etc/netns/{tap}/resolv.conf")
        # The masking mount must not propagate back into the Host.
        host.succeed("test -S /var/run/nscd/socket && systemctl is-active --quiet nscd.service")
        guest(tap, "curl --noproxy '*' --fail --max-time 5 http://pool.test:8080/ -o /tmp/pool-payload")
        host.succeed("cmp /tmp/pool-payload ${payload}")
        t.assertEqual(endpoint.succeed("cat /run/http-peer"), "192.168.1.1")

    start_all()
    try:
        host.wait_for_unit(pool)
        host.wait_for_unit("host-listener.service")
        endpoint.wait_for_unit("dnsmasq.service")
        endpoint.wait_for_unit("endpoint.service")
        endpoint.succeed("ip addr show dev lo")
        endpoint.succeed("ssh host true")

        with subtest("owner manifests, device permissions and immutable lease inodes"):
            inodes = {}
            for tap, owner, gateway, address in slots:
                uid = int(host.succeed(f"id -u {owner}"))
                manifest = json.loads(host.succeed(f"cat /etc/drv.run/network/{owner}.json"))
                t.assertEqual({row["owner"] for row in manifest["slots"]}, {owner})
                t.assertEqual(manifest["generation"], host.succeed(f"cat {root}/ready").strip())
                selected = next(row for row in manifest["slots"] if row["tap"] == tap)
                t.assertEqual((selected["gateway"], selected["guest"], selected["prefixLength"], selected["numQueues"]),
                    (gateway, address, 30, 4))
                t.assertEqual(int(host.succeed(f"cat /sys/class/net/{tap}/owner")), uid)
                routes = json.loads(host.succeed(f"ip -j -4 route get {address}"))
                t.assertEqual((routes[0]["dev"], routes[0]["prefsrc"]), (tap, gateway))
                lock = lockfile(tap, owner)
                t.assertEqual(host.succeed(f"stat -c '%u:%a' {lock}").strip(), f"{uid}:600")
                inodes[tap] = host.succeed(f"stat -c %i {lock}")
                host.succeed(as_user(owner, f"python3 ${tap} allowed {tap}"))
                foreign = "other" if owner == "operator" else "operator"
                host.succeed(as_user(foreign, f"python3 ${tap} denied {tap}"))
                host.fail(as_user(foreign, f"flock -n {lock} true"))
                host.fail(as_user(owner, f"rm {lock}"))
                host.fail(as_user(owner, f"mv {lock} {lock}.old"))
            for owner in ["disabled", "bot", "root"]:
                host.fail(f"test -e /etc/drv.run/network/{owner}.json")
                host.fail(f"test -e {root}/leases/{owner}")

        with subtest("concurrent owner leases exhaust only that owner's capacity"):
            for index in range(2):
                lock = lockfile(f"drv-op{index}", "operator")
                # Transient services do not inherit the test shell's PATH.
                host.succeed(f"systemd-run --unit=lease{index} --uid=operator --property=Type=exec ${pkgs.util-linux}/bin/flock -n {lock} ${pkgs.coreutils}/bin/sleep infinity")
                # Require lock contention specifically, not an arbitrary failure.
                probe = as_user("operator", f"${pkgs.util-linux}/bin/flock -n -E 75 {lock} ${pkgs.coreutils}/bin/true; test $? -eq 75")
                host.wait_until_succeeds(probe, timeout=dt.timedelta(seconds=30))
                host.succeed(f"systemctl is-active --quiet lease{index}.service")
            host.fail(as_user("operator", f"for lock in {root}/leases/operator/*.lock; do flock -n \"$lock\" true && exit 0; done; exit 1"))
            host.succeed(as_user("other", f"flock -n {lockfile('drv-other0', 'other')} true"))
            host.execute(f"systemctl stop {pool}")
            t.assertEqual(properties(), {"ActiveState": "failed", "Result": "exit-code"})
            for tap, _, _, _ in slots:
                host.succeed(f"ip link show dev {tap}")
            host.succeed("systemctl stop lease0 lease1")
            host.succeed(f"systemctl start {pool}")
            for tap, owner, _, _ in slots:
                t.assertEqual(host.succeed(f"stat -c %i {lockfile(tap, owner)}"), inodes[tap])

        with subtest("real TAP traffic traverses the combined Host ruleset"):
            for tap, owner, gateway, address in slots:
                host.succeed(f"ip netns add {tap}")
                host.succeed(f"ip netns exec {tap} ip tuntap add dev eth0 mode tap vnet_hdr multi_queue")
                host.succeed(f"ip netns exec {tap} ip link set lo up")
                host.succeed(f"ip netns exec {tap} ip addr add {address}/30 dev eth0")
                host.succeed(f"ip netns exec {tap} ip link set eth0 up")
                host.succeed(f"ip netns exec {tap} ip route add default via {gateway}")
                host.succeed(f"mkdir -p /etc/netns/{tap}; printf 'nameserver 93.184.216.34\\n' > /etc/netns/{tap}/resolv.conf")
                host.succeed(f"systemd-run --unit=relay-{tap} --property=Type=exec ${python}/bin/python3 ${tap} relay {tap} {tap} {owner}")
                host.succeed(f"systemd-run --unit=listener-{tap} --property=Type=exec ${pkgs.iproute2}/bin/ip netns exec {tap} ${python}/bin/python3 -m http.server 22 --bind 0.0.0.0")
                host.wait_until_succeeds(as_user(owner, f"nc -z -w 1 {address} 22"), timeout=dt.timedelta(seconds=30))
                relay_pid = int(host.succeed(f"systemctl show -p MainPID --value relay-{tap}"))
                uid = int(host.succeed(f"id -u {owner}"))
                t.assertEqual(int(host.succeed(f"stat -c %u /proc/{relay_pid}")), uid)
                process = dict(line.split(":", 1) for line in host.succeed(f"cat /proc/{relay_pid}/status").splitlines())
                t.assertEqual(int(process["CapEff"].strip(), 16), 0)
            # Bring every peer up before testing isolation; absent peers prove nothing.
            for tap, owner, _, address in slots:
                egress(tap)
                host.succeed(as_user(owner, f"nc -z -w 1 {address} 22"))
                foreign = "other" if owner == "operator" else "operator"
                host.fail(as_user(foreign, f"nc -z -w 1 {address} 22"))
                endpoint.fail(f"nc -z -w 1 {address} 22")
                for destination in ["10.231.0.1", "192.168.1.1"]:
                    for port in [22, 8080]:
                        guest(tap, f"nc -z -w 1 {destination} {port}", success=False)
                for _, _, _, peer in slots:
                    if peer != address:
                        guest(tap, f"nc -z -w 1 {peer} 22", success=False)
                for destination in ["192.168.1.2", "169.254.169.254", "100.64.0.2", "10.42.0.2", "198.18.0.1"]:
                    guest(tap, f"curl --noproxy '*' --fail --max-time 1 http://{destination}:8080/", success=False)
                # Private DNS is an exception only on port 53, UDP and TCP.
                for tcp in [False, True]:
                    query = "import dns.message, dns.query; q=dns.message.make_query('pool.test','A'); "
                    query += f"r=dns.query.{'tcp' if tcp else 'udp'}(q,'192.168.1.2',timeout=3); "
                    query += "assert r.rcode()==0 and r.answer[0][0].address=='93.184.216.34'"
                    guest(tap, "python3 -c " + shlex.quote(query))

        with subtest("source spoofing and IPv6 are dropped before conntrack"):
            # Use a unicast /32 outside the link's /30. For a broadcast bind,
            # Linux can select the ordinary interface address as the source.
            spoof = "10.231.1.2"
            guest("drv-op0", f"ip addr add {spoof}/32 dev eth0")
            try:
                route = json.loads(guest("drv-op0", f"ip -j -4 route get {spoof}"))
                t.assertEqual(route[0]["type"], "local")
                for command in [
                    f"curl --noproxy '*' --interface {spoof} --fail --max-time 1 http://93.184.216.34:8080/",
                    f"nc -s {spoof} -z -w 1 10.231.0.1 8080",
                ]:
                    before = source_drops()
                    guest("drv-op0", command, success=False)
                    # Failure alone could be routing or a later firewall hook.
                    # Each probe must reach and be dropped by the raw guard.
                    t.assertGreater(source_drops(), before)
            finally:
                guest("drv-op0", f"ip addr del {spoof}/32 dev eth0")
            egress("drv-op0")
            # Isolate the nft guard from the kernel's earlier disable_ipv6 drop.
            # This is a test-only perturbation; restore the required link setting.
            host.succeed("echo 0 > /proc/sys/net/ipv6/conf/drv-op0/disable_ipv6")
            try:
                before = source_drops()
                guest("drv-op0", "ip -6 addr add fe80::2/64 dev eth0 nodad")
                packet = "import socket; s=socket.socket(socket.AF_INET6,socket.SOCK_DGRAM); "
                packet += "s.sendto(b'probe',('ff02::1',9999,0,socket.if_nametoindex('eth0')))"
                guest("drv-op0", "python3 -c " + shlex.quote(packet))
                host.wait_until_succeeds("nft -j list chain inet drv-run source | jq -e " + shlex.quote(
                    '[.nftables[] | .rule? // empty | .expr[] | .counter?.packets // 0] | add > ' + str(before)
                ), timeout=dt.timedelta(seconds=30))
            finally:
                host.succeed("echo 1 > /proc/sys/net/ipv6/conf/drv-op0/disable_ipv6")

        with subtest("firewall reload retains isolation and does not replace leases"):
            host.succeed("systemctl reload nftables")
            endpoint.succeed("ssh host true")
            for tap, owner, _, address in slots:
                egress(tap)
                foreign = "other" if owner == "operator" else "operator"
                host.fail(as_user(foreign, f"nc -z -w 1 {address} 22"))
                guest(tap, "nc -z -w 1 192.168.1.1 22", success=False)
                t.assertEqual(host.succeed(f"stat -c %i {lockfile(tap, owner)}"), inodes[tap])

        with subtest("maintenance refuses attached queues, then preserves lock inodes"):
            host.execute(f"systemctl stop {pool}")
            t.assertEqual(properties(), {"ActiveState": "failed", "Result": "exit-code"})
            for tap, _, _, _ in slots:
                host.succeed(f"ip link show dev {tap}")
            egress("drv-other0")
            for tap, _, _, _ in slots:
                host.succeed(f"systemctl stop listener-{tap} relay-{tap}; ip netns del {tap}")
            host.succeed(f"systemctl start {pool}; systemctl stop {pool}")
            no_pool()
            for tap, owner, _, _ in slots:
                t.assertEqual(host.succeed(f"stat -c %i {lockfile(tap, owner)}"), inodes[tap])

        with subtest("route collisions and unrelated interfaces fail without deletion"):
            host.succeed(f"systemctl reset-failed {pool}")
            host.succeed("ip link add collision type dummy; ip addr add 10.231.0.100/24 dev collision; ip link set collision up")
            host.fail(f"systemctl start {pool}")
            no_pool()
            host.succeed("ip link show collision; ip link del collision")
            host.succeed(f"systemctl reset-failed {pool}")
            host.succeed("ip link add drv-op0 type dummy")
            host.fail(f"systemctl start {pool}")
            host.succeed("ip link show drv-op0; ip link del drv-op0")
            no_pool()

        with subtest("Host-local upstream DNS fails before allocation"):
            host.succeed(f"systemctl reset-failed {pool}")
            host.succeed("ip addr add 93.184.216.34/32 dev lo")
            host.fail(f"systemctl start {pool}")
            no_pool()
            host.succeed("ip addr del 93.184.216.34/32 dev lo")

        with subtest("partial setup rolls back new resources, not preexisting leases"):
            host.succeed(f"systemctl reset-failed {pool}")
            bad_lock = lockfile("drv-other0", "other")
            new_lock = lockfile("drv-op0", "operator")
            # Root removes this inode only while every slot is stopped and idle.
            host.succeed(f"rm {new_lock}; chmod 0644 {bad_lock}")
            host.fail(f"systemctl start {pool}")
            no_pool()
            host.fail(f"test -e {new_lock}")
            for tap, owner, _, _ in slots[1:]:
                t.assertEqual(host.succeed(f"stat -c %i {lockfile(tap, owner)}"), inodes[tap])
            host.succeed(f"chmod 0600 {bad_lock}; systemctl reset-failed {pool}; systemctl start {pool}")
            host.succeed(f"systemctl stop {pool}")
            no_pool()
    finally:
        for command in [
            f"systemctl status {pool} --no-pager",
            f"journalctl -b -u {pool} --no-pager",
            "systemctl status lease0.service lease1.service --no-pager",
            "journalctl -b -u 'lease*' -u 'relay-*' -u 'listener-*' --no-pager",
            "ip netns list",
            "ip -j -d link show",
            "ip -j -4 route show table all",
            "nft list table inet drv-run",
            "nft list table inet nixos-fw",
        ]:
            status, output = host.execute(command)
            host.log(f"Diagnostics ({command}, exit {status}):\n{output}")
        for tap, _, _, _ in slots:
            for command in [
                f"ip netns exec {tap} cat /etc/resolv.conf",
                f"ip netns exec {tap} ip -j -4 address show",
                f"ip netns exec {tap} ip -j -4 route show table all",
                f"ip netns exec {tap} ip -j neigh show",
            ]:
                status, output = host.execute(command)
                host.log(f"Diagnostics ({command}, exit {status}):\n{output}")
        for command in ["journalctl -b -u dnsmasq --no-pager", "ip -j -4 route show", "${pkgs.iptables}/bin/iptables-save"]:
            status, output = endpoint.execute(command)
            endpoint.log(f"Diagnostics ({command}, exit {status}):\n{output}")
  '';
}

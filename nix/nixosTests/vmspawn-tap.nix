{
  nixpkgs,
  pkgs,
}: let
  inherit (pkgs) lib;
  guest = nixpkgs.lib.nixosSystem {
    inherit (pkgs.stdenv.hostPlatform) system;
    modules = [./vmspawn-tap/guest.nix];
  };
  system = guest.config.system.build.toplevel;
  image = pkgs.callPackage (pkgs.path + "/nixos/lib/make-ext4-fs.nix") {
    storePaths = [system];
    volumeLabel = "vmspawn-gate";
    populateImageCommands = ''
      mkdir -p ./files/etc
      cp ${system}/etc/os-release ./files/etc/os-release
    '';
  };
  prepare = systemdPackage:
    pkgs.writeShellApplication {
      name = "prepare-vmspawn-gate";
      runtimeInputs = with pkgs; [coreutils e2fsprogs openssh];
      text = lib.replaceStrings ["@image@" "@proxy@"] [
        (lib.escapeShellArg (toString image))
        "${systemdPackage}/lib/systemd/systemd-ssh-proxy"
      ] (builtins.readFile ./vmspawn-tap/prepare.sh);
    };
  start = systemdPackage:
    pkgs.writeShellApplication {
      name = "start-vmspawn-gate";
      runtimeInputs = [systemdPackage pkgs.qemu pkgs.openssh];
      text = ''
        [[ $# == 1 && ($1 == 1234 || $1 == 1235) ]]
        # Record the caller's UID, primary GID and supplementary groups without
        # changing credentials or inspecting SSH key material.
        printf '%s\n' 'vmspawn caller identity:'
        ${pkgs.coreutils}/bin/id
        # Keep QEMU inside this user unit; no machined registration or root scope.
        # No auto-generated SSH key/drop-in: exercise explicit credential transport.
        exec ${systemdPackage}/bin/systemd-vmspawn --user --keep-unit --register=no --no-ask-password \
          --machine="gate-$UID-$1" --image="$STATE_DIRECTORY/root.img" \
          --linux=${system}/kernel --initrd=${system}/initrd --firmware=none \
          --kvm=yes --vsock=yes --vsock-cid="$1" --tpm=no \
          --network-tap --cpus=1 --ram=768M --notify-ready=yes --pass-ssh-key=no \
          --console=read-only --console-transport=serial \
          --load-credential="authorized-keys:$RUNTIME_DIRECTORY/client-key.pub" \
          --load-credential="host-key:$STATE_DIRECTORY/host-key" \
          -- root=LABEL=vmspawn-gate rw init=${system}/init ${lib.escapeShellArgs guest.config.boot.kernelParams}
      '';
    };
  stop = pkgs.writeShellApplication {
    name = "stop-vmspawn-gate";
    runtimeInputs = with pkgs; [coreutils openssh];
    text = ''
      # ExecStop also runs after an unexpected exit. systemd unsets MAINPID
      # when it has reaped vmspawn; leave crash cleanup to the unit's kill mode.
      if [[ -z ''${MAINPID:-} ]]; then
        exit 0
      fi
      timeout --kill-after=1s 10s ssh -nT -F "$RUNTIME_DIRECTORY/connection.conf" \
        drv.run.vmspawn 'systemctl --no-block poweroff'
      # ExecStop must wait: returning immediately would let systemd SIGTERM
      # vmspawn, whose --pass-ssh-key=no fallback SIGKILLs QEMU in 261.2.
      timeout --kill-after=1s 30s tail --pid="$MAINPID" -f /dev/null
    '';
  };
  diagnostics = pkgs.writeShellScript "vmspawn-gate-diagnostics" ''
    ${pkgs.jq}/bin/jq -n \
      --arg result "''${SERVICE_RESULT:-}" --arg code "''${EXIT_CODE:-}" --arg status "''${EXIT_STATUS:-}" \
      '{result: $result, code: $code, status: $status}' > "$STATE_DIRECTORY/exit-status.json"
  '';
  payload = pkgs.writeText "vmspawn-payload" "offline vmspawn egress\n";
  webroot = pkgs.runCommand "vmspawn-webroot" {} ''
    mkdir -p $out
    cp ${payload} $out/payload
  '';
  destinations = ["93.184.216.34" "169.254.169.254" "100.64.0.2" "10.42.0.2" "198.18.0.1"];
in {
  name = "vmspawn-tap";
  qemu.forceAccel = true;
  nodes = {
    host = {config, ...}: {
      imports = [./vmspawn-tap/network.nix];
      virtualisation = {
        memorySize = 6144;
        cores = 2;
        diskSize = 16384;
        qemu.options = ["-cpu" "host"];
      };
      users.users = lib.genAttrs ["operator" "other"] (name: {
        isNormalUser = true;
        uid =
          if name == "operator"
          then 1000
          else 1001;
        group = name;
        extraGroups = ["kvm"];
        linger = true;
      });
      # nsresourced registration requires identical outside UID/GID ranges.
      # vmspawn maps the caller's UID and primary GID to namespace root.
      users.groups = lib.genAttrs ["operator" "other"] (name: {
        gid = config.users.users.${name}.uid;
      });
      # Use upstream noninteractive nsresourced authorization, not a custom grant.
      security.polkit.enable = true;
      services.udev.extraRules = ''KERNEL=="vhost-vsock", GROUP="kvm", MODE="0660"'';
      systemd = {
        # nsresourced requires HAVE_VMLINUX_H, not just generic BPF support.
        # Scope this build to the Host; a global systemd overlay would also
        # affect the kernel's build dependencies.
        package = let
          kernel = config.boot.kernelPackages.kernel;
          vmlinuxHeader =
            pkgs.runCommand "vmspawn-vmlinux.h-${kernel.version}" {
              nativeBuildInputs = [pkgs.bpftools];
            } ''
              mkdir -p "$out"
              # Use the pinned Host kernel ELF, never the build machine's /sys.
              bpftool btf dump file ${kernel.dev}/vmlinux format c > "$out/vmlinux.h"
              test -s "$out/vmlinux.h"
            '';
        in
          (pkgs.systemd.override {withLibBPF = true;}).overrideAttrs (old: {
            mesonFlags =
              old.mesonFlags
              ++ [
                (lib.mesonOption "vmlinux-h" "provided")
                (lib.mesonOption "vmlinux-h-path" "${vmlinuxHeader}/vmlinux.h")
              ];
            # Permit an independent header build before rebuilding systemd.
            passthru = old.passthru // {inherit vmlinuxHeader;};
          });
        additionalUpstreamSystemUnits = ["systemd-nsresourced.service" "systemd-nsresourced.socket"];
        sockets.systemd-nsresourced = {
          overrideStrategy = "asDropin";
          wantedBy = ["sockets.target"];
        };
        # The manager propagates its log level to nsresourcework children.
        services.systemd-nsresourced = {
          overrideStrategy = "asDropin";
          environment.SYSTEMD_LOG_LEVEL = "debug";
        };
        user.services."vmspawn-gate@".environment.SYSTEMD_LOG_LEVEL = "debug";
        user.services."vmspawn-gate@".serviceConfig = {
          Type = "notify";
          ExecStartPre = lib.getExe (prepare config.systemd.package);
          ExecStart = "${lib.getExe (start config.systemd.package)} %i";
          ExecStop = lib.getExe stop;
          ExecStopPost = diagnostics;
          StateDirectory = "vmspawn-gate.%i";
          StateDirectoryMode = "0700";
          RuntimeDirectory = "vmspawn-gate.%i";
          RuntimeDirectoryMode = "0700";
          WorkingDirectory = "%t/vmspawn-gate.%i";
          UMask = "0077";
          # ExecStop requests Guest poweroff and waits for vmspawn to exit.
          # Retain bounded forced cleanup for failed stops and crashed vmspawn.
          KillMode = "mixed";
          Restart = "no";
          TimeoutStartSec = 180;
          TimeoutStopSec = 45;
          StandardInput = "null";
          StandardOutput = "journal";
          StandardError = "journal";
        };
        services.host-listener = {
          wantedBy = ["multi-user.target"];
          serviceConfig.ExecStart = "${pkgs.python3}/bin/python3 -m http.server 8080 --bind 0.0.0.0";
        };
      };
      environment.systemPackages = with pkgs; [curl e2fsprogs iproute2 jq netcat-openbsd openssh procps python3];
      networking.interfaces.eth1.ipv4 = {
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
      assertions = [
        {
          assertion = builtins.elem "bpf" config.security.lsm && config.networking.nftables.enable && !config.networking.nftables.flushRuleset;
          message = "The vmspawn gate requires BPF LSM for nsresourced and must preserve networkd's nftables table.";
        }
      ];
    };
    endpoint = {
      networking = {
        interfaces = {
          eth1.ipv4.addresses = lib.mkForce [
            {
              address = "192.168.1.2";
              prefixLength = 24;
            }
          ];
          lo.ipv4.addresses =
            map (address: {
              inherit address;
              prefixLength = 32;
            })
            destinations;
        };
        firewall = {
          allowedTCPPorts = [53 80];
          allowedUDPPorts = [53];
        };
      };
      environment.systemPackages = [pkgs.netcat-openbsd];
      services = {
        dnsmasq = {
          enable = true;
          resolveLocalQueries = false;
          settings = {
            no-resolv = true;
            no-hosts = true;
            bind-interfaces = true;
            listen-address = ["93.184.216.34" "192.168.1.2"];
            address = "/gate.test/93.184.216.34";
          };
        };
        nginx = {
          enable = true;
          virtualHosts."gate.test" = {
            default = true;
            root = webroot;
            extraConfig = "access_log /var/log/nginx/gate.json gate;";
          };
          commonHttpConfig = ''log_format gate escape=json '{"peer":"$remote_addr"}';'';
        };
      };
      systemd.services.dnsmasq = {
        requires = ["network-addresses-lo.service" "network-addresses-eth1.service"];
        after = ["network-addresses-lo.service" "network-addresses-eth1.service"];
      };
    };
  };
  testScript = {nodes, ...}: ''
    import datetime as dt
    import ipaddress
    import json
    import shlex
    from typing import TypedDict

    Instance = tuple[str, int, int]

    class TunData(TypedDict):
        persist: bool

    class LinkInfo(TypedDict):
        info_data: TunData

    class TapLink(TypedDict):
        ifname: str
        linkinfo: LinkInfo

    instances: list[Instance] = [("operator", 1000, 1234), ("other", 1001, 1235)]

    def runtime(instance: Instance) -> str:
        return f"/run/user/{instance[1]}/vmspawn-gate.{instance[2]}"

    def state(instance: Instance) -> str:
        return f"/home/{instance[0]}/.local/state/vmspawn-gate.{instance[2]}"

    def unit(instance: Instance) -> str:
        return f"vmspawn-gate@{instance[2]}.service"

    def owner_command(instance: Instance, command: str) -> str:
        command = f"export XDG_RUNTIME_DIR=/run/user/{instance[1]}; " + command
        return "su --login " + shlex.quote(instance[0]) + " --command " + shlex.quote(command)

    def owner(instance: Instance, command: str) -> str:
        return host.succeed(owner_command(instance, command))

    def ssh(instance: Instance, command: str) -> str:
        return owner_command(instance, f"ssh -F {runtime(instance)}/connection.conf drv.run.vmspawn " + shlex.quote(command))

    def guest(instance: Instance, command: str) -> str:
        return host.succeed(ssh(instance, "set -eu; " + command))

    def taps() -> list[TapLink]:
        return json.loads(host.succeed("ip -j -d link show type tun"))

    def boot(instance: Instance) -> tuple[str, str, str]:
        owner(instance, f"systemctl --user start {unit(instance)}")
        host.wait_until_succeeds(ssh(instance, "true"), timeout=dt.timedelta(seconds=30))
        guest(instance, "timeout 60 systemctl is-system-running --wait")
        guest(instance, "systemctl is-active --quiet gate-listener.service; nc -z -w 1 127.0.0.1 8080")
        links = [link for link in taps() if int(host.succeed(f"cat /sys/class/net/{link['ifname']}/owner")) == instance[1]]
        t.assertEqual(len(links), 1)
        link = links[0]
        t.assertFalse(link["linkinfo"]["info_data"]["persist"])
        flags = int(host.succeed(f"cat /sys/class/net/{link['ifname']}/tun_flags"), 16)
        t.assertEqual(flags & 0x7103, 0x5002)
        addresses = json.loads(guest(instance, "ip -j -4 address"))
        assigned = [a for i in addresses for a in i["addr_info"] if a["scope"] == "global"]
        t.assertEqual(len(assigned), 1)
        subnet = ipaddress.ip_network(f"{assigned[0]['local']}/{assigned[0]['prefixlen']}", strict=False)
        t.assertEqual(subnet.prefixlen, 28)
        routes = json.loads(guest(instance, "ip -j -4 route show default"))
        t.assertEqual(len(routes), 1)
        host_addresses = json.loads(host.succeed(f"ip -j -4 address show dev {link['ifname']}"))
        t.assertIn(routes[0]["gateway"], [a["local"] for a in host_addresses[0]["addr_info"]])
        endpoint.succeed(f"ip route replace {subnet} via 192.168.1.1")
        return link["ifname"], assigned[0]["local"], routes[0]["gateway"]

    def process_ids(instance: Instance) -> tuple[int, int]:
        main = int(owner(instance, f"systemctl --user show {unit(instance)} -p MainPID --value"))
        host.succeed(f"test /proc/{main}/exe -ef ${nodes.host.systemd.package}/bin/systemd-vmspawn")
        children = [int(pid) for pid in host.succeed(f"cat /proc/{main}/task/{main}/children").split()]
        qemu = [pid for pid in children if host.succeed(f"readlink /proc/{pid}/exe").strip() in [
            "${pkgs.qemu}/bin/qemu-system-x86_64", "${pkgs.qemu}/bin/.qemu-system-x86_64-wrapped"]]
        t.assertEqual(len(qemu), 1)
        for pid in [main, *children]:
            status = dict(line.split(":", 1) for line in host.succeed(f"cat /proc/{pid}/status").splitlines())
            t.assertEqual([int(uid) for uid in status["Uid"].split()], [instance[1]] * 4)
            t.assertEqual([int(gid) for gid in status["Gid"].split()], [instance[1]] * 4)
            t.assertEqual(int(status["CapEff"].strip(), 16), 0)
        return main, qemu[0]

    def egress(instance: Instance) -> None:
        guest(instance, "curl --noproxy '*' -fsS --max-time 10 http://gate.test/payload -o /tmp/fetched")
        # Compare file contents via a checksum, not curl's diagnostic output.
        t.assertEqual(guest(instance, "sha256sum /tmp/fetched").split()[0], host.succeed("sha256sum ${payload}").split()[0])

    def reject(instance: Instance, command: str) -> None:
        # The server and management channel must be live on both sides of a rejection.
        guest(instance, "true")
        host.fail(ssh(instance, command))
        guest(instance, "true")

    def source_drops() -> int:
        rules = json.loads(host.succeed("nft -j list chain inet vmspawn-gate source"))["nftables"]
        return sum(e["counter"]["packets"] for item in rules for e in item.get("rule", {}).get("expr", []) if "counter" in e)

    def stopped(instance: Instance, link: str, pids: tuple[int, int], clean: bool) -> None:
        if clean:
            owner(instance, f"systemctl --user stop {unit(instance)}")
        host.wait_until_succeeds(owner_command(instance, f"test -f {state(instance)}/exit-status.json"), timeout=dt.timedelta(seconds=60))
        result = json.loads(owner(instance, f"cat {state(instance)}/exit-status.json"))
        if clean:
            t.assertEqual(result, {"result": "success", "code": "exited", "status": "0"})
            owner(instance, f"e2fsck -fn {state(instance)}/root.img")
        else:
            t.assertEqual(result["result"], "signal")
            t.assertEqual(result["code"], "killed")
        host.wait_until_succeeds(f"test ! -e /sys/class/net/{link}", timeout=dt.timedelta(seconds=60))
        for pid in pids:
            host.fail(f"test -e /proc/{pid}")
        host.fail(f"test -e {runtime(instance)}")

    start_all()
    host.wait_for_unit("nftables.service")
    host.wait_for_unit("systemd-networkd.service")
    host.wait_for_unit("systemd-nsresourced.socket")
    host.wait_for_unit("host-listener.service")
    endpoint.wait_for_unit("dnsmasq.service")
    endpoint.wait_for_unit("nginx.service")
    for instance in instances:
        host.wait_for_unit(f"user@{instance[1]}.service")
        host.wait_for_unit("default.target", user=instance[0])
        owner(instance, "test -w /dev/kvm && test -w /dev/vhost-vsock")
    try:
        with subtest("two noninteractive user services allocate disjoint ephemeral TAPs"):
            t.assertEqual(taps(), [])
            host.succeed("test -r /sys/kernel/btf/vmlinux")
            # kernel.config exposes only partial metadata for nixpkgs kernels.
            # Check the running Host's active LSMs through securityfs instead.
            host.succeed("python3 -c " + shlex.quote(
                "from pathlib import Path; "
                "assert 'bpf' in Path('/sys/kernel/security/lsm').read_text().strip().split(','), 'BPF LSM is not active'"
            ))
            host.fail("test -e /run/drv.run-network")
            allocated = [boot(instance) for instance in instances]
            pids = [process_ids(instance) for instance in instances]
            t.assertEqual(len(taps()), 2)
            t.assertNotEqual(allocated[0][0], allocated[1][0])
            t.assertNotEqual(ipaddress.ip_network(allocated[0][1] + "/28", strict=False), ipaddress.ip_network(allocated[1][1] + "/28", strict=False))
            host.succeed("systemctl is-active --quiet systemd-nsresourced.service")
            broker = int(host.succeed("systemctl show systemd-nsresourced.service -p MainPID --value"))
            host.succeed(f"test /proc/{broker}/exe -ef ${nodes.host.systemd.package}/lib/systemd/systemd-nsresourced")
            host.succeed("test -d /sys/fs/bpf/systemd/userns-restrict/programs && test -d /sys/fs/bpf/systemd/userns-restrict/maps")
            for index, instance in enumerate(instances):
                foreign = instances[1 - index]
                link = allocated[index][0]
                probe = "import errno,fcntl,os,struct; fd=os.open('/dev/net/tun',os.O_RDWR); "
                probe += f"\ntry: fcntl.ioctl(fd,0x400454ca,struct.pack('16sH',b'{link}',0x5002))\nexcept OSError as e: assert e.errno == errno.EPERM\nelse: raise AssertionError('foreign TAP attachment')"
                owner(foreign, "python3 -c " + shlex.quote(probe))
                # Unlike CH's Unix socket, native VSOCK is not owner-private.
                # Record that boundary difference; do not pretend it is isolated by UID.
                connect = f"import socket; s=socket.socket(socket.AF_VSOCK); s.settimeout(2); s.connect(({instance[2]},22)); s.close()"
                owner(foreign, "python3 -c " + shlex.quote(connect))
                host.fail(owner_command(foreign, f"test -r {runtime(instance)}/client-key"))
                # Give the foreign client only the public host-key pin. Transport
                # access must not authenticate it with its own Guest's client key.
                pin = owner(instance, f"cat {runtime(instance)}/known_hosts").strip()
                owner(foreign, "printf '%s\\n' " + shlex.quote(pin) + f" > {runtime(foreign)}/peer-known-hosts")
                proxy = f"ProxyCommand=${nodes.host.systemd.package}/lib/systemd/systemd-ssh-proxy vsock/{instance[2]} %p"
                wrong = f"ssh -F {runtime(foreign)}/connection.conf -o UserKnownHostsFile={runtime(foreign)}/peer-known-hosts -o "
                host.fail(owner_command(foreign, wrong + shlex.quote(proxy) + " drv.run.vmspawn true"))
                guest(instance, "true")
                egress(instance)
            requests = [json.loads(line) for line in endpoint.succeed("cat /var/log/nginx/gate.json").splitlines()]
            t.assertTrue(requests)
            t.assertEqual({request["peer"] for request in requests}, {"192.168.1.1"})

        with subtest("Host, peer, unsolicited ingress and sensitive destinations are blocked"):
            for index, instance in enumerate(instances):
                link, address, gateway = allocated[index]
                for destination in [gateway, "192.168.1.1", allocated[1 - index][1]]:
                    reject(instance, f"nc -z -w 1 {destination} 8080")
                for destination in ["192.168.1.2", "169.254.169.254", "100.64.0.2", "10.42.0.2", "198.18.0.1"]:
                    reject(instance, f"curl --noproxy '*' -fsS --max-time 1 http://{destination}/payload")
                endpoint.fail(f"nc -z -w 1 {address} 8080")
                host.fail(owner_command(instance, f"nc -z -w 1 {address} 8080"))
                for tcp in [False, True]:
                    query = "import dns.message,dns.query; q=dns.message.make_query('gate.test','A'); "
                    query += f"r=dns.query.{'tcp' if tcp else 'udp'}(q,'192.168.1.2',timeout=3); "
                    query += "assert r.rcode()==0 and r.answer[0][0].address=='93.184.216.34'"
                    guest(instance, "python3 -c " + shlex.quote(query))
                egress(instance)

        with subtest("spoofing is rejected by the dynamic reverse-path policy"):
            instance = instances[0]
            interface = json.loads(guest(instance, "ip -j -4 route show default"))[0]["dev"]
            spoof = "198.19.0.2"
            guest(instance, f"ip address add {spoof}/32 dev {interface}")
            try:
                before = source_drops()
                reject(instance, f"curl --noproxy '*' --interface {spoof} -fsS --max-time 2 http://93.184.216.34/payload")
                t.assertGreater(source_drops(), before)
            finally:
                guest(instance, f"ip address del {spoof}/32 dev {interface}")
            egress(instance)

        with subtest("IPv6 traffic reaches and is rejected by the Host guard"):
            instance = instances[0]
            interface = json.loads(guest(instance, "ip -j -4 route show default"))[0]["dev"]
            link = allocated[0][0]
            # Isolate the nftables guard from an earlier kernel disable_ipv6 drop.
            host_ipv6 = int(host.succeed(f"cat /proc/sys/net/ipv6/conf/{link}/disable_ipv6"))
            guest_ipv6 = int(guest(instance, f"cat /proc/sys/net/ipv6/conf/{interface}/disable_ipv6"))
            host.succeed(f"echo 0 > /proc/sys/net/ipv6/conf/{link}/disable_ipv6")
            guest(instance, f"echo 0 > /proc/sys/net/ipv6/conf/{interface}/disable_ipv6; ip -6 address add fe80::2/64 dev {interface} nodad")
            try:
                before = source_drops()
                packet = "import socket; s=socket.socket(socket.AF_INET6,socket.SOCK_DGRAM); "
                packet += f"s.sendto(b'probe',('ff02::1',9999,0,socket.if_nametoindex('{interface}')))"
                guest(instance, "python3 -c " + shlex.quote(packet))
                host.wait_until_succeeds("nft -j list chain inet vmspawn-gate source | jq -e " + shlex.quote(
                    '[.nftables[] | .rule? // empty | .expr[] | .counter?.packets // 0] | add > ' + str(before)
                ), timeout=dt.timedelta(seconds=10))
            finally:
                guest(instance, f"ip -6 address del fe80::2/64 dev {interface}")
                guest(instance, f"echo {guest_ipv6} > /proc/sys/net/ipv6/conf/{interface}/disable_ipv6")
                host.succeed(f"echo {host_ipv6} > /proc/sys/net/ipv6/conf/{link}/disable_ipv6")
            egress(instance)

        with subtest("nftables reload preserves networkd NAT and isolation"):
            host.succeed("systemctl reload nftables")
            for index, instance in enumerate(instances):
                egress(instance)
                reject(instance, "nc -z -w 1 192.168.1.1 8080")
                reject(instance, f"nc -z -w 1 {allocated[1 - index][1]} 8080")

        with subtest("graceful stop releases only its TAP and preserves its root disk"):
            instance = instances[0]
            boot_id = guest(instance, "cat /proc/sys/kernel/random/boot_id").strip()
            guest(instance, "touch /root/retained")
            stopped(instance, allocated[0][0], pids[0], clean=True)
            t.assertEqual(len(taps()), 1)
            egress(instances[1])
            allocated[0] = boot(instance)
            pids[0] = process_ids(instance)
            t.assertNotEqual(guest(instance, "cat /proc/sys/kernel/random/boot_id").strip(), boot_id)
            guest(instance, "test -f /root/retained")
            egress(instance)

        with subtest("SIGKILL of vmspawn leaves no QEMU or TAP and does not affect its peer"):
            instance = instances[0]
            owner(instance, f"systemctl --user kill --kill-whom=main --signal=KILL {unit(instance)}")
            stopped(instance, allocated[0][0], pids[0], clean=False)
            t.assertEqual(len(taps()), 1)
            egress(instances[1])
            stopped(instances[1], allocated[1][0], pids[1], clean=True)
            t.assertEqual(taps(), [])
    finally:
        for command in [
            "journalctl -b -u 'systemd-nsresource*' --no-pager",
            "journalctl -b -u systemd-networkd --no-pager -n 200",
            "journalctl -b _UID=1000 _UID=1001 --no-pager",
            "ip -j -d link; ip -j -4 route show table all; nft list ruleset",
            *[owner_command(i, f"systemctl --user status {unit(i)} --no-pager; cat {state(i)}/exit-status.json") for i in instances],
        ]:
            status, output = host.execute(command, timeout=dt.timedelta(seconds=10))
            host.log(f"Diagnostics ({command}, exit {status}):\n{output}")
  '';
}

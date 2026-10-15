{
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.services.drv-run.network;
  ipv4 = address: let
    parts = lib.splitString "." address;
  in
    builtins.length parts
    == 4
    && lib.all (part: builtins.match "(0|[1-9][0-9]{0,2})" part != null && lib.toInt part < 256) parts;
  validDNS = address:
    ipv4 address
    && (let
      parts = map lib.toInt (lib.splitString "." address);
      first = builtins.head parts;
    in
      first > 0 && first < 224 && first != 127 && !(first == 169 && builtins.elemAt parts 1 == 254));
  dnsSet = lib.concatStringsSep ", " cfg.dnsServers;
  kernel = config.boot.kernelPackages.kernel;
  vmlinuxHeader =
    pkgs.runCommand "nsresourced-vmlinux.h-${kernel.version}" {
      nativeBuildInputs = [pkgs.bpftools];
    } ''
      mkdir -p "$out"
      bpftool btf dump file ${kernel.dev}/vmlinux format c > "$out/vmlinux.h"
      test -s "$out/vmlinux.h"
    '';
in {
  options.services.drv-run.network = {
    uplink = lib.mkOption {
      type = lib.types.str;
      description = "Host interface permitted for Guest IPv4 egress.";
    };
    dnsServers = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      description = "Upstream IPv4 DNS servers advertised by DHCP and allowed through the egress firewall.";
    };
  };
  config = {
    assertions = [
      {
        assertion = builtins.match "[A-Za-z0-9][A-Za-z0-9_.-]{0,14}" cfg.uplink != null && cfg.uplink != "lo" && !(lib.hasPrefix "ns-" cfg.uplink);
        message = "drv.run requires an explicit uplink outside the ns-* interface namespace.";
      }
      {
        assertion = cfg.dnsServers != [] && lib.all validDNS cfg.dnsServers;
        message = "drv.run requires unicast IPv4 DNS servers outside loopback and link-local ranges.";
      }
      {
        assertion = config.systemd.network.enable && config.networking.nftables.enable && !config.networking.nftables.flushRuleset && config.networking.firewall.enable && config.networking.firewall.filterForward && config.networking.firewall.backend == "nftables";
        message = "drv.run requires networkd and table-scoped nftables updates with forward filtering.";
      }
      {
        assertion = builtins.elem "bpf" config.security.lsm;
        message = "drv.run nsresourced requires BPF LSM.";
      }
      {
        assertion = toString config.boot.kernel.sysctl."net.ipv4.ip_forward" == "1" && toString config.boot.kernel.sysctl."net.ipv4.conf.all.send_redirects" == "0";
        message = "drv.run requires IPv4 forwarding and disabled IPv4 redirects.";
      }
    ];
    boot.kernelModules = ["tun"];
    boot.kernel.sysctl = {
      "net.ipv4.ip_forward" = lib.mkDefault 1;
      "net.ipv4.conf.all.send_redirects" = lib.mkDefault 0;
      "net.ipv4.conf.default.send_redirects" = lib.mkDefault 0;
    };
    security.polkit.enable = true;
    systemd = {
      # nsresourced needs HAVE_VMLINUX_H in addition to generic BPF support.
      # Keep this override Host-local, not in the kernel's package set.
      package = (pkgs.systemd.override {withLibBPF = true;}).overrideAttrs (old: {
        mesonFlags =
          old.mesonFlags
          ++ [
            (lib.mesonOption "vmlinux-h" "provided")
            (lib.mesonOption "vmlinux-h-path" "${vmlinuxHeader}/vmlinux.h")
          ];
      });
      additionalUpstreamSystemUnits = ["systemd-nsresourced.service" "systemd-nsresourced.socket"];
      sockets.systemd-nsresourced = {
        overrideStrategy = "asDropin";
        wantedBy = ["sockets.target"];
      };
      services.systemd-networkd = {
        requires = ["nftables.service"];
        after = ["nftables.service"];
      };
      network = {
        enable = true;
        networks."10-drv-run" = {
          matchConfig = {
            Name = "ns-*";
            Kind = "tun";
          };
          linkConfig.RequiredForOnline = "no";
          networkConfig = {
            Address = "0.0.0.0/28";
            ConfigureWithoutCarrier = true;
            DHCPServer = true;
            IPMasquerade = "ipv4";
            LinkLocalAddressing = "no";
            IPv6AcceptRA = false;
          };
          dhcpServerConfig = {
            EmitDNS = true;
            DNS = cfg.dnsServers;
          };
        };
      };
    };
    networking = {
      useNetworkd = lib.mkDefault true;
      dhcpcd.denyInterfaces = ["ns-*"];
      networkmanager.unmanaged = ["interface-name:ns-*"];
      nftables = {
        enable = lib.mkDefault true;
        tables.drv-run = {
          family = "inet";
          content = ''
            set blocked {
              type ipv4_addr
              flags interval
              auto-merge
              elements = { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8,
                169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24,
                192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24,
                224.0.0.0/4, 240.0.0.0/4 }
            }
            chain source {
              type filter hook prerouting priority raw - 10; policy accept;
              iifname "ns-*" meta nfproto != ipv4 counter drop
              iifname "ns-*" ip saddr 0.0.0.0 ip daddr 255.255.255.255 udp sport 68 udp dport 67 accept
              # Bind sources to the assigned subnet, not a particular DHCP lease.
              iifname "ns-*" fib saddr . iif oif missing counter drop
            }
            chain input {
              type filter hook input priority filter - 10; policy accept;
              iifname "ns-*" udp sport 68 udp dport 67 accept
              iifname "ns-*" ct state { established, related } accept
              iifname "ns-*" counter drop
            }
            chain forward {
              type filter hook forward priority filter - 10; policy accept;
              iifname "ns-*" oifname "ns-*" counter drop
              oifname "ns-*" meta nfproto != ipv4 counter drop
              oifname "ns-*" iifname "${cfg.uplink}" ct state { established, related } accept
              oifname "ns-*" counter drop
              iifname "ns-*" oifname != "${cfg.uplink}" counter drop
              iifname "ns-*" ip daddr { ${dnsSet} } meta l4proto { tcp, udp } th dport 53 accept
              iifname "ns-*" ct state related icmp type { destination-unreachable, time-exceeded, parameter-problem } accept
              iifname "ns-*" ip daddr @blocked counter drop
            }
            chain output {
              type filter hook output priority filter - 10; policy accept;
              oifname "ns-*" udp sport 67 udp dport 68 accept
              oifname "ns-*" ct state { established, related } accept
              oifname "ns-*" counter drop
            }
          '';
        };
      };
      firewall = {
        enable = lib.mkDefault true;
        filterForward = lib.mkDefault true;
        extraInputRules = ''iifname "ns-*" udp sport 68 udp dport 67 accept'';
        extraForwardRules = ''iifname "ns-*" oifname "${cfg.uplink}" accept'';
      };
    };
  };
}

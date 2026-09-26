# Fixture policy, not an adoption of the production TAP pool.
# nsresourced creates ns-* links. Privileged vmspawn creates vt-* links instead.
{lib, ...}: {
  boot.kernelModules = ["tun" "vhost_vsock"];
  boot.kernel.sysctl = {
    "net.ipv4.ip_forward" = 1;
    "net.ipv4.conf.all.send_redirects" = 0;
    "net.ipv4.conf.default.send_redirects" = 0;
  };
  networking = {
    useNetworkd = true;
    nftables = {
      enable = true;
      flushRuleset = false;
      tables.vmspawn-gate = {
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
            # Strict reverse path check ties sources to networkd's dynamic link subnet.
            # This deliberately permits its /28, not exactly one leased /32.
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
            oifname "ns-*" iifname "eth1" ct state { established, related } accept
            oifname "ns-*" counter drop
            iifname "ns-*" oifname != "eth1" counter drop
            iifname "ns-*" ip daddr { 93.184.216.34, 192.168.1.2 } meta l4proto { tcp, udp } th dport 53 accept
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
      enable = true;
      filterForward = true;
      # networkd serves DHCP; DNS is forwarded to the independent endpoint.
      extraInputRules = ''iifname "ns-*" udp sport 68 udp dport 67 accept'';
      allowedTCPPorts = [8080];
      extraForwardRules = ''iifname "ns-*" oifname "eth1" accept'';
    };
  };
  systemd.network.networks."10-vmspawn-gate" = {
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
      DNS = "93.184.216.34";
    };
  };
  # No production pool, manually provisioned TAP, or custom allocation service.
  systemd.network.wait-online.enable = lib.mkForce false;
}

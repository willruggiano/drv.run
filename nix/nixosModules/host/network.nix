# Fixed, root-provisioned transport. Instance owners only attach and lease TAPs.
{
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.services.drv-run.network;
  inherit (lib) mkOption types;
  owners = lib.filterAttrs (_: user: user.enable && user.isNormalUser) config.users.users;
  ownerNames = map (user: user.name) (lib.attrValues owners);
  ipv4 = address: let
    parts = lib.splitString "." address;
  in
    builtins.length parts
    == 4
    && lib.all (part: builtins.match "(0|[1-9][0-9]{0,2})" part != null && lib.toInt part < 256) parts;
  octets = address:
    if ipv4 address
    then map lib.toInt (lib.splitString "." address)
    else [0 0 0 0];
  number = address: lib.foldl' (acc: octet: acc * 256 + octet) 0 (octets address);
  private = address: let
    parts = octets address;
    a = builtins.elemAt parts 0;
    b = builtins.elemAt parts 1;
  in
    a == 10 || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168);
  networkAddress = subnet: builtins.head (lib.splitString "/" subnet);
  validSubnet = subnet: let
    address = networkAddress subnet;
    last = builtins.elemAt (octets address) 3;
  in
    subnet == "${address}/30" && ipv4 address && private address && lib.mod last 4 == 0;
  addressAt = subnet: offset: let
    parts = octets (networkAddress subnet);
  in
    lib.concatStringsSep "." (map toString (lib.take 3 parts ++ [(builtins.elemAt parts 3 + offset)]));
  slots = lib.mapAttrsToList (tap: slot:
    slot
    // {
      inherit tap;
      gateway = addressAt slot.subnet 1;
      guest = addressAt slot.subnet 2;
      prefixLength = 30;
      mac = "02:00:00:00:00:01";
      numQueues = 4;
    })
  cfg.slots;
  subnets = map (slot: slot.subnet) slots;
  validDNS = address: let
    parts = octets address;
    first = builtins.head parts;
  in
    ipv4 address
    && first > 0
    && first < 224
    && first != 127
    && !(first == 169 && builtins.elemAt parts 1 == 254)
    && lib.all (slot: let
      start = number (networkAddress slot.subnet);
      value = number address;
    in
      value < start || value >= start + 4)
    slots;
  data = {
    version = 1;
    inherit (cfg) uplink dnsServers;
    inherit slots;
  };
  generation = builtins.hashString "sha256" (builtins.toJSON data);
  poolConfig = pkgs.writeText "drv-run-network.json" (builtins.toJSON (data // {inherit generation;}));
  pool = pkgs.writeShellApplication {
    name = "drv-run-network";
    runtimeInputs = with pkgs; [coreutils glibc.getent iproute2 jq util-linux];
    text = lib.replaceStrings ["@config@" "@route-check@"] [
      (lib.escapeShellArg (toString poolConfig))
      (lib.escapeShellArg "${./network-routes.jq}")
    ] (builtins.readFile ./network.sh);
  };
  eachSlot = f: lib.concatMapStringsSep "\n" f slots;
  dnsSet = lib.concatStringsSep ", " cfg.dnsServers;
  # nft resolves account names on the Host. Its sandbox has no Host passwd DB.
  # Substitute only these operands, only in the build-time syntax-check copy.
  checkUIDs = lib.concatMapStringsSep "\n" (owner:
    "sed -E -i " + lib.escapeShellArg "s|${lib.escapeRegex "meta skuid ${builtins.toJSON owner}"}|meta skuid 65534|g" + " ruleset.conf")
  ownerNames;
in {
  options.services.drv-run.network = {
    uplink = mkOption {
      type = types.str;
      description = "Explicit IPv4 egress interface; must not be a drv-* pool interface.";
    };
    dnsServers = mkOption {
      type = types.listOf types.str;
      description = "Nonempty list of upstream IPv4 DNS servers, not Host-local or pool addresses.";
    };
    slots = mkOption {
      description = "Stable TAP names mapped to enabled normal Host owners and disjoint RFC1918 /30 networks.";
      type = types.attrsOf (types.submodule {
        options = {
          owner = mkOption {type = types.str;};
          subnet = mkOption {type = types.str;};
        };
      });
    };
  };

  config = {
    assertions = [
      {
        assertion = slots != [] && lib.all (slot: builtins.match "drv-[A-Za-z0-9]{1,11}" slot.tap != null) slots;
        message = "drv.run network requires nonempty slots with TAP names drv- plus 1–11 ASCII alphanumeric characters.";
      }
      {
        assertion =
          lib.all (slot: builtins.elem slot.owner ownerNames) slots
          && lib.all (owner: lib.any (slot: slot.owner == owner) slots) ownerNames;
        message = "drv.run network requires at least one slot per enabled normal Host account, and no slots for other accounts.";
      }
      {
        assertion = lib.all (owner: builtins.match "[A-Za-z_][A-Za-z0-9_.-]*[$]?" owner != null) ownerNames;
        message = "drv.run network requires account names safe for manifest and lease path components.";
      }
      {
        assertion = lib.all (slot: validSubnet slot.subnet) slots && builtins.length (lib.unique subnets) == builtins.length subnets;
        message = "drv.run network requires canonical, disjoint RFC1918 IPv4 /30 subnets.";
      }
      {
        assertion = cfg.dnsServers != [] && lib.all validDNS cfg.dnsServers;
        message = "drv.run network requires upstream unicast IPv4 DNS addresses outside loopback, link-local and pool subnets.";
      }
      {
        assertion =
          builtins.match "[A-Za-z0-9][A-Za-z0-9_.-]{0,14}" cfg.uplink
          != null
          && cfg.uplink != "lo"
          && !(lib.hasPrefix "drv-" cfg.uplink);
        message = "drv.run network requires an explicit, safe uplink interface outside the reserved drv-* namespace.";
      }
      {
        assertion =
          config.networking.nftables.enable
          && !config.networking.nftables.flushRuleset
          && config.networking.firewall.enable
          && config.networking.firewall.backend == "nftables"
          && config.networking.firewall.filterForward;
        message = "drv.run network requires the nftables firewall, forward filtering and table-scoped (not global) ruleset updates.";
      }
      {
        assertion =
          toString config.boot.kernel.sysctl."net.ipv4.ip_forward"
          == "1"
          && toString config.boot.kernel.sysctl."net.ipv4.conf.all.send_redirects" == "0";
        message = "drv.run network requires IPv4 forwarding and disabled global IPv4 redirects.";
      }
    ];

    boot.kernelModules = ["tun"];
    boot.kernel.sysctl = {
      "net.ipv4.ip_forward" = lib.mkDefault 1;
      # Linux combines the all and per-link send_redirects settings with OR.
      "net.ipv4.conf.all.send_redirects" = lib.mkDefault 0;
    };
    networking = {
      nftables = {
        enable = lib.mkDefault true;
        preCheckRuleset = checkUIDs;
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
              ${eachSlot (slot: ''iifname "${slot.tap}" ip saddr ${slot.guest} accept'')}
              iifname "drv-*" counter drop
            }
            chain input {
              type filter hook input priority filter - 10; policy accept;
              iifname "drv-*" ct state { established, related } accept
              iifname "drv-*" counter drop
            }
            chain forward {
              type filter hook forward priority filter - 10; policy accept;
              iifname "drv-*" oifname "drv-*" counter drop
              oifname "drv-*" meta nfproto != ipv4 counter drop
              oifname "drv-*" iifname != "${cfg.uplink}" counter drop
              ${eachSlot (slot: ''oifname "${slot.tap}" ip daddr ${slot.guest} ct state { established, related } accept'')}
              oifname "drv-*" counter drop
              iifname "drv-*" oifname != "${cfg.uplink}" counter drop
              ${eachSlot (slot: ''iifname "drv-*" ip daddr ${slot.subnet} counter drop'')}
              iifname "drv-*" ip daddr { ${dnsSet} } meta l4proto { tcp, udp } th dport 53 accept
              iifname "drv-*" ct state related icmp type { destination-unreachable, time-exceeded, parameter-problem } accept
              iifname "drv-*" ip daddr @blocked counter drop
            }
            chain output {
              type filter hook output priority filter - 10; policy accept;
              ${eachSlot (slot: ''
              oifname "${slot.tap}" ip daddr ${slot.guest} tcp dport 22 meta skuid 0 accept
              oifname "${slot.tap}" ip daddr ${slot.guest} tcp dport 22 meta skuid ${builtins.toJSON slot.owner} accept
              oifname "${slot.tap}" ip daddr ${slot.guest} ct state related icmp type { destination-unreachable, time-exceeded, parameter-problem } accept
            '')}
              oifname "drv-*" counter drop
            }
            chain postrouting {
              type nat hook postrouting priority srcnat; policy accept;
              ${eachSlot (slot: ''oifname "${cfg.uplink}" ip saddr ${slot.guest} masquerade'')}
            }
          '';
        };
      };
      firewall = {
        enable = lib.mkDefault true;
        filterForward = lib.mkDefault true;
        extraForwardRules = eachSlot (slot: ''iifname "${slot.tap}" oifname "${cfg.uplink}" ip saddr ${slot.guest} accept'');
      };
      dhcpcd.denyInterfaces = ["drv-*"];
      networkmanager.unmanaged = ["interface-name:drv-*"];
    };
    systemd.network.networks = lib.mkIf config.systemd.network.enable {
      "00-drv-run-unmanaged" = {
        matchConfig.Name = "drv-*";
        linkConfig.Unmanaged = true;
      };
    };
    environment.etc = lib.genAttrs (map (owner: "drv.run/network/${owner}.json") ownerNames) (path: let
      owner = lib.removeSuffix ".json" (builtins.baseNameOf path);
    in {
      text = builtins.toJSON {
        version = 1;
        inherit generation;
        inherit (cfg) dnsServers;
        slots = lib.filter (slot: slot.owner == owner) slots;
      };
      mode = "0444";
    });
    # Not RuntimeDirectory: a failed maintenance stop must not unlink live locks.
    systemd.tmpfiles.rules = [
      "d /run/drv.run-network 0755 root root -"
      "d /run/drv.run-network/leases 0755 root root -"
    ];
    systemd.services.drv-run-network = {
      description = "drv.run owner-bound routed TAP pool";
      wantedBy = ["multi-user.target"];
      wants = ["network-online.target"];
      requires = ["nftables.service"];
      after = ["nftables.service" "network-online.target" "systemd-sysusers.service" "systemd-tmpfiles-setup.service" "systemd-sysctl.service"];
      # Topology changes require stop (old generation), rebuild, then start.
      restartIfChanged = false;
      stopIfChanged = false;
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        ExecStart = "${lib.getExe pool} start";
        ExecStop = "${lib.getExe pool} stop";
        UMask = "0077";
        TimeoutStartSec = 60;
        TimeoutStopSec = 30;
      };
    };
  };
}

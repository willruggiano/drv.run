{pkgs}: let
  inherit (pkgs) lib;
  base = {
    boot.isContainer = true;
    system.stateVersion = "26.05";
    users.users = {
      operator = {
        isNormalUser = true;
        uid = 1000;
      };
      other.isNormalUser = true;
      disabled = {
        enable = false;
        isNormalUser = true;
      };
      bot = {
        isSystemUser = true;
        group = "nogroup";
      };
    };
    services.drv-run.network = {
      uplink = "eth0";
      dnsServers = ["9.9.9.9"];
      slots = {
        drv-op0 = {
          owner = "operator";
          subnet = "10.231.0.0/30";
        };
        drv-other0 = {
          owner = "other";
          subnet = "10.231.0.4/30";
        };
      };
    };
  };
  evaluate = extra:
    (import (pkgs.path + "/nixos/lib/eval-config.nix") {
      inherit (pkgs.stdenv.hostPlatform) system;
      modules = [../nixosModules/host/network.nix base extra];
    }).config;
  accepted = extra: let
    evaluated = builtins.tryEval (lib.all (entry: entry.assertion) (evaluate extra).assertions);
  in
    evaluated.success && evaluated.value;
  network = changes: {services.drv-run.network = changes;};
  subnet = value: network {slots.drv-op0.subnet = lib.mkForce value;};
  owner = value: network {slots.drv-op0.owner = lib.mkForce value;};
  invalid = [
    (owner "missing")
    (owner "disabled")
    (owner "bot")
    (owner "other")
    (subnet "10.231.0.4/30")
    (subnet "10.231.0.1/30")
    (subnet "10.231.0.0/29")
    (subnet "10.231.256.0/30")
    (subnet "10.231.00.0/30")
    (subnet "10.231.0/30")
    (subnet "93.184.216.0/30")
    (subnet "garbage")
    (network {slots = lib.mkForce {};})
    (network {
      slots."drv-op;drop" = {
        owner = "operator";
        subnet = "10.231.0.8/30";
      };
    })
    (network {
      slots."drv-toolongname00" = {
        owner = "operator";
        subnet = "10.231.0.8/30";
      };
    })
    (network {
      slots."tap0" = {
        owner = "operator";
        subnet = "10.231.0.8/30";
      };
    })
    (network {dnsServers = lib.mkForce [];})
    (network {dnsServers = lib.mkForce ["127.0.0.53"];})
    (network {dnsServers = lib.mkForce ["169.254.169.254"];})
    (network {dnsServers = lib.mkForce ["10.231.0.2"];})
    (network {dnsServers = lib.mkForce ["9.9.9.999"];})
    (network {dnsServers = lib.mkForce ["::1"];})
    (network {uplink = lib.mkForce "drv-op0";})
    (network {uplink = lib.mkForce "eth0; drop";})
    {networking.nftables.enable = false;}
    {networking.nftables.flushRuleset = true;}
    {networking.firewall.enable = false;}
    {networking.firewall.backend = "iptables";}
    {networking.firewall.filterForward = false;}
    {boot.kernel.sysctl."net.ipv4.ip_forward" = 0;}
    {boot.kernel.sysctl."net.ipv4.conf.all.send_redirects" = 1;}
  ];
  valid = evaluate {};
  manifest = builtins.fromJSON valid.environment.etc."drv.run/network/operator.json".text;
in
  assert accepted {};
  assert accepted (subnet "172.31.255.252/30");
  assert accepted (subnet "192.168.100.0/30");
  assert accepted (network {dnsServers = lib.mkForce ["192.168.1.53"];});
  assert lib.all (extra: !(accepted extra)) invalid;
  assert builtins.length manifest.slots == 1;
  assert (builtins.head manifest.slots).guest == "10.231.0.2";
  assert (builtins.head manifest.slots).gateway == "10.231.0.1";
  assert valid.networking.nftables.checkRuleset;
  assert !valid.systemd.services.drv-run-network.restartIfChanged;
  assert !valid.systemd.services.drv-run-network.stopIfChanged;
    pkgs.runCommand "host-network-eval" {nativeBuildInputs = [pkgs.jq pkgs.python3];} ''
      python3 ${./host-network/routes.py} ${../nixosModules/host/network-routes.jq}
      touch $out
    ''

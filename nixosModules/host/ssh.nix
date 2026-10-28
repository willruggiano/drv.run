{
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.services.drv-run.ssh;
  owners =
    lib.mapAttrsToList (name: owner: {
      inherit name;
      uid = config.users.users.${name}.uid;
      prefix = lib.network.ipv6.fromString owner.prefix;
    })
    cfg.owners;
  prefixes = map (owner: "${owner.prefix.address}/64") owners;
  package = pkgs.callPackage ../../packages/ssh-exposure {
    systemd = config.systemd.package;
    owners =
      map (owner: {
        inherit (owner) uid;
        prefix = owner.prefix.address;
      })
      owners;
  };
  prefixSet = lib.concatStringsSep ", " prefixes;
  interfaceSet = lib.concatMapStringsSep ", " builtins.toJSON cfg.interfaces;
in {
  options.services.drv-run.ssh = {
    owners = lib.mkOption {
      default = {};
      description = "Owners whose instances expose SSH through private IPv6 endpoints, using the owner's configured SSH authorized keys.";
      type = lib.types.attrsOf (lib.types.submodule {
        options.prefix = lib.mkOption {
          type = lib.types.str;
          example = "fd42:1234:5678:1::/64";
          description = "Unique ULA /64 routed to this host. The suffix is one plus the ten-digit base-62 instance ID (0-9, A-Z, a-z).";
        };
      });
    };
    interfaces = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [];
      example = ["tailscale0"];
      description = "Host interfaces permitted to reach guest SSH endpoints.";
    };
  };

  config = lib.mkIf (cfg.owners != {}) {
    assertions =
      map (owner: {
        assertion = let
          user = config.users.users.${owner.name};
        in
          user.enable
          && user.isNormalUser
          && owner.uid != null
          && owner.uid > 0
          && (user.openssh.authorizedKeys.keys != [] || user.openssh.authorizedKeys.keyFiles != [])
          && owner.prefix.prefixLength == 64
          && lib.hasPrefix "fd" owner.prefix.address
          && lib.all (part: part == "0") (lib.drop 4 (lib.splitString ":" owner.prefix.address));
        message = "drv.run SSH owners require an enabled normal user with an explicit UID, authorized keys, and a ULA /64 with zero host bits.";
      })
      owners
      ++ [
        {
          assertion =
            builtins.length (lib.unique prefixes)
            == builtins.length prefixes
            && builtins.length (lib.unique (map (owner: owner.uid) owners)) == builtins.length owners;
          message = "drv.run SSH owners must have distinct UIDs and IPv6 prefixes.";
        }
        {
          assertion = cfg.interfaces != [] && lib.all (name: builtins.match "[A-Za-z0-9][A-Za-z0-9_.-]{0,14}" name != null) cfg.interfaces;
          message = "drv.run SSH requires explicit ingress interfaces.";
        }
        {
          assertion =
            config.services.openssh.listenAddresses
            != []
            && lib.all (entry:
              entry.addr
              != null
              && (
                if lib.hasInfix ":" entry.addr
                then (lib.network.ipv6.fromString entry.addr).address != "0:0:0:0:0:0:0:0"
                else true
              ))
            config.services.openssh.listenAddresses;
          message = "Host sshd must bind explicit addresses, not the IPv6 wildcard, when guest SSH exposure is enabled.";
        }
        {
          assertion = lib.toInt (toString config.boot.kernel.sysctl."net.ipv4.ip_unprivileged_port_start") > 22;
          message = "drv.run SSH endpoint isolation requires privileged TCP port 22.";
        }
        {
          assertion = config.networking.firewall.enable && config.networking.nftables.enable && config.networking.firewall.backend == "nftables";
          message = "drv.run SSH requires the nftables firewall.";
        }
      ];

    boot.kernel.sysctl."net.ipv4.ip_unprivileged_port_start" = lib.mkDefault 1024;
    security.wrappers.drv-run-ssh-bind = {
      source = "${package}/bin/drv-run-ssh-bind";
      owner = "root";
      group = "root";
      capabilities = "cap_net_bind_service+ep";
    };
    systemd.network = {
      enable = true;
      networks."10-drv-run-ssh-loopback" = {
        matchConfig.Name = "lo";
        networkConfig.ConfigureWithoutCarrier = true;
        linkConfig.RequiredForOnline = "no";
        routes =
          map (prefix: {
            Destination = prefix;
            Type = "local";
            Table = "local";
          })
          prefixes;
      };
    };
    networking.nftables.tables.drv-run-ssh = {
      family = "inet";
      content = ''
        chain endpoints {
          iifname != { ${interfaceSet} } drop
          tcp dport 22 accept
          meta l4proto ipv6-icmp accept
          drop
        }
        chain input {
          type filter hook input priority filter - 20; policy accept;
          ip6 daddr { ${prefixSet} } jump endpoints
        }
      '';
    };
    networking.firewall.extraInputRules = ''
      iifname { ${interfaceSet} } ip6 daddr { ${prefixSet} } tcp dport 22 accept
    '';
    systemd.user.services = {
      "drv.run@".wants = ["drv-run-ssh@%i.service"];
      "drv-run-ssh@" = {
        description = "SSH exposure for drv.run instance %i";
        restartTriggers = [package];
        bindsTo = ["drv.run@%i.service"];
        after = ["drv.run@%i.service"];
        partOf = ["drv.run@%i.service"];
        unitConfig.ConditionUser = map (owner: "|${owner.name}") owners;
        serviceConfig = {
          Type = "notify";
          NotifyAccess = "main";
          ExecStart = "${config.security.wrapperDir}/drv-run-ssh-bind %i";
          KillMode = "control-group";
          Restart = "on-failure";
          RestartSec = 1;
          TasksMax = 128;
          MemoryMax = "64M";
          UMask = "0077";
          StandardOutput = "journal";
          StandardError = "journal";
        };
      };
    };
  };
}

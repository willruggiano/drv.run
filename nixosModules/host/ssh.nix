{
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.services.drv-run.ssh;
  dnsLabel = "[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?";
  defaultPrefix = name: let
    hex = "fd" + builtins.substring 0 14 (builtins.hashString "sha256" "${cfg.tailscale.domain}/${name}");
  in
    lib.concatMapStringsSep ":" (offset: builtins.substring offset 4 hex) [0 4 8 12] + "::/64";
  owners =
    lib.mapAttrsToList (name: owner: {
      inherit name;
      uid = config.users.users.${name}.uid;
      prefix = lib.network.ipv6.fromString owner.prefix;
    })
    cfg.owners;
  prefixes = map (owner: "${owner.prefix.address}/64") owners;
  advertiseRoutes = "--advertise-routes=${lib.concatStringsSep "," prefixes}";
  package = pkgs.drvr.sshx.override {
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
      type = lib.types.attrsOf (lib.types.submodule ({name, ...}: {
        options.prefix = lib.mkOption {
          type = lib.types.str;
          default = defaultPrefix name;
          defaultText = lib.literalExpression "a private /64 derived from the DNS domain and owner name";
          example = "fd42:1234:5678:1::/64";
          description = "Unique ULA /64 routed to this host. The suffix is the decimal instance ID. Keep the domain and owner name stable to retain automatically derived addresses.";
        };
      }));
    };
    tailscale = {
      enable = lib.mkEnableOption "Tailscale guest SSH routes and synthetic split DNS";
      domain = lib.mkOption {
        type = lib.types.strMatching "${dnsLabel}(\\.${dnsLabel})+";
        default = "${config.networking.hostName}.guests.home.arpa";
        defaultText = lib.literalExpression ''networking.hostName + ".guests.home.arpa"'';
        description = "Deployment-unique split-DNS zone. Configure its restricted nameserver in Tailscale to use this host's Tailscale IP, and approve the advertised routes separately.";
      };
    };
    interfaces = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [];
      example = ["tailscale0"];
      description = "Host interfaces permitted to reach guest SSH endpoints.";
    };
  };

  config = lib.mkMerge [
    (lib.mkIf (cfg.owners != {}) {
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
            && !(lib.hasPrefix "fd7a:115c:a1e0:" owner.prefix.address)
            && lib.all (part: part == "0") (lib.drop 4 (lib.splitString ":" owner.prefix.address));
          message = "drv.run SSH owners require an enabled normal user with an explicit UID, authorized keys, and a ULA /64 with zero host bits outside Tailscale's reserved /48.";
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
      # TODO: is the name here required to match: security.wrappers.<name>?
      security.wrappers."${package.meta.mainProgram}" = {
        source = lib.getExe package;
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
            ExecStart = "${config.security.wrapperDir}/sshx.bind %i";
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
    })
    (lib.mkIf cfg.tailscale.enable {
      assertions = [
        {
          assertion = cfg.owners != {} && lib.all (owner: builtins.match dnsLabel owner.name != null && builtins.stringLength "g-4294967295.${owner.name}.${cfg.tailscale.domain}" <= 253) owners;
          message = "drv.run Tailscale exposure requires owners with DNS-label names and endpoint names no longer than 253 characters.";
        }
        {
          assertion =
            builtins.elem config.services.tailscale.useRoutingFeatures ["server" "both"]
            && lib.all (flags: lib.count (lib.hasPrefix "--advertise-routes") flags == 1) [
              config.services.tailscale.extraUpFlags
              config.services.tailscale.extraSetFlags
            ];
          message = "drv.run Tailscale exposure requires server routing and sole ownership of the advertised route list.";
        }
      ];
      services.drv-run.ssh.interfaces = [config.services.tailscale.interfaceName];
      services.tailscale = {
        enable = true;
        openFirewall = lib.mkDefault true;
        useRoutingFeatures = lib.mkDefault "server";
        # Keep reauthentication and updates consistent: `up` rejects omitted
        # non-default preferences, while `set` updates an already enrolled host.
        extraUpFlags = [advertiseRoutes];
        extraSetFlags = [advertiseRoutes];
      };
      services.dnsmasq = {
        enable = true;
        resolveLocalQueries = false;
        settings = {
          bind-dynamic = true;
          interface = [config.services.tailscale.interfaceName];
          except-interface = ["lo"];
          no-resolv = true;
          no-hosts = true;
          local = ["/${cfg.tailscale.domain}/"];
          synth-domain = map (owner: "${owner.name}.${cfg.tailscale.domain},${owner.prefix.address}/64,g-*") owners;
        };
      };
      networking.firewall.interfaces.${config.services.tailscale.interfaceName} = {
        allowedTCPPorts = [53];
        allowedUDPPorts = [53];
      };
    })
  ];
}

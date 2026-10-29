{pkgs}: let
  inherit (pkgs) lib;
  host = import (pkgs.path + "/nixos/lib/eval-config.nix") {
    system = pkgs.stdenv.hostPlatform.system;
    modules = [
      ../../nixosModules/host/ssh.nix
      {
        nixpkgs.pkgs = pkgs;
        boot.isContainer = true;
        system.stateVersion = "26.11";
        networking.hostName = "dns-test";
        networking.useHostResolvConf = false;
        networking.nftables.enable = true;
        services.openssh.listenAddresses = [{addr = "127.0.0.1";}];
        services.drv-run.ssh = {
          owners = {
            alice = {};
            bob = {};
          };
          tailscale.enable = true;
        };
        users.users = lib.genAttrs ["alice" "bob"] (name: {
          isNormalUser = true;
          uid =
            if name == "alice"
            then 1000
            else 1001;
          openssh.authorizedKeys.keys = [(import (pkgs.path + "/nixos/tests/ssh-keys.nix") pkgs).snakeOilPublicKey];
        });
      }
    ];
  };
  cfg = host.config;
  ssh = cfg.services.drv-run.ssh;
  assertionsPass = configuration: lib.all (entry: entry.assertion) configuration.assertions;
  altered = module: (host.extendModules {modules = [module];}).config;
  loopback = altered {
    services.dnsmasq.settings = {
      interface = lib.mkForce [];
      except-interface = lib.mkForce [];
      bind-dynamic = lib.mkForce false;
      bind-interfaces = true;
      listen-address = "127.0.0.1";
    };
  };
in
  assert assertionsPass cfg;
  assert ssh.owners.alice.prefix != ssh.owners.bob.prefix;
  assert ssh.interfaces == ["tailscale0"];
  assert cfg.services.tailscale.useRoutingFeatures == "server";
  assert cfg.services.tailscale.extraUpFlags == cfg.services.tailscale.extraSetFlags;
  assert cfg.networking.firewall.interfaces.tailscale0.allowedTCPPorts == [53];
  assert cfg.networking.firewall.interfaces.tailscale0.allowedUDPPorts == [53];
  assert cfg.services.dnsmasq.resolveLocalQueries == false;
  assert cfg.services.dnsmasq.settings.interface == ["tailscale0"];
  assert cfg.services.dnsmasq.settings.except-interface == ["lo"];
  assert !(assertionsPass (altered {services.drv-run.ssh.owners.bob.prefix = ssh.owners.alice.prefix;}));
  assert !(assertionsPass (altered {services.drv-run.ssh.owners.alice.prefix = "fd7a:115c:a1e0:1::/64";}));
  assert !(assertionsPass (altered {services.drv-run.ssh.owners = lib.mkForce {};}));
  assert !(assertionsPass (altered {services.tailscale.extraSetFlags = ["--advertise-routes=fd42::/64"];}));
    pkgs.runCommand "ssh-dns" {nativeBuildInputs = [pkgs.dnsmasq pkgs.nodejs pkgs.jq];} ''
      mkdir -p nix/tests nixosModules/host
      cp ${./launcher.test.ts} nix/tests/launcher.test.ts
      cp ${../../nixosModules/host/command.sh} nixosModules/host/command.sh
      cp ${../../nixosModules/timing.sh} nixosModules/timing.sh
      node --test nix/tests/launcher.test.ts
      dnsmasq --test -C ${cfg.services.dnsmasq.configFile}
      node --input-type=module <<'JS'
      import assert from 'node:assert/strict';
      import { spawn } from 'node:child_process';
      import { createSocket } from 'node:dgram';
      import { Resolver } from 'node:dns/promises';
      import { once } from 'node:events';
      import { userInfo } from 'node:os';
      import { setTimeout } from 'node:timers/promises';

      const socket = createSocket('udp4');
      socket.bind(0, '127.0.0.1');
      await once(socket, 'listening');
      const { port } = socket.address();
      socket.close();
      await once(socket, 'close');
      const daemon = spawn('dnsmasq', [
        '--no-daemon', '--conf-file=${loopback.services.dnsmasq.configFile}',
        `--port=''${port}`, '--pid-file=', `--user=''${userInfo().username}`,
      ], { stdio: ['ignore', 'inherit', 'inherit'] });
      const exited = once(daemon, 'exit');
      const resolver = new Resolver({ timeout: 100, tries: 1 });
      resolver.setServers([`127.0.0.1:''${port}`]);
      const domain = ${builtins.toJSON ssh.tailscale.domain};
      const owners = ${builtins.toJSON ssh.owners};
      const canonical = address => new URL(`http://[''${address}]`).hostname;
      try {
        for (let attempt = 0; ; attempt++) {
          try {
            await resolver.resolve6(`g-1.alice.''${domain}`);
            break;
          } catch (error) {
            if (daemon.exitCode !== null || attempt === 30) throw error;
            await setTimeout(20);
          }
        }
        for (const [owner, { prefix }] of Object.entries(owners)) {
          for (const [id, suffix] of [[1, '1'], [11, 'b'], [65536, '1:0'], [4294967295, 'ffff:ffff']]) {
            const name = `g-''${id}.''${owner}.''${domain}`;
            const answers = await resolver.resolve6(name);
            assert.deepEqual(answers.map(canonical), [canonical(prefix.split('/')[0] + suffix)]);
            assert.deepEqual(await resolver.reverse(answers[0]), [name]);
          }
        }
        await assert.rejects(resolver.resolve6(`g-1.missing.''${domain}`), { code: 'ENOTFOUND' });
        await assert.rejects(resolver.resolve4(`g-1.alice.''${domain}`), { code: 'ENODATA' });
        // Synthesis is not an instance registry; no guest service is running here.
      } finally {
        resolver.cancel();
        daemon.kill();
        await exited;
      }
      JS
      touch "$out"
    ''

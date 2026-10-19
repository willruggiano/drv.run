{
  nixosModules,
  pkgs,
}: let
  inherit (pkgs) lib;
  ports = {
    pi = 8080;
    app = 3000;
  };
  shell = pkgs.mkShell {packages = [pkgs.curl];};
  fixture = pkgs.writeText "flake.nix" ''
    {
      inputs.nixpkgs.url = "path:${pkgs.path}";
      outputs = { nixpkgs, ... }: {
        devShells.${pkgs.stdenv.hostPlatform.system}.default =
          let pkgs = nixpkgs.legacyPackages.${pkgs.stdenv.hostPlatform.system}; in pkgs.mkShell {
            packages = [pkgs.curl];
          };
      };
    }
  '';
  server = pkgs.writeText "preview-server.py" ''
    from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
    import sys

    class Handler(SimpleHTTPRequestHandler):
        def end_headers(self):
            self.send_header("X-Request-Target", self.path)
            self.send_header("X-Request-Host", self.headers["Host"])
            super().end_headers()

    ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
  '';
in {
  name = "port-forwarding";
  qemu.forceAccel = true;
  nodes = {
    client = {nodes, ...}: {
      environment.systemPackages = [pkgs.curl pkgs.python3];
      # Wildcard test DNS needs no updates when new Instances/services appear.
      services.dnsmasq = {
        enable = true;
        resolveLocalQueries = true;
        settings = {
          no-resolv = true;
          no-hosts = true;
          address = "/preview.test/${nodes.host.networking.primaryIPAddress}";
        };
      };
    };
    host = {
      imports = [nixosModules.host];
      environment.systemPackages = [pkgs.python3];
      services.drv-run = {
        network = {
          uplink = "eth1";
          dnsServers = ["192.168.1.1"];
        };
        guest.extraModules = [
          ({lib, ...}: {
            services.openssh.settings = {
              DisableForwarding = lib.mkForce false;
              AllowTcpForwarding = "local";
              PermitOpen = lib.concatMapStringsSep " " (port: "127.0.0.1:${toString port}") (builtins.attrValues ports);
              # The local UNIX socket still uses remote TCP forwarding.
              AllowStreamLocalForwarding = false;
              AllowAgentForwarding = false;
              X11Forwarding = false;
              PermitTunnel = false;
            };
            systemd.tmpfiles.rules = map (name: "d /workspace/preview/${name}/nested 0755 root root -") (builtins.attrNames ports);
            systemd.services = lib.mapAttrs' (name: port:
              lib.nameValuePair "preview-${name}" {
                wantedBy = ["multi-user.target"];
                after = ["systemd-tmpfiles-setup.service"];
                serviceConfig = {
                  Type = "exec";
                  WorkingDirectory = "/workspace/preview/${name}";
                  ExecStart = "${pkgs.python3}/bin/python3 ${server} ${toString port}";
                };
              })
            ports;
          })
        ];
      };
      # Keep proxy sockets separate from the owner's private SSH credentials.
      # setgid gives newly created sockets the nginx group, not the owner group.
      systemd.tmpfiles.rules = [
        "d /run/drv-run-http 0755 root root -"
        "d /run/drv-run-http/operator 2750 operator nginx -"
      ];
      services.nginx = {
        enable = true;
        defaultListen = [
          {
            addr = "0.0.0.0";
            port = 8081;
          }
        ];
        virtualHosts = {
          preview = {
            # Validated captures cannot escape the owner-scoped socket directory.
            serverName = ''~^(?<preview_service>[a-z][a-z0-9]*)-(?<preview_instance>[0-9a-f]+)\.preview\.test$'';
            locations."/" = {
              # No URI suffix: retain the original path and query string.
              proxyPass = "http://unix:/run/drv-run-http/operator/$preview_instance-$preview_service.sock:";
              proxyWebsockets = true;
              extraConfig = ''
                proxy_set_header Host $host:$server_port;
                proxy_redirect off;
                proxy_buffering off;
              '';
            };
          };
          default = {
            default = true;
            serverName = "_";
            locations."/".return = "404";
          };
        };
      };
      # Only nginx is public. The test VLAN stands in for the Tailscale interface.
      networking.firewall.interfaces.eth1.allowedTCPPorts = [8081];
      users.users = {
        operator = {
          isNormalUser = true;
          uid = 1000;
          group = "operator";
        };
        observer = {
          isNormalUser = true;
          uid = 1001;
          group = "observer";
        };
      };
      users.groups = {
        operator.gid = 1000;
        observer.gid = 1001;
      };
      virtualisation = {
        memorySize = 10240;
        cores = 2;
        diskSize = 20480;
        qemu.options = ["-cpu" "host"];
        additionalPaths = [shell pkgs.path];
      };
      nix.settings = {
        experimental-features = ["nix-command" "flakes"];
        sandbox = true;
        substituters = lib.mkForce [];
      };
    };
  };
  testScript = ''
    from datetime import timedelta
    import json
    import shlex

    ports: dict[str, int] = json.loads('${builtins.toJSON ports}')
    instances: dict[str, str] = {}
    request_target = "/nested/state.json?value=%2F&other=1"

    def as_operator(command: str):
        return "su --login operator --command " + shlex.quote(
            "export XDG_RUNTIME_DIR=/run/user/1000; " + command
        )

    def operator(command: str):
        return host.succeed(as_operator(command), timeout=timedelta(minutes=15))

    def inventory():
        return set(operator("find /home/operator/.local/state/drv.run -mindepth 1 -maxdepth 1 -type d -printf '%f\\n'").splitlines())

    def guest(name: str, command: str):
        return operator("ssh -T drv.run." + instances[name] + " " + shlex.quote(command))

    def token(name: str):
        # DNS is case-insensitive, but the generated Instance IDs are not.
        return instances[name].encode("ascii").hex()

    def hostname(name: str, service: str):
        return f"{service}-{token(name)}.preview.test"

    def socket_path(name: str, service: str):
        return f"/run/drv-run-http/operator/{token(name)}-{service}.sock"

    def forward_unit(name: str, service: str):
        return f"preview-{token(name)}-{service}.service"

    def expose(name: str, service: str, port: int):
        instance_unit = f"drv.run@{instances[name]}.service"
        # Exercise the proposed expose operation using existing systemd/SSH tools.
        # No proxy config, route registry, port allocator, or production CLI.
        operator(shlex.join([
            "systemd-run", "--user", "--collect", "--unit=" + forward_unit(name, service),
            "--property=Type=exec", "--property=BindsTo=" + instance_unit,
            "--property=After=" + instance_unit,
            "--property=ExecStopPost=${pkgs.coreutils}/bin/rm -f " + socket_path(name, service),
            "${pkgs.openssh}/bin/ssh", "-F", "/etc/ssh/ssh_config", "-NT",
            "-o", "ClearAllForwardings=no", "-o", "ExitOnForwardFailure=yes",
            "-o", "StreamLocalBindMask=0117",
            "-L", f"{socket_path(name, service)}:127.0.0.1:{port}",
            "drv.run." + instances[name],
        ]))
        host.wait_until_succeeds("test -S " + socket_path(name, service))

    def write_revision(name: str, service: str, revision: int):
        payload = {"guest": name, "service": service, "revision": revision}
        guest(name, "printf '%s\\n' " + shlex.quote(json.dumps(payload))
              + f" > /workspace/preview/{service}/nested/state.json")

    def expect_response(
        authority: str, status: int, payload: dict[str, str | int] | None = None,
        *, spoof_host: bool = False,
    ):
        target = f"http://{authority}:8081{request_target}" if spoof_host else request_target
        headers = {"Host": "spoof.invalid:9999"} if spoof_host else {}
        probe = (
            "import http.client, json; "
            f"connection = http.client.HTTPConnection({authority!r}, 8081, timeout=5); "
            f"connection.request('GET', {target!r}, headers={headers!r}); "
            "response = connection.getresponse(); "
            f"assert response.status == {status}, response.status; "
        )
        if payload is not None:
            probe += (
                f"assert response.getheader('X-Request-Target') == {request_target!r}; "
                f"assert response.getheader('X-Request-Host') == {authority.lower() + ':8081'!r}; "
                f"assert json.load(response) == {payload!r}; "
            )
        probe += "connection.close()"
        client.wait_until_succeeds("python3 -c " + shlex.quote(probe))

    def expect_revision(name: str, service: str, revision: int):
        expect_response(hostname(name, service), 200, {"guest": name, "service": service, "revision": revision})

    def nginx_processes():
        main = int(host.succeed("systemctl show -p MainPID --value nginx.service"))
        probe = f"from pathlib import Path; print(Path('/proc/{main}/task/{main}/children').read_text())"
        children = host.succeed("python3 -c " + shlex.quote(probe)).split()
        return {main, *(int(pid) for pid in children)}

    start_all()
    host.wait_for_unit("systemd-networkd.service")
    host.wait_for_unit("user@1000.service")
    host.wait_for_unit("default.target", user="operator")
    host.wait_for_unit("nginx.service")
    client.wait_for_unit("dnsmasq.service")
    expect_response("preview.test", 404)
    original_nginx_processes = nginx_processes()

    with subtest("create two real guests without changing DNS or proxy configuration"):
        operator("mkdir -p /home/operator/flake /home/operator/.local/state/drv.run")
        operator("cp ${fixture} /home/operator/flake/flake.nix")
        operator("nix flake lock --offline path:/home/operator/flake")
        for name in ["alpha", "beta"]:
            before = inventory()
            operator("SSH_ORIGINAL_COMMAND='path:/home/operator/flake true' drv.run </dev/null")
            created = inventory() - before
            t.assertEqual(len(created), 1)
            instances[name] = created.pop()
            for service, port in ports.items():
                write_revision(name, service, 1)
                guest(name, f"curl --fail --silent --show-error --retry 5 --retry-connrefused --retry-delay 1 --max-time 5 http://127.0.0.1:{port}/nested/state.json -o /dev/null")
                expect_response(hostname(name, service), 502)
        t.assertEqual(len(set(instances.values())), 2)

    with subtest("runtime UNIX-socket forwards route to distinct guest loopback services"):
        for name in instances:
            expose(name, "pi", ports["pi"])
            expect_revision(name, "pi", 1)
        expose("alpha", "app", ports["app"])
        expect_revision("alpha", "app", 1)
        expect_response(hostname("beta", "app"), 502)
        expect_response(hostname("alpha", "pi").upper(), 200, {"guest": "alpha", "service": "pi", "revision": 1})
        for port in ports.values():
            host.wait_for_closed_port(port, addr="127.0.0.1")
            client.fail(f"curl --fail --silent --max-time 5 http://host:{port}/")
        t.assertEqual(nginx_processes(), original_nginx_processes)

    with subtest("request-line authority wins over a conflicting Host header"):
        expect_response(
            hostname("alpha", "pi"), 200,
            {"guest": "alpha", "service": "pi", "revision": 1},
            spoof_host=True,
        )

    with subtest("socket permissions allow nginx but reject another host owner"):
        path = socket_path("alpha", "pi")
        operator(f'test "$(stat -c %u {path})" -eq 1000 && test "$(stat -c %a {path})" -eq 660')
        probe = (
            "import socket\n"
            "with socket.socket(socket.AF_UNIX) as connection:\n"
            "    try:\n"
            f"        connection.connect({path!r})\n"
            "    except PermissionError:\n"
            "        pass\n"
            "    else:\n"
            "        raise AssertionError('foreign socket access')\n"
        )
        host.succeed("su --login observer --command " + shlex.quote("python3 -c " + shlex.quote(probe)))
        expect_response("unknown.preview.test", 404)
        expect_response(hostname("alpha", "missing"), 502)

    with subtest("unexpose and re-expose require no proxy reload"):
        operator("systemctl --user stop " + forward_unit("alpha", "app"))
        host.succeed("test ! -e " + socket_path("alpha", "app"))
        expect_response(hostname("alpha", "app"), 502)
        expect_revision("alpha", "pi", 1)
        expect_revision("beta", "pi", 1)
        expose("alpha", "app", ports["app"])
        expect_revision("alpha", "app", 1)
        t.assertEqual(nginx_processes(), original_nginx_processes)

    with subtest("editing and restarting one guest service leaves other exposures intact"):
        write_revision("alpha", "pi", 2)
        expect_revision("alpha", "pi", 2)
        guest("alpha", "systemctl stop preview-pi.service")
        expect_response(hostname("alpha", "pi"), 502)
        expect_revision("alpha", "app", 1)
        expect_revision("beta", "pi", 1)
        operator("systemctl --user is-active --quiet " + forward_unit("alpha", "pi"))
        guest("alpha", "systemctl start preview-pi.service")
        expect_revision("alpha", "pi", 2)

    with subtest("stopping an instance removes its sockets without disrupting another guest"):
        operator(f"systemctl --user stop drv.run@{instances['alpha']}.service")
        for service in ports:
            host.wait_until_fails(as_operator("systemctl --user is-active --quiet " + forward_unit("alpha", service)))
            host.succeed("test ! -e " + socket_path("alpha", service))
            expect_response(hostname("alpha", service), 502)
        expect_revision("beta", "pi", 1)
        operator(f"systemctl --user stop drv.run@{instances['beta']}.service")
        host.wait_until_fails(as_operator("systemctl --user is-active --quiet " + forward_unit("beta", "pi")))
        host.succeed("test ! -e " + socket_path("beta", "pi"))
        expect_response(hostname("beta", "pi"), 502)
        expect_response("preview.test", 404)
        t.assertEqual(nginx_processes(), original_nginx_processes)
  '';
}

{
  nixosModules,
  nixpkgs,
  pkgs,
}: let
  inherit (pkgs) lib;
  shell = pkgs.mkShell {GATE_MARKER = "vsock-provisioned";};
  guest = nixpkgs.lib.nixosSystem {
    inherit (pkgs.stdenv.hostPlatform) system;
    modules = [(import ./cloud-hypervisor-vsock/guest.nix {inherit nixosModules;})];
  };
  runner = guest.config.microvm.declaredRunner;
  prepare = pkgs.writeShellApplication {
    name = "prepare-vsock-gate";
    runtimeInputs = with pkgs; [coreutils e2fsprogs nix openssh];
    text = lib.replaceStrings ["@shell@" "@proxy@"] [
      (lib.escapeShellArg shell.drvPath)
      "${pkgs.systemd}/lib/systemd/systemd-ssh-proxy"
    ] (builtins.readFile ./cloud-hypervisor-vsock/prepare.sh);
  };
  provision = pkgs.writeShellApplication {
    name = "provision-vsock-gate";
    runtimeInputs = with pkgs; [coreutils nix openssh];
    text = ''
      export NIX_SSHOPTS="-F $RUNTIME_DIRECTORY/connection.conf"
      target=drv.run.vsock
      IFS= read -r environment <"$RUNTIME_DIRECTORY/environment-path"
      # Guest PID1 READY=1 precedes ExecStartPost. Still bound SSH/provisioning.
      timeout 30 nix store info --store "ssh-ng://$target"
      if [[ ! -e $STATE_DIRECTORY/provisioned ]]; then
        ssh -F "$RUNTIME_DIRECTORY/connection.conf" "$target" "inspect test ! -e $environment"
      fi
      timeout 120 nix copy --no-check-sigs --to "ssh-ng://$target" "$environment"
      timeout 30 ssh -F "$RUNTIME_DIRECTORY/connection.conf" "$target" root-environment </dev/null
      touch "$STATE_DIRECTORY/provisioned"
      cp "$RUNTIME_DIRECTORY/connection.conf" "$RUNTIME_DIRECTORY/client.conf"
    '';
  };
  diagnostics = pkgs.writeShellScript "vsock-gate-diagnostics" ''
    set -eu
    ${pkgs.jq}/bin/jq -n \
      --arg result "''${SERVICE_RESULT:-}" --arg code "''${EXIT_CODE:-}" --arg status "''${EXIT_STATUS:-}" \
      '{result: $result, code: $code, status: $status}' > "$STATE_DIRECTORY/exit-status.json"
    if test -f "$RUNTIME_DIRECTORY/serial.log"; then
      ${pkgs.coreutils}/bin/tail -c 65536 "$RUNTIME_DIRECTORY/serial.log" > "$STATE_DIRECTORY/serial-tail.log"
    fi
  '';
in {
  name = "cloud-hypervisor-vsock";
  qemu.forceAccel = true;
  nodes.host = {
    virtualisation = {
      memorySize = 6144;
      cores = 2;
      diskSize = 20480;
      qemu.options = ["-cpu" "host"];
      additionalPaths = [shell shell.drvPath];
    };
    users.users = {
      operator = {
        isNormalUser = true;
        uid = 1000;
        extraGroups = ["kvm"];
        linger = true;
      };
      other = {
        isNormalUser = true;
        uid = 1001;
      };
    };
    nix.settings = {
      experimental-features = ["nix-command" "flakes"];
      substituters = lib.mkForce [];
    };
    environment.systemPackages = with pkgs; [curl e2fsprogs iproute2 jq openssh python3 util-linux];
    systemd.user.services.vsock-gate.serviceConfig = {
      Type = "notify";
      NotifyAccess = "all";
      ExecStartPre = lib.getExe prepare;
      ExecStart = "${runner}/bin/microvm-run";
      ExecStartPost = lib.getExe provision;
      ExecStop = "${runner}/bin/microvm-shutdown";
      ExecStopPost = diagnostics;
      StateDirectory = "drv.run-vsock";
      StateDirectoryMode = "0700";
      RuntimeDirectory = "drv.run-vsock";
      RuntimeDirectoryMode = "0700";
      WorkingDirectory = "%t/drv.run-vsock";
      UMask = "0077";
      KillMode = "control-group";
      Restart = "no";
      TimeoutStartSec = 240;
      TimeoutStopSec = 30;
      StandardInput = "null";
      StandardOutput = "journal";
      StandardError = "journal";
    };
  };
  testScript = ''
    import datetime as dt
    import json
    import shlex

    runtime = "/run/user/1000/drv.run-vsock"
    state = "/home/operator/.local/state/drv.run-vsock"
    unit = "vsock-gate.service"

    def as_user(user: str, command: str) -> str:
        return "su --login " + shlex.quote(user) + " --command " + shlex.quote(command)

    def owner_command(command: str) -> str:
        return as_user("operator", "export XDG_RUNTIME_DIR=/run/user/1000; " + command)

    def owner(command: str) -> str:
        return host.succeed(owner_command(command))

    def ssh(command: str) -> str:
        return owner_command(f"ssh -F {runtime}/client.conf drv.run.vsock " + shlex.quote(command))

    def inspect(command: str) -> str:
        return host.succeed(ssh("inspect set -eu; " + command))

    def boot() -> None:
        owner(f"systemctl --user start {unit}")
        inspect("timeout 60 systemctl is-system-running --wait")
        owner(f"test -f {runtime}/client.conf")

    def stop() -> None:
        owner(f"systemctl --user stop {unit}")
        result = json.loads(owner(f"cat {state}/exit-status.json"))
        t.assertEqual(result, {"result": "success", "code": "exited", "status": "0"})
        host.fail(f"test -e {runtime}")
        owner(f"e2fsck -fn {state}/state.img")

    start_all()
    host.wait_for_unit("user@1000.service")
    host.wait_for_unit("default.target", user="operator")
    try:
        with subtest("notify readiness and provisioning work without a Guest NIC"):
            boot()
            pid = int(owner(f"systemctl --user show {unit} -p MainPID --value"))
            status = dict(line.split(":", 1) for line in host.succeed(f"cat /proc/{pid}/status").splitlines())
            t.assertEqual([int(uid) for uid in status["Uid"].split()], [1000] * 4)
            t.assertEqual(int(status["CapEff"].strip(), 16), 0)
            t.assertEqual(host.succeed(f"readlink /proc/{pid}/exe").strip(), "${guest.config.microvm.cloud-hypervisor.package}/bin/cloud-hypervisor")
            info = json.loads(owner(f"curl -fsS --unix-socket {runtime}/control.sock http://localhost/api/v1/vm.info"))
            t.assertFalse(info["config"].get("net"))
            t.assertEqual(info["config"]["vsock"]["cid"], 42)
            interfaces = json.loads(inspect("ip -j link"))
            t.assertEqual([link["ifname"] for link in interfaces], ["lo"])
            t.assertEqual(json.loads(inspect("ip -j -4 route")), [])
            inspect("systemctl is-active --quiet sshd-vsock.socket")
            host.fail(ssh("inspect systemctl is-active --quiet sshd.service"))
            host.log("Guest TCP listeners (processes and socket metadata):\n" + inspect("ss -H -ltnpe"))
            host.log("Guest systemd sockets:\n" + inspect("systemctl list-sockets --all --no-pager --full"))
            t.assertEqual(json.loads(inspect("ss -H -ltn | wc -l")), 0)
            inspect("test -L /run/environment; nix path-info --offline /run/environment")
            owner(f"test -S {runtime}/notify.vsock")
            host.fail(f"test -e {runtime}/ssh.sock || test -e /run/drv.run-network")

        with subtest("per-connection credentials and Unix socket ownership"):
            for path in [runtime, state]:
                t.assertEqual(host.succeed(f"stat -c '%u:%a' {path}").strip(), "1000:700")
            for path in [f"{runtime}/client-key", f"{runtime}/seed.img", f"{state}/host-key"]:
                t.assertEqual(host.succeed(f"stat -c '%u:%a' {path}").strip(), "1000:600")
                host.fail(as_user("other", f"test -r {path}"))
            # Test the transport itself, not failure to read the SSH config.
            probe = "import errno,socket; s=socket.socket(socket.AF_UNIX); "
            probe += f"\ntry: s.connect('{runtime}/notify.vsock')\nexcept OSError as e: assert e.errno == errno.EACCES\nelse: raise AssertionError('foreign socket access')"
            host.succeed(as_user("other", "python3 -c " + shlex.quote(probe)))
            # Compare inside one live SSH session: per-connection credentials
            # disappear when that session exits.
            inspect('found=false; for key in /run/credentials/*/authorized-keys; do '
                    'test -f "$key" || continue; cmp /run/drv-run-seed/authorized-keys "$key"; '
                    'cmp /run/drv-run-seed/host-key "$(dirname "$key")/host-key"; '
                    'found=true; done; "$found"')
            mount = json.loads(inspect("findmnt -J /run/drv-run-seed"))["filesystems"][0]
            t.assertTrue({"ro", "nodev", "nosuid", "noexec"}.issubset(set(mount["options"].split(","))))

        with subtest("wrong host and client keys fail closed"):
            owner(f"ssh-keygen -q -t ed25519 -N \"\" -f {runtime}/unrelated-key")
            owner(f"printf 'drv.run.vsock %s\\n' \"$(ssh-keygen -y -f {runtime}/unrelated-key)\" > {runtime}/wrong-known-hosts")
            host.fail(owner_command(f"ssh -o UserKnownHostsFile={runtime}/wrong-known-hosts -F {runtime}/client.conf drv.run.vsock root-environment"))
            # Avoid additive IdentityFile configuration offering the valid key.
            wrong = f"ssh -F /dev/null -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityAgent=none -o StrictHostKeyChecking=yes -o HostKeyAlias=drv.run.vsock -o UserKnownHostsFile={runtime}/known_hosts -o GlobalKnownHostsFile=/dev/null -o ProxyUseFdpass=yes -o ConnectTimeout=2 -i {runtime}/unrelated-key "
            wrong += "-o " + shlex.quote("ProxyCommand=${pkgs.systemd}/lib/systemd/systemd-ssh-proxy vsock-mux" + runtime + "/notify.vsock %p")
            host.fail(owner_command(wrong + " root@drv.run.vsock root-environment"))
            # A successful authenticated call after the failures rules out a dead server.
            host.succeed(ssh("root-environment"))

        with subtest("the production protocol enters the transferred development environment"):
            command = 'test "$GATE_MARKER" = vsock-provisioned && touch /workspace/entered; exit $?'
            owner("printf '%s\\n' " + shlex.quote(command) + " | ${pkgs.util-linux}/bin/script --quiet --return --command "
                  + shlex.quote(f"ssh -tt -F {runtime}/client.conf drv.run.vsock") + " /dev/null")
            inspect("test -f /workspace/entered; touch /root/discarded; sync")
            host.fail(ssh("unsupported-command"))

        with subtest("clean shutdown preserves state and rotates client authorization"):
            boot_id = inspect("cat /proc/sys/kernel/random/boot_id").strip()
            client_key = owner(f"ssh-keygen -y -f {runtime}/client-key").strip()
            host_key = owner(f"ssh-keygen -y -f {state}/host-key").strip()
            stop()
            boot()
            t.assertNotEqual(inspect("cat /proc/sys/kernel/random/boot_id").strip(), boot_id)
            t.assertNotEqual(owner(f"ssh-keygen -y -f {runtime}/client-key").strip(), client_key)
            t.assertEqual(owner(f"ssh-keygen -y -f {state}/host-key").strip(), host_key)
            inspect("test -f /workspace/entered; test ! -e /root/discarded; test -L /run/environment")
            stop()
    finally:
        for command in [
            owner_command(f"systemctl --user status {unit} --no-pager"),
            "journalctl -b _UID=1000 --no-pager -n 200",
            f"cat {state}/exit-status.json",
            f"tail -c 65536 {runtime}/serial.log {state}/serial-tail.log",
        ]:
            status, output = host.execute(command, timeout=dt.timedelta(seconds=10))
            host.log(f"Diagnostics ({command}, exit {status}):\n{output}")
  '';
}

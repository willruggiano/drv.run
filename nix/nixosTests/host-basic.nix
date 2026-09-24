{
  nixosModules,
  pkgs,
}: let
  shell = pkgs.mkShell {};
  fixture = pkgs.writeText "flake.nix" ''
    {
      inputs.nixpkgs.url = "path:${pkgs.path}";
      outputs = { nixpkgs, ... }: {
        devShells.x86_64-linux.default = nixpkgs.legacyPackages.x86_64-linux.mkShell {};
      };
    }
  '';
in {
  name = "host-basic";
  qemu.forceAccel = true;
  nodes.host = {
    imports = [nixosModules.host];
    virtualisation = {
      memorySize = 6144;
      cores = 2;
      diskSize = 20480;
      qemu.options = ["-cpu" "host"];
      additionalPaths = [shell shell.drvPath pkgs.path];
    };
    users.users.operator = {
      isNormalUser = true;
      uid = 1000;
      extraGroups = ["drvrun" "kvm"];
      linger = true;
    };
    nix = {
      enable = true;
      settings = {
        experimental-features = ["nix-command" "flakes"];
        sandbox = true;
        substituters = pkgs.lib.mkForce [];
      };
    };
  };
  testScript = ''
    import shlex

    def operator(command: str):
        host.succeed("su --login operator --command " + shlex.quote(
            "export XDG_RUNTIME_DIR=/run/user/1000; " + command
        ))

    def guest(command: str):
        operator("printf '%s\\n' " + shlex.quote("set -e; " + command) + " | ssh -T drv.run.test")

    host.start()
    host.wait_for_unit("default.target")

    with subtest("module installation"):
        host.succeed("test -f /etc/systemd/user/drv.run@.service")

    with subtest("eligible operator with no sessions"):
        host.wait_for_unit("user@1000.service")
        host.wait_until_succeeds("test -S /run/user/1000/bus")
        host.wait_for_unit("default.target", user="operator")
        operator("drv.run")
        status, _ = host.systemctl("is-active --quiet 'drv.run@*.service'", user="operator")
        t.assertEqual(status, 4) # no instantiated units match the pattern

    with subtest("declared state survives a fresh Guest boot"):
        host.wait_for_file("/dev/kvm")
        operator("mkdir /home/operator/flake")
        operator("cp ${fixture} /home/operator/flake/flake.nix")
        operator("nix flake lock --offline path:/home/operator/flake")
        operator("mkdir -m 700 /run/user/1000/drv.run.test")
        operator("printf '%s\\n' path:/home/operator/flake > /run/user/1000/drv.run.test/reference")
        operator("systemctl --user start drv.run@test.service")
        guest("systemctl is-system-running --wait || { journalctl -b -u 'persist-*.service' --no-pager; exit 1; }")

        guest("cp /etc/hostname /workspace/retained; touch /root/discarded")
        guest("test -f /root/discarded")
        operator("systemctl --user stop drv.run@test.service")
        operator("${pkgs.e2fsprogs}/bin/e2fsck -fn /home/operator/.local/state/drv.run/test/state.img")
        host.fail("test -e /run/user/1000/drv.run.test")
        operator("systemctl --user start drv.run@test.service")
        guest("systemctl is-system-running --wait || { journalctl -b -u 'persist-*.service' --no-pager; exit 1; }")
        guest("cmp /etc/hostname /workspace/retained; test ! -e /root/discarded")
        operator("systemctl --user stop drv.run@test.service")
        operator("${pkgs.e2fsprogs}/bin/e2fsck -fn /home/operator/.local/state/drv.run/test/state.img")
  '';
}

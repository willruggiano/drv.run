{nixosModules}: {
  name = "host-basic";
  nodes.host = {config, ...}: {
    imports = [nixosModules.host];
    users.users.operator = {
      isNormalUser = true;
      uid = 1000;
      extraGroups = ["drvrun"];
      linger = true;
    };
    nix = {
      enable = true;
      settings = {
        experimental-features = ["nix-command" "flakes"];
        sandbox = true;
      };
    };
  };
  testScript = ''
    host.start()
    host.wait_for_unit("default.target")

    with subtest("module installation"):
        host.succeed("test -f /etc/systemd/user/drv.run@.service")

    with subtest("eligible operator with no sessions"):
        host.wait_for_unit("user@1000.service")
        host.wait_until_succeeds("test -S /run/user/1000/bus")
        host.wait_for_unit("default.target", user="operator")
        host.succeed("su --login operator --command drv.run")
        status, _ = host.systemctl("is-active --quiet 'drv.run@*.service'", user="operator")
        t.assertEqual(status, 4) # no instantiated units match the pattern
  '';
}

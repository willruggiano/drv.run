{port}: {
  lib,
  pkgs,
  ...
}: {
  # FIXME: This does NOT belong in here. We don't have a good place for it right
  # now because it's the first one, but when we do the second one we should invest
  # in better organization of these kinds of non-core things.
  environment = {
    systemPackages = [pkgs.gh];
    sessionVariables.GH_CONFIG_DIR = "/run/drv-run-seed/mitm-proxy/gh";
  };
  programs.git = {
    enable = true;
    config = {
      include.path = "/run/mitm-proxy/gitconfig";
      credential."https://github.com".helper = [
        ""
        # Select the seed at invocation, after nix develop/shellHook. Environment
        # tokens must not override the owner capability.
        "!${lib.getExe' pkgs.coreutils "env"} -u GH_TOKEN -u GITHUB_TOKEN GH_CONFIG_DIR=/run/drv-run-seed/mitm-proxy/gh ${lib.getExe pkgs.gh} auth git-credential"
      ];
    };
  };
  # Sockets must start before basic.target; proxy setup is a normal service
  # ordered after it. Gate SSH sessions, not the listening socket.
  systemd.services."sshd@" = {
    requires = ["mitm-proxy.service"];
    after = ["mitm-proxy.service"];
  };
  systemd.services.mitm-proxy = {
    description = "Configure GitHub credential proxy access";
    wantedBy = ["multi-user.target"];
    wants = ["network-online.target"];
    after = ["network-online.target"];
    unitConfig = {
      RequiresMountsFor = "/run/drv-run-seed";
      ConditionPathExists = "/run/drv-run-seed/mitm-proxy/gh/hosts.yml";
    };
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      RuntimeDirectory = "mitm-proxy";
      RuntimeDirectoryMode = "0700";
      UMask = "0077";
    };
    path = [pkgs.iproute2 pkgs.jq pkgs.git];
    # TODO: is this actually necessary? Can we do this at build time instead via
    # nixos options?
    script = ''
      gateway=$(ip -j -4 route show default | jq -er 'if length == 1 then .[0].gateway else error("expected one default gateway") end')
      git config --file /run/mitm-proxy/gitconfig http.https://github.com/.proxy "http://$gateway:${toString port}"
    '';
  };
}

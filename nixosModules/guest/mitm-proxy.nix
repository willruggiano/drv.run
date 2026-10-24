{port}: {
  config,
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
      credential."https://github.com".helper = [
        ""
        # Select the seed at invocation, after nix develop/shellHook. Environment
        # tokens must not override the owner capability.
        "!${lib.getExe' pkgs.coreutils "env"} -u GH_TOKEN -u GITHUB_TOKEN GH_CONFIG_DIR=/run/drv-run-seed/mitm-proxy/gh ${lib.getExe pkgs.gh} auth git-credential"
      ];
    };
  };
  # systemd-resolved synthesizes _gateway from the guest's default route.
  networking.proxy = {
    httpsProxy = "http://_gateway:${toString port}";
    envVars.HTTPS_PROXY = config.networking.proxy.httpsProxy;
  };
  systemd.globalEnvironment = config.networking.proxy.envVars;
  # Gate SSH sessions, not the VSOCK listening socket, on network readiness.
  systemd.services."sshd@" = {
    wants = ["network-online.target"];
    after = ["network-online.target"];
  };
}

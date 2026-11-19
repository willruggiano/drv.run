{port}: {
  config,
  lib,
  pkgs,
  ...
}: {
  # FIXME: This does NOT belong in here. We don't have a good place for it right
  # now because it's the first one, but when we do the second one we should invest
  # in better organization of these kinds of non-core things.
  environment.systemPackages = [pkgs.gh];
  programs.git = {
    enable = true;
    config = {
      credential."https://github.com".helper = [
        ""
        "!${lib.getExe pkgs.gh} auth git-credential"
      ];
    };
  };
  # systemd-resolved synthesizes _gateway from the guest's default route.
  networking.proxy = {
    httpsProxy = "http://_gateway:${toString port}";
    envVars.HTTPS_PROXY = config.networking.proxy.httpsProxy;
  };
  # Unlike globalEnvironment's generated unit entries, this also covers
  # transient services started with systemd-run.
  systemd.settings.Manager.DefaultEnvironment =
    lib.mapAttrsToList (name: value: "${name}=${lib.escapeShellArg value}")
    config.networking.proxy.envVars;
  # Gate SSH sessions, not the VSOCK listening socket, on network readiness.
  systemd.services."sshd@" = {
    wants = ["network-online.target"];
    after = ["network-online.target"];
  };
}

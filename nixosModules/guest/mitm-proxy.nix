{port}: {
  lib,
  pkgs,
  ...
}: {
  environment.systemPackages = [pkgs.gh];
  programs.git = {
    enable = true;
    config.include.path = "/run/mitm-proxy/gitconfig";
  };
  programs.bash.interactiveShellInit = ''
    if [[ -f /run/drv-run-seed/mitm-proxy/placeholder ]]; then
      GH_TOKEN=$(< /run/drv-run-seed/mitm-proxy/placeholder)
      export GH_TOKEN
    fi
  '';
  # Sockets must start before basic.target; proxy setup is a normal service
  # ordered after it. Gate SSH sessions, not the listening socket.
  systemd.services."sshd@" = {
    requires = ["mitm-proxy.service"];
    after = ["mitm-proxy.service"];
  };
  systemd.services.mitm-proxy = {
    description = "Configure Git credential proxy access";
    wantedBy = ["multi-user.target"];
    wants = ["network-online.target"];
    after = ["network-online.target"];
    unitConfig = {
      RequiresMountsFor = "/run/drv-run-seed";
      ConditionPathExists = "/run/drv-run-seed/mitm-proxy/placeholder";
    };
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      RuntimeDirectory = "mitm-proxy";
      RuntimeDirectoryMode = "0700";
      UMask = "0077";
    };
    path = [pkgs.iproute2 pkgs.jq pkgs.git];
    script = ''
      gateway=$(ip -j -4 route show default | jq -er 'if length == 1 then .[0].gateway else error("expected one default gateway") end')
      git config --file /run/mitm-proxy/gitconfig http.https://github.com/.proxy "http://$gateway:${toString port}"
      git config --file /run/mitm-proxy/gitconfig http.https://github.com/.sslCAInfo /run/drv-run-seed/mitm-proxy/ca.pem
      git config --file /run/mitm-proxy/gitconfig credential.https://github.com.helper ""
      # Read the capability at helper invocation, after nix develop/shellHook.
      # gh still implements the credential protocol; no custom helper protocol.
      git config --file /run/mitm-proxy/gitconfig --add credential.https://github.com.helper '!GH_TOKEN=$(cat /run/drv-run-seed/mitm-proxy/placeholder) ${lib.getExe pkgs.gh} auth git-credential'
    '';
  };
}

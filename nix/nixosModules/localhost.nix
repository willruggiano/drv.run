{config, ...}: {
  programs.ssh.extraConfig = ''
    Match originalhost drv.run command ""
      RequestTTY no

    Host drv.run
      HostKeyAlias ${config.networking.hostName}
      HostName 127.0.0.1
      RequestTTY yes

    Host *
  '';
}

# drv.run / nixosModules / localhost
# -----------------------------------
# Importing this module into a nixosConfiguration that *also* imports
# `nixosModules.host` enables a remote-like experience on a single machine:
#
# Usage:
#   ssh drv.run
#   ssh drv.run <flake ref>
#   ssh drv.run.XXX
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

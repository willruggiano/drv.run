# drv.run / nixosModules / peer local
# -----------------------------------
# Importing this module into a nixosConfiguration that *also* imports
# `nixosModules.host` enables a remote-like experience on a single machine.
#
# Usage:
#   ssh drv.run <flake ref>
#   ssh drv.run.XXX
{config, ...}: {
  programs.ssh.extraConfig = ''
    Match originalhost drv.run command ""
      RequestTTY no

    Match originalhost drv.run
      HostKeyAlias ${config.networking.hostName}
      HostName 127.0.0.1
      RequestTTY yes
      User drvrun

    Match originalhost drv.run.*
      RequestTTY yes

    Match all
  '';
}

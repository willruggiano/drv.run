# drv.run on a Radxa Rock 5b

This is a standalone example flake. It is intended to be a demonstration only,
or at most a single machine drv.run LAN deployment.

```sh
# deploy - the hostname/ip address is hard-coded in ./flake.nix
nix run .#deploy
```

For drv.run access, use the following client configuration:

```sshconfig
Match originalhost drv.run command ""
    RequestTTY no
Host drv.run
    HostKeyAlias drv.run
    HostName <ip address>
Host drv.run.*
    HostKeyAlias drv.run
    HostName <ip address>
    User root
    RequestTTY force
    RemoteCommand su --login <user> --command 'exec ssh -t %n'
```

(note: this is temporary!)

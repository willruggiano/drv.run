# drv.run on a Radxa Rock 5b

This is a standalone example flake. It is intended to be a demonstration only,
or at most a single machine drv.run LAN deployment.

```sh
# deploy - the hostname/ip address is hard-coded in ./flake.nix
nix run .#deploy
```

For drv.run access, use the following client configuration:

```sshconfig
# suppress the "Connection to x.x.x.x closed" message under plain `ssh drv.run`
Match originalhost drv.run command ""
    RequestTTY no

Host drv.run
    HostName <ip address of the rock 5b>
    User me

Host drv.run.*
    ProxyCommand ssh -T drv.run connect %n
    User root
```

(note: this is temporary!)

# drv.run on a Radxa Rock 5b

After installing Nix on the rock5b:

```sh
nix run --no-write-lock-file ./examples/rock5b#deploy <ip address>
```

After that you may `ssh` to the host! For drv.run to work you can use the
following client configuration:

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

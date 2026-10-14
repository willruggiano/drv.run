# drv.run on a Radxa Rock 5b

From the repository root:

```sh
nix run ./examples/rock5b#deploy
```

Deploys to `root@192.168.4.38` using deploy-rs defaults: local builds, live
activation, and automatic rollback. It does not reboot. Uncached aarch64 builds
require a suitable builder or emulation.

SSH uses the ignored runtime files `examples/rock5b/.ssh/id_ed25519` and
`examples/rock5b/.ssh/known_hosts`. Provision the identity and independently
verify the host key before deployment. Host-key checking is strict.

sops-nix uses Rock5B's existing `/etc/ssh/ssh_host_ed25519_key` for age
decryption. No production secrets are declared. `nix develop ./examples/rock5b`
provides `sops`, `age`, and `ssh-to-age`. Before adding secrets, encrypt them
for the verified host-key recipient and an operator recovery recipient. Keep
plaintext and private keys out of Nix inputs. Host-key rotation requires
updating SOPS recipients; system rollback does not restore deleted keys.

Build and validate without deploying:

```sh
nix build ./examples/rock5b#deploy
nix flake check ./examples/rock5b
```

Sources:
[deploy-rs](https://github.com/serokell/deploy-rs/blob/45ba3f8c5cb28396fff71671806e2550b464ac86/README.md),
[sops-nix](https://github.com/Mic92/sops-nix/blob/ee48786c6f9160d2c1a084aac841f68195b8420c/modules/sops/default.nix).

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

<!-- This document is **intentionally** diagram only right now. DO NOT ADD PROSE. -->

# Architecture

## Connection and activation

```text
Client: ssh -t <user>@drv.run <reference>
  |
  v
Host: sshd authenticates an enabled isNormalUser account
  |
  v
Host: launcher (user UID) -> user's systemd manager: drv.run@ID.service
  |                           +-- ExecStartPre:  initialize; prepare credentials
  |                           +-- ExecStart:     pinned QEMU runner
  |                           `-- ExecStartPost: provision; publish client.conf
  |
  `-- exec ssh drv.run.ID -> Guest: /workspace
                                   nix develop -- /run/environment

Client: ssh <user>@drv.run -> Host: list that user's durable Instance SSH targets
Host:   ssh drv.run.ID     -> /run/user/<UID>/drv.run.ID/client.conf
                           -> Guest: reconnect as root

Host: enabled isNormalUser accounts -> lingering + kvm group + SSH launcher
      system accounts               -> existing SSH policy
```

## State lifetime

```text
Host: authenticated Unix account                  Guest
StateDirectory: drv.run/ID [owner-only]
  +-- Flake closure (GC root) --- SSH copy ----> /run/environment
  +-- runner (GC root) ---------- block image -> read-only store
  +-- SSH host key -------------- fw_cfg ------> sshd identity
  `-- state.img ----------------- block disk --> /persist
                                                     |
                                                impermanence
                                                     |
                                                declared retained paths
                                                (/nix, /workspace, ...)

RuntimeDirectory: drv.run.ID [owner-only]       tmpfs /
  bootstrap credentials, sockets, client.conf   undeclared files
  [removed on stop]                             [lost on fresh boot]
```

## Lifecycle

```text
first creation -> capture Flake closure; pin runner; create disk and host key
               -> start and provision Guest

SSH disconnect -> Guest keeps running
stop           -> QMP shutdown request (bounded stop timeout)
               -> remove runtime state; retain durable state
start          -> reuse disk, host key, runner and captured Flake closure
               -> fresh runtime state; boot and provision Guest
Host reboot    -> retain durable state; explicit start required

incomplete creation / missing established disk -> startup fails

clean --what=state (stopped Instance)
  -> delete disk, keys, metadata and GC-root links
  -> Host GC may collect unreferenced closures
```

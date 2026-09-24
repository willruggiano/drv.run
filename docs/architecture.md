<!-- This document is **intentionally** diagram only right now. DO NOT ADD PROSE. -->

# Architecture

## Connection and activation

```text
Client: ssh drv.run <reference>
  |
  v
Host: launcher -> systemctl --user start drv.run@ID.service
  |                +-- ExecStartPre:  initialize once; prepare boot credentials
  |                +-- ExecStart:     pinned QEMU runner
  |                `-- ExecStartPost: wait for SSH; copy and root Flake closure
  |                                  publish client.conf
  |
  `-- exec ssh drv.run.ID -> Guest: /workspace
                                   nix develop -- /run/environment

Client: ssh drv.run    -> Host: list durable Instance SSH targets
Host:   ssh drv.run.ID -> Guest: reconnect to running Instance
```

## State lifetime

```text
Host: owning Unix account                       Guest
StateDirectory: drv.run/ID
  +-- Flake closure (GC root) --- SSH copy ----> /run/environment
  +-- runner (GC root) ---------- block image -> read-only store
  +-- SSH host key -------------- fw_cfg ------> sshd identity
  `-- state.img ----------------- block disk --> /persist
                                                  |
                                             impermanence
                                                  |
                                             declared retained paths
                                             (/nix, /workspace, ...)

RuntimeDirectory: drv.run.ID                     tmpfs /
  bootstrap credentials, sockets, client.conf      undeclared files
  [removed on stop]                               [lost on fresh boot]
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

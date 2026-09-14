# Architecture

```text
ssh drv.run             -> user's drv.run@ instances -> ssh targets

ssh drv.run <reference> -> /run/user/UID/drv.run.ID/reference
                           systemctl --user start drv.run@ID.service
                                |
                                +-- ExecStartPre:  capture environment,
                                |                    generate boot credentials
                                +-- ExecStart:     foreground vm runner
                                +-- ExecStartPost: authenticated readiness,
                                |                    copy, root, verify, publish
                                `-- active
                           exec ssh drv.run.ID

sudo -u drvrun -H ssh drv.run.ID -> reconnect
```

## Preparation and activation

```text
HOST                                         GUEST
nix print-dev-env --json --profile
  +-- evaluate original reference
  +-- native devShell / package fallback
  +-- capture environment without activation
  `-- registered native profile
          |
          +-- environment-path -- fw_cfg --> prepared-path validation
          `-- nix copy --------------------> registered guest store
                                               |
                                         /run/environment root
                                               |
empty ssh command ----------------------> cd /workspace
                                         nix develop -- /run/environment
                                           +-- native activation
                                           +-- shellHook
                                           `-- interactive Bash
```

## Gc and teardown

```text
host gc registration -> runtime environment-N-link -> captured closure

ssh exit/disconnect -> vm and profile remain

stop / vm exit / failure / user-manager shutdown
                        -> terminate cgroup
                        -> ExecStopPost withdraws record and deletes disk
                        -> systemd removes runtime state
next host gc            -> unreferenced closure can be collected
```

---

[`ssh_config(5)`]: `Include`, tokens, first-value precedence
[`systemd.exec(5)`]: directory lifetime [`systemd.service(5)`]: `Type=exec`,
`ExecStartPost`, `ExecStopPost`

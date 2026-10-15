# pi-notify

Send desktop notifications with `notify-send` when Pi needs attention.

```text
agent_settled --+
                +--> enabled? --> notify-send --> session D-Bus
ui_prompt_start-+
```

## Usage

- `/notify on`: enable notifications.
- `/notify off`: disable notifications.
- `/notify`: toggle notifications.

Notifications start enabled. State belongs to the extension runtime, is not
persisted, and resets when the runtime is recreated, including `/reload` and
restart. Invalid arguments leave the state unchanged.

## Behavior

- `agent_settled`: `Ready for input`, including after errors and aborts. This is
  not a success notification.
- `ui_prompt_start`: `Waiting for your response`. Covers blocking extension
  dialogs, including `ask_user`; not only agent-initiated dialogs.
- Both use application name `pi-notify`, title `Pi`, and append the full working
  directory to the body. Directory markup is escaped. Conversation content is
  not included.
- No mode filtering: TUI, RPC, JSON, and print instances can notify when loaded.
- No startup notification, focus detection, delay, or notification on enabling.
- Execution uses an argument array without a shell, a five-second process
  timeout, and no `--wait`. Failures produce a Pi UI warning where UI is
  available; they do not disable notifications or request an agent continuation.

`agent_settled` follows core retries, automatic compaction, and queued
continuations. Extensions can start more work from this event. In particular,
`pi-queued-compact` can cause notifications between its queued actions. This
extension does not coordinate with that queue.

## Runtime dependency

The Nix package installs the extension with an absolute `libnotify` executable
path and is included in `pi-with-extensions`. Loading `index.ts` directly
instead requires `notify-send` on `PATH`.

A session D-Bus connection and notification daemon must be available to the Pi
process. The local `pi-jailed` wrapper already grants access to
`org.freedesktop.Notifications`. Notifications target that bus; this extension
does not forward notifications over SSH to the Client.

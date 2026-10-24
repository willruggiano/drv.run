# Notifications WIP

## Scope and implementation

- Guest prototype is D-Bus-only. OSC observation and terminal reconnect links
  are out of scope. Native Pi API events remain supported; Pi TUI is not
  observed.
- `packages/app/serve/notification-guest.ts`: root session-bus notification
  server, durable SQLite outbox, replacement, expiry, closure and bounded
  queueing.
- `packages/app/serve/notification-relay.ts`: management SSH pull transport,
  host-bound instance/incarnation attribution, durable commit before ACK.
- `packages/app/serve/{activity,notifications,push}.ts`: durable inbox, native
  Pi events, SSE/read state, Web Push encryption, bounded retries and SSRF
  checks.
- Nix modules wire the lingering guest service, runtime incarnation seed,
  selected host owner and runtime VAPID secret path. Secrets never enter the Nix
  store.
- Latest fixes cover shutdown under backpressure, exclusive D-Bus ownership,
  service readiness and duplicate Pi module imports. `REVIEW.md` remains absent.

## Verification

Passed on aarch64:

- `just check` (including Markdown lint).
- `NODE_OPTIONS=--conditions=development node --test "**/*.test.ts"`: 170 tests.
- `NODE_OPTIONS=--conditions=development node --test packages/app/serve/tests/notifications.chromium.ts`:
  two tests.
- `git diff --check`.

Node coverage includes real `dbus-daemon` and detached `notify-send`; the relay
fixture substitutes a Unix socket for SSH. This does not verify deployment.

## Resume outside the coding jail

1. Run Nix evaluation, package build and the focused NixOS integration check:

   ```sh
   nix build -L .#checks.aarch64-linux.notifications-options \
     .#checks.aarch64-linux.app-tests \
     .#checks.aarch64-linux.nixos-notifications
   ```

2. Run `nix flake check -L`. Do not run `nixos-host-basic`.
3. Verify actual host/guest seed and management SSH wiring, then real phone push
   delivery with the deployed HTTPS origin and sops-provided VAPID key.
4. [[docs/notifications.spec.md]] still contains the earlier OSC-heavy design;
   reconcile it with the agreed scope after obtaining approval to edit it.

The Nix checks and real phone delivery have **not** been verified. The new
`tests/nixos/notifications.nix` covers a real user bus, lingering services and
loopback SSH, but not nested microVM creation or the actual seed image.

## Workspace caveat

Development dependencies include ignored symlinks into `/nix/store` and
`.scratch/dbus-deps/node_modules`; they are not portable to a fresh instance.
Restore dependencies through the project's Nix development environment. Ignored
`.scratch/` also contains obsolete Ghostty/zmx research and build files; none of
that packaging is part of this implementation.

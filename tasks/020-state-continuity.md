# What existing state must survive retirement?

- Label: `wayfinder:grilling`
- Mode: HITL
- Status: closed
- Assignee: Pi (state-continuity session)
- Blocked by: none
- Map: [[TASKS.md]]

## Question

For each existing state category, is the requirement continued use, an archive,
explicitly approved disposal, or regeneration/re-enrollment? What interruption
is acceptable during the eventual rock5b cutover?

Distinguish:

- Current PDS conversations from app and durable-api conversation stores.
- OAuth enrollment and refresh tokens from proxy CA material and guest
  capabilities.
- Push subscriptions and VAPID identity from notification history and queued
  notifications, including guest outboxes.
- Application settings from drv.run guest disks and flake environments, which
  must not be implicitly included in an application cleanup.
- Persistent records from work in flight: active agent runs, credential refresh,
  and queued delivery.

Specify the preservation obligation, not a migration algorithm. No live state
inspection, secret disclosure, or destructive action is authorized by this
ticket. A no-backwards-compatibility policy does not answer the data-retention
question.

## Evidence

- [PDS storage entry point](../packages/pds/src/index.ts).
- [App sessions](../packages/app/serve/sessions.ts).
- [API state configuration](../packages/durable/api/src/configuration.ts) and
  [application wiring](../packages/durable/api/src/application.ts).
- [Credential persistence and refresh](../packages/mitm-proxy/auth.py) and
  [proxy preparation](../packages/mitm-proxy/main.py).
- [Notification state](../packages/app/serve/activity.ts),
  [guest notification server](../packages/app/serve/notification-guest.ts), and
  [guest persistence configuration](../nixosModules/guest/notifications.nix).
- [Rock5b secrets and services](../examples/rock5b/flake.nix).

## Resolution

Confirmed by the user in the state-continuity discussion, including the final
separation of deployment inputs from disposable state.

- Keep declarative configuration and externally provisioned secrets as reusable
  deployment inputs, including SOPS-managed proxy CA, VAPID, and API keys. Reuse
  them unless rotation or replacement is explicitly chosen. No additional secret
  backup, migration, or rotation tooling is required.
- No application state needs retention or archives, including current PDS
  conversations, old app/www conversations, and application settings. Do not
  build importers or preserve legacy stores for compatibility.
- Fresh OAuth enrollment during cutover is acceptable; credential-store
  migration is not required.
- Device re-registration, including reinstalling the standalone PWA if
  necessary, is acceptable. Old notification history and pending alerts need not
  survive the maintenance boundary.
- Infrastructure state is disposable. Existing guest disks/workspaces, instance
  identities, and generated runtime/seed material impose no preservation or
  migration requirement on this cleanup.
- Planned application and guest restarts are acceptable. This is a single-user
  project; the operator can finish or cancel active work and coordinate the
  interruption. No zero-downtime, in-flight migration, archive, or hot-rollback
  machinery is required for disposable state.

This is a clean-slate cutover policy, not a request to change normal guest
restart/persistence semantics. It does not initiate any deletion or deployment.
Only code and configuration have been inspected, not live databases or secrets.

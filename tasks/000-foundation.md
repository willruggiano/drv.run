# What foundation are we planning?

- Label: `wayfinder:grilling`
- Mode: HITL
- Status: closed
- Assignee: none
- Blocked by: none
- Map: [[TASKS.md]]

## Question

What ownership, deployment, and scope constraints govern this cleanup?

## Resolution

Confirmed by the user in the architecture discussion preceding map creation and
subsequent ownership revisions, including the answer to selective retention.
These are design decisions, not claims that the current implementation satisfies
them.

- drv.run means the NixOS/microvm/SSH infrastructure only: guest lifecycle,
  isolation, networking, persistence, and flake environments.
- pds means the Datastar coding-agent frontend and its pi-durable harness.
  Retained harness code belongs under pds, not a separate generic durable
  product. PDS owns generic model login/logout UI and host credential storage;
  pi-ai owns the provider-specific authentication lifecycle. This revises the
  earlier assignment of all OAuth ownership to accounts; see
  [[tasks/030-credential-contract.md]].
- Accounts owns non-model upstream OAuth enrollment, credential persistence and
  refresh, and authorized credential access, including GitHub git/gh
  credentials. It is not an application user-login system or PDS's model-auth
  service. Model refresh tokens belong to PDS's shared host credential store,
  not accounts.
- Mitm owns guest-egress proxy policy, credential injection, its CA, and guest
  capabilities; upstream credentials remain outside the guest. It consumes
  accounts rather than owning OAuth lifecycle. The user clarified during the
  credential-contract discussion that host-native PDS/provider traffic need not
  use mitm; this is not a universal host-egress credential-placement policy.
- Push owns notification ingestion, subscriptions, and delivery. `notify-send`
  must work without any coding application. Agent-specific notification
  decisions belong to pds, not push.
- Accounts and push are independently deployable services with their own minimal
  management interfaces. Neither depends on pds or a central settings
  application. Deployment may compose separate application UIs under one origin
  through HTTP routing; this does not make PDS their frontend owner. Accounts
  owns its separate OAuth management page; routes and router software remain
  undecided. See [[tasks/030-credential-contract.md]].
- The host Unix user is the state and OS-level credential ownership boundary.
  The user clarified that application-level HTTP authn/authz is intentionally
  deferred until the system stabilizes. Access is through Tailscale or LAN only;
  nothing is publicly exposed. A management endpoint is bound to configured
  owner state, not an authenticated browser identity: anyone who can reach it
  can operate it. Do not add application authn/authz as a foundation
  requirement. Existing Unix-socket permissions and guest capability checks
  remain in scope.
- Prefer Go for runtime components that do not require direct integration with
  PDS/pi-durable. Accounts is explicitly selected for Go; the proposed
  TypeScript extraction is rejected. This preference does not itself select a
  rewrite of every existing component. Declarative deployment and OAuth
  configuration remain in Nix; see [[tasks/030-credential-contract.md]].
- Each package exports its service modules through `passthru.services`. Modules
  live with the derivation, inline unless a sibling file is warranted. Their
  package references use `finalAttrs.finalPackage` and lexical dependencies.
- True modular services use the service module scope under
  `system.services.<instance>`. Ordinary NixOS modules may configure user
  services. Do not force every service into the modular system-service model.
- Central `nixosModules/` contains drv.run infrastructure, not a module per
  functional component. Rock5b owns reference composition, users, secrets,
  exposure, and deployment-specific wiring. Extract shared integration only when
  an actual second consumer warrants it.
- Keep sshx and tap separate: transport and TAP allocation are different jobs.
- Remove www and the remaining durable namespace, and retire the live app entry
  point once its selected responsibilities have homes. The user clarified the
  distinction between early source cleanup and live retirement in
  [[tasks/060-retirement-gates.md]]. This is a target, not permission to delete
  now.
- Be selective. Establish the foundation before layering on complexity; do not
  port every experimental feature. State and cutover policy belongs in
  [[tasks/020-state-continuity.md]].
- Keep the map and tickets local. Finish decisions before implementation.

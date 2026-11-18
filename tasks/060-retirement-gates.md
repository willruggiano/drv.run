# What must be true before legacy packages can retire?

- Label: `wayfinder:grilling`
- Mode: HITL
- Status: closed
- Assignee: Pi (retirement-gates discussion)
- Blocked by: [[tasks/010-retained-workflows.md]],
  [[tasks/020-state-continuity.md]], [[tasks/030-credential-contract.md]],
  [[tasks/040-notification-contract.md]], [[tasks/050-infrastructure-contract.md]]
- Map: [[TASKS.md]]

## Question

Given the retained workflows, component contracts, and state obligations, what
observable conditions permit removing www, app, and durable without concealing a
remaining dependency or losing required behavior?

Settle:

- The extraction/retirement boundary for each legacy package and the selected
  home for its surviving responsibilities. Include support code, tests, and tools,
  not just executable entry points. Include retiring the custom OpenAI adapter,
  OpenAI token-service API, and PDS token resolver rather than moving them into
  accounts; see [[tasks/030-credential-contract.md]]. Include retiring the legacy
  notification outbox/inbox, replay machinery, agent observation, and TypeScript
  `push-policy` dependency rather than carrying them into Go push; see
  [[tasks/040-notification-contract.md]].
- What each component must demonstrate alone, and what the rock5b composition must
  demonstrate together, including OS-level owner isolation, guest capability
  boundaries, and restart/failure behavior. Application HTTP authn/authz is not a
  retirement gate; preserve the Tailscale/LAN-only exposure boundary in
  [[tasks/000-foundation.md]]. Include PDS model login without accounts/mitm and
  shared `auth.json` interoperability with the Pi CLI, not a pi-coding-agent
  runtime dependency or consumption of its other state. Include accounts' own
  enrollment, reauthorization, and disconnection page working without app or PDS;
  deployment HTTP routing must not conceal an application dependency. Include
  guest `notify-send` and standalone iPhone PWA registration without coding
  applications, persistent device registrations, and endpoint safeguards. Push
  delivery is explicitly best effort; do not require durable notification queues,
  replay, retries, or delivery receipts as retirement gates. Include generic PDS
  execution without drv.run and the optional read-only drv.run environment source
  using owner-scoped CLI inventory; unavailable selections must not fall back to
  local execution. Push inventory consumption must remain independent of PDS.
  Include native OpenSSH configuration, discovery readiness and failures, seed
  failure/restart boundaries, correct service-module import scopes, and prefixed
  HTTP routing with a narrowly scoped push service worker; see
  [[tasks/050-infrastructure-contract.md]].
- Which package, flake, development-shell, formatter/check, generated-context, and
  example references must no longer depend on the legacy applications. Determine
  where surviving shared test/build facilities belong without creating another
  generic application package.
- The reset and re-enrollment boundary established in
  [[tasks/020-state-continuity.md]], including deployment inputs and operator
  coordination. Do not invent data-preservation, archive, or zero-downtime gates
  for state the user has declared disposable.
- What evidence is sufficient to authorize each removal, and which ordering
  constraints follow from actual dependencies rather than an arbitrary rewrite
  sequence.

The answer is a set of retirement gates and proof obligations. Do not create build
steps or run migrations while resolving it. Newly exposed design decisions become
separate tickets; the cleared map hands off to a specification.

## Resolution

Confirmed by the user, with an explicit correction to the scope: only
`packages/app`, the current Tailscale-served entry point, needs live retirement
planning. WWW and durable are early source/build cleanup, not separate retirement
projects. This settles future removal and acceptance conditions; it does not
initiate deletion, deployment, or disposal of live state.

### Early cleanup versus live app retirement

- `packages/www` is unused for the retained workflows and can be deleted at the
  start of implementation. It does not wait for replacement readiness or live
  acceptance. Remove its associated build, export, check, and deployment
  references as cleanup rather than preserving them as compatibility obligations.
- `packages/durable` can be deleted once its surviving assets have been extracted
  into PDS: the required harness code, patches, relevant tests, and the API
  specification the user subsequently selected as PDS's CQRS contract basis.
  [[tasks/070-pds-http-contract.md]] settles that adaptation. Durable does not wait
  for accounts, push, or the app cutover. Upstream `@earendil-works/pi-durable`
  remains a PDS dependency; no standalone local durable product or compatibility
  shim remains.
- `packages/app` carries the live replacement obligations below. Disabling its
  service is not sufficient: retained behavior and surviving dependencies must
  have their selected homes, and the exposed entry point must ultimately serve
  the replacement composition.
- Source/build references between www and durable do not create a live retention
  requirement. Keep cleanup changes self-consistent without imposing app's
  replacement-readiness gates on these unused packages.

### Repository gate for app removal

- Retained responsibilities, necessary patches, and relevant tests have moved to
  their selected owners under [[tasks/000-foundation.md]] and
  [[tasks/010-retained-workflows.md]]. The custom OpenAI adapter/token service,
  legacy notification queues/replay, and TypeScript `push-policy` follow the
  retirement boundaries in [[tasks/030-credential-contract.md]] and
  [[tasks/040-notification-contract.md]], not wholesale extraction.
- Surviving imports, package exports, service configuration, development tooling,
  examples, and generated context no longer depend on retired code. Surviving
  runtime closures exclude its artifacts.
- The repository remains self-contained and buildable. Checks exercise retained
  behavior and its replacements, rather than becoming green merely because the
  old checks were deleted.
- App removal may accompany its replacement in the same change. No compatibility
  shim, dual operation, or fixed rewrite sequence is required. Dependencies, not
  live credentials or access to a phone, determine when source removal is possible.

### Test and development-tool ownership

- Drop app tape, app's renderer benchmark, and app/www-specific Elm tooling with
  their applications rather than extracting replacement products.
- Retain PDS's own fixtures and benchmark and the independent infrastructure
  benchmark. Necessary test helpers move with the component they test; introduce
  shared support only for demonstrated multiple consumers.
- Preserve contract coverage, not every legacy test. Tests requiring durable
  notification replay or request-spanning credential leases do not define the
  replacement contracts.

### Independence and failure evidence

Demonstrate these boundaries, not only an all-services-running happy path:

| Component | Required demonstration |
| --- | --- |
| Bare drv.run | Guest lifecycle, flake environment, and SSH without application services. |
| PDS | Local and ordinary SSH execution, model login, and shared Pi credentials without accounts, mitm, or push; test optional drv.run discovery separately. |
| Accounts | Standalone enrollment, status, reauthorization, disconnect, and owner-local credential access without coding applications or mitm. |
| Mitm | Guest credential injection through accounts, no upstream credentials in guests, and fail-closed substitution failures. |
| Push | Guest `notify-send` and independent registration UI without coding applications, accounts, or mitm. |

Across the composition, verify two distinct Unix owners, unavailable discovery,
missing seed inputs, restart boundaries, prefixed HTTP routing, and service-worker
scope. Apply the already-selected credential, notification, and infrastructure
failure contracts. Do not add application HTTP authentication, notification
durability, or legacy feature parity as gates.

### Repository verification versus deployment acceptance

- Repository verification uses the authoritative Nix checks, package tests, and
  relevant browser tests with deterministic offline fixtures. Prefer focused
  existing tests; do not require the prohibited `nixos-host-basic` run.
- Deployment acceptance requires explicitly authorized rock5b checks of real
  OpenAI login/inference, shared Pi credential interoperability, GitHub enrollment
  and guest git/gh access, and installed-iPhone registration plus notification
  display. The deployed Tailscale-served entry point must use the replacement
  composition rather than the legacy app.
- Source removal need not wait for live credentials or a phone. Rock5b completion
  cannot be claimed until the live acceptance evidence exists. A successful push
  demonstration does not strengthen the best-effort delivery contract.
- Keep the clean-slate cutover in [[tasks/020-state-continuity.md]]: retain
  declarative configuration and provisioned secrets; coordinate interruption and
  re-enrollment with the operator. No migration, archive, or zero-downtime gate.

No implementation or live acceptance check was performed during this discussion.

## Evidence

- [Package graph](../packages/default.nix).
- [API packaging of www](../packages/durable/api/default.nix).
- [PDS packaging of the harness](../packages/pds/default.nix).
- [Legacy app packaging](../packages/app/default.nix).
- [Flake packages, checks, and development environment](../flake.nix).
- [Project checks](../justfile).
- [Rock5b deployment](../examples/rock5b/flake.nix) routes Tailscale Serve to
  `services.pi.port`; the [pi module](../nixosModules/pi.nix) defaults to app.
  The checkout also declares an experimental www/durable-api unit. The user's
  clarification establishes that it has no retained usage; its declaration is
  cleanup, not evidence of a required live workflow.

### Dependency findings for this discussion

These describe the checkout, not new retention requirements or completed gates.

- PDS's package consumes both `durable-harness` and the
  [conversation-context patch](../packages/durable/pi-durable-conversation-context.patch).
  Retiring the local durable namespace must account for both; upstream
  `@earendil-works/pi-durable` remains a selected PDS dependency.
- The API package bundles www, while the
  [www build](../packages/www/default.nix) consumes the API's GraphQL schema.
  These are source/build references to clean up, not live retirement gates.
- [Host composition](../nixosModules/host/default.nix),
  [guest notifications](../nixosModules/guest/notifications.nix), and
  [guest-generated context](../nixosModules/guest/default.nix) retain app coupling.
- The flake's development shell uses `app.nodeModules` and `app.elmHome`; its
  generated context and checks also reference app, www, durable, and tape.
  `just check` and `just chromium` dispatch through app. Removing runtime services
  alone does not remove these development dependencies.
- [App tape](../packages/app/tape/default.nix) is a capture/replay tool packaged
  through app, not an independent test framework. App also owns its renderer
  benchmark. PDS already has [its own fixtures](../packages/pds/tests/fixtures.ts)
  and [benchmark](../packages/pds/src/bench.ts); the separate
  [infrastructure benchmark](../packages/bench/default.nix) does not depend on app.
- Existing notification VM tests assert durable outbox behavior, and mitm auth
  tests exercise request-spanning leases. Those behaviors were not selected for
  the replacement contracts; preserving every legacy test is not equivalent to
  preserving the agreed workflows. See [notification tests][notification-tests]
  and [credential tests][credential-tests].

[notification-tests]: ../tests/nixos/notifications.nix
[credential-tests]: ../packages/mitm-proxy/tests/auth_test.py

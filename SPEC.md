# Independent components

- Label: `ready-for-agent`
- Status: specified; not implemented or deployment-accepted
- Tracker: [[TASKS.md]]
- PDS product contract: [[packages/pds/SPEC.md]]

## Problem Statement

The operator cannot compose guest infrastructure, coding, non-model credentials,
and notifications independently. The live app and unused experiments still own
service wiring, credential flows, tests, and development dependencies. Replacing
one application risks retaining its dependencies or losing a required workflow.

The operator needs the existing selected workflows on rock5b without treating
every experiment, stored record, or old API as a compatibility requirement.

## Solution

Compose independently deployable components around the host Unix owner:

```text
client -- SSH --> drv.run infrastructure --> guest + flake environment

browser -- HTML/forms/Datastar --> PDS --> pi-durable + pi-ai
                                  |         |
                                  |         +--> shared owner Pi credentials
                                  +-- native OpenSSH --> selected environment

browser --> accounts management --> non-model OAuth provider
                    |
                    +--> owner-scoped Unix-domain credential endpoint
                                              ^
guest -- capability-bearing HTTPS --> mitm ----+
                                       +--> upstream credential injection

guest root notify-send --> D-Bus adapter <-- SSH collection -- host push
                                                              |
browser --> standalone registration PWA -----------------------+
                                                              +--> Web Push
```

PDS owns its retained harness and model login. Accounts owns non-model OAuth.
Mitm owns guest-egress policy and injection. Push owns guest notification
collection, delivery, and device registration. Core drv.run owns only guest
infrastructure. Rock5b owns deployment composition, not application behavior.

This specification synthesizes the closed resolutions linked from [[TASKS.md]].
They remain the decision record. PDS's detailed HTTP, observation, execution,
and model-credential contracts have one specification owner:
[[packages/pds/SPEC.md]].

## User Stories

1. As an operator, I want bare drv.run to start guests without application
   services, so that infrastructure has an independent deployment boundary.
2. As a client user, I want SSH access to a guest with its flake environment, so
   that component separation does not remove the project's core workflow.
3. As an operator, I want each package to export its own service modules, so
   that I can compose it without importing another application's configuration.
4. As an operator, I want native NixOS and modular-service import scopes, so
   that configuration errors are caught by the module system.
5. As a host Unix owner, I want my component state and credential access
   isolated by Unix permissions, so that another owner's processes cannot
   consume them.
6. As an operator, I want application access restricted to Tailscale or LAN, so
   that deferred HTTP authentication does not imply public exposure.
7. As an operator, I want the unauthenticated management boundary stated
   plainly, so that I know anyone who can reach an endpoint can operate its
   owner state.
8. As an operator, I want explicit public base URLs and path prefixes, so that
   independently served applications can share routing without sharing
   ownership.
9. As a PDS user, I want local and ordinary SSH coding environments, so that PDS
   works without drv.run, accounts, mitm, or push.
10. As a PDS user, I want separate persisted sessions and native conversations,
    so that independent Harness stores do not collide in browser addressing.
11. As a PDS user, I want HTML commands, reads, and bounded live observation, so
    that the browser is not another conversation database.
12. As a PDS user, I want admission recovery and explicit cancellation, so that
    a lost browser connection does not cause silent duplication or abort
    execution.
13. As a PDS user, I want configuration and environment changes committed
    together, so that execution does not observe a partial selection change.
14. As a PDS user, I want unavailable selections to remain identifiable, so that
    failed discovery never redirects work to the host.
15. As a PDS user, I want generic model login through pi-ai, so that provider
    protocol logic does not become a local accounts or proxy dependency.
16. As a host Unix owner, I want PDS and the Pi CLI to share credentials, so
    that login, logout, and refresh changes are visible without restarting PDS.
17. As a PDS user, I want storage failures and replacement-login outcomes shown
    accurately, so that cancellation or a broken file cannot look like success.
18. As an operator, I want the existing Codex inference and device-login path,
    so that separation does not require switching model-access products.
19. As an operator, I want OAuth registrations declared in Nix, so that the
    deployed registration set is reproducible rather than browser-edited state.
20. As a host Unix owner, I want one credential slot per declared registration,
    so that all my selected consumers share the same enrolled account.
21. As an accounts user, I want an independent enrollment page, so that I can
    manage GitHub access while all coding applications are stopped.
22. As an accounts user, I want the deployed grant's instructions and controls,
    so that enrollment does not silently switch authentication methods.
23. As an accounts user, I want state and PKCE validation on code callbacks, so
    that deferred application authentication does not weaken OAuth correlation.
24. As an accounts user, I want device polling to outlive my browser connection,
    so that closing a tab does not interrupt authorization.
25. As an accounts user, I want repeated starts to show the same pending
    attempt, so that competing tabs cannot replace it silently.
26. As an accounts user, I want bounded attempts that disappear on service
    restart, so that stale callbacks cannot install credentials later.
27. As an accounts user, I want success reported only after durable persistence,
    so that enrollment remains usable after a service restart.
28. As an accounts user, I want reauthorization to preserve the old local
    credential until replacement commits, so that a failed attempt is not
    logout.
29. As an accounts user, I want cancellation to distinguish before and after
    persistence starts, so that the UI does not deny a completed replacement.
30. As an accounts user, I want to authorize a different upstream account into
    the same slot, so that a registration is not an implicit identity pin.
31. As an accounts user, I want credential status separate from attempt status,
    so that a failed replacement does not falsely invalidate an existing token.
32. As an accounts user, I want uncertain token exchanges to require fresh
    enrollment, so that the service does not blindly replay a consumed grant.
33. As a credential consumer, I want a current access-token snapshot before each
    request, so that refresh ownership stays in accounts.
34. As a host Unix owner, I want refresh serialized and replacements durably
    saved before issuance, so that concurrent consumers do not rotate twice.
35. As a credential consumer, I want not-enrolled, unavailable, and
    reauthorization-required distinguished, so that failures are actionable.
36. As an accounts user, I want disconnect to prevent future issuance and late
    credential restoration, so that a pending operation cannot undo disconnect.
37. As an accounts user, I want local disconnect distinguished from upstream
    revocation, so that an unreachable provider does not conceal local removal.
38. As an operator, I want the documented GitHub HTTP-200 error envelope handled
    generically, so that GitHub works without a provider adapter.
39. As a guest user, I want git and gh access without upstream tokens in the
    guest, so that a compromised guest exposes capabilities rather than tokens.
40. As an operator, I want declarative destination and credential-placement
    rules, so that mitm does not own OAuth or provider-specific executable
    policy.
41. As an operator, I want substitution failures to fail closed, so that failed
    accounts access cannot leak capabilities or use another owner's credential.
42. As a guest user, I want unrelated destinations to remain opaque tunnels
    subject to egress restrictions, so that credential injection is narrowly
    scoped.
43. As a guest root user, I want notify-send without any coding application, so
    that notifications remain an independent utility.
44. As an operator, I want the guest adapter not to displace another
    notification server, so that D-Bus ownership conflicts fail visibly.
45. As a host Unix owner, I want the host to bind guest sources to my devices,
    so that a guest cannot select another owner or recipient.
46. As a notification producer, I want local acceptance distinguished from phone
    display, so that best-effort forwarding is not mistaken for delivery
    receipt.
47. As an operator, I want drops under disconnection or overload rather than
    durable catch-up, so that notification infrastructure stays bounded.
48. As a notification recipient, I want persistent device registrations, so that
    ordinary push-service restarts do not require re-registration.
49. As an iPhone user, I want a standalone installed registration PWA, so that
    receiving notifications does not require PDS to be open or installed.
50. As a notification recipient, I want taps to open the registration page, so
    that guest content cannot choose arbitrary navigation.
51. As a notification producer, I want replacement, expiry, and closure to have
    explicit limits, so that local lifecycle does not imply phone retraction.
52. As an operator, I want push destinations checked at registration and send,
    so that subscriptions cannot become an SSRF or redirect bypass.
53. As an operator, I want read-only machine-readable owner inventory, so that
    PDS and push do not parse human output or reconstruct private runtime paths.
54. As a PDS user, I want ready instances distinguished from retained instances,
    so that a stopped or provisioning guest is not offered as ready.
55. As a PDS user, I want a failed discovery source distinguished from an empty
    source, so that other selectable environments remain usable.
56. As an operator, I want SSH connection and trust settings resolved by
    OpenSSH, so that applications need only an SSH host name.
57. As an operator, I want generic owner-scoped seed-file inputs, so that core
    drv.run copies data without knowing component-specific formats.
58. As an operator, I want missing seed inputs to stop startup, so that a guest
    cannot start with silently incomplete security configuration.
59. As an operator, I want seed snapshots applied on explicit guest restart, so
    that editing an input cannot unexpectedly mutate a running guest.
60. As a maintainer, I want unused www removed independently of live acceptance,
    so that dead experiments do not prolong the app replacement.
61. As a maintainer, I want surviving durable assets owned by PDS, so that a
    second local generic harness product is unnecessary.
62. As a maintainer, I want replacement contract coverage before app removal, so
    that deleting old checks alone cannot make retirement appear complete.
63. As a maintainer, I want closures, development tools, examples, and generated
    context free of retired dependencies, so that removal is more than disabling
    an executable.
64. As an operator, I want reusable declarations and provisioned secrets
    retained across clean-slate cutover, so that disposable state does not imply
    rotation.
65. As an operator, I want planned interruption and re-enrollment rather than
    migration machinery, so that cutover matches this single-user deployment.
66. As an operator, I want repository verification separated from authorized
    live acceptance, so that offline fixtures are not presented as provider or
    installed-iPhone verification.

## Implementation Decisions

### Ownership and composition

- Follow the foundation and retained-workflow resolutions. Core owns guest
  lifecycle, isolation, networking, persistence, SSH, and flake environments.
  Keep sshx transport separate from TAP allocation.
- PDS owns the coding frontend, retained harness code and patches, and generic
  model-credential integration. Upstream pi-durable remains a dependency; no
  standalone local durable product remains.
- Accounts and both push processes use Go. Keep the existing mitm implementation
  unless a required contract forces a change; the Go preference does not select
  a proxy rewrite. Neither accounts nor push depends on Pi or a coding frontend.
- The host Unix user is the state boundary. Use one owner-bound instance of each
  user service, separate owner state, and explicit Unix permissions. The shared
  mitm service receives access only to configured owners' credential endpoints.
- HTTP management is not authenticated by browser identity. Anyone who reaches a
  management endpoint can operate its configured owner. Bind listeners and route
  them only within the selected Tailscale/LAN boundary. Do not introduce public
  exposure, an authentication gateway, or a new identity platform.
- PDS's operation surface, model credentials, and execution selection are
  specified by the PDS product contract linked above, not by the old JSON or
  GraphQL implementations.

### Accounts configuration and public boundaries

- A Nix declaration supplies a stable registration ID and label, exactly one
  enrollment method, client ID, scopes, OAuth endpoints, client-authentication
  method, and references to any provisioned client secrets. Supported methods
  are authorization-code with S256 PKCE and device authorization, with refresh.
- Support public-client authentication, client-secret Basic, and client-secret
  form authentication as explicit configuration. Do not auto-probe or switch
  authentication style after failure. Do not configure executable callbacks,
  user-info lookups, JWT interpretation, or token-prefix checks.
- Adding or changing declarations requires deployment. Enrollment, replacement,
  refresh, cancellation, and disconnect mutate owner-local runtime state, not
  Nix. A configured registration holds at most one enrolled upstream account.
- The accounts service serves its own minimal management page, preferably using
  Datastar. It lists configured registrations and displays credential status and
  enrollment-attempt status independently. It provides start/resume-view,
  cancellation, callback, reauthorization, and disconnect controls. It does not
  expose raw token responses or registration CRUD.
- Separate the management listener from the credential listener. The latter is
  HTTP over an owner-scoped Unix-domain socket, not a TCP API, browser route, or
  guest interface. The socket selects the owner; callers cannot select a
  different owner in a request. Deployment supplies its location and grants the
  mitm service the required filesystem access.
- Specify credential retrieval as `POST /registrations/{registrationId}/token`
  on that socket. There is no request body. Success is HTTP 200 JSON containing
  `access_token`, `token_type`, and, when provided by the grant, `expires_at`
  expressed as Unix seconds. Retain only access-token metadata needed by the
  consumer; never return refresh tokens or raw provider response objects.
- Unknown registrations return 404. Not-enrolled and reauthorization-required
  return 409 with distinct stable `error` codes `not_enrolled` and
  `reauthorization_required`. Temporary dependency or storage failure returns
  503 with `unavailable`; it does not supply a token. Invalid requests return
  400, unsupported methods 405, and unexpected failures a sanitized 500. All
  credential responses use `Cache-Control: no-store`; do not emit credentials in
  diagnostics or automatic request logs.
- Retrieve a snapshot before each credentialed upstream request. No lease, lock,
  credential cache extending authorization, or revocation guarantee spans that
  request. Already-issued bearer tokens can outlive disconnect or become invalid
  during upstream rotation.

### Accounts enrollment and persistence

- Allow one in-memory attempt per owner/registration. Repeated starts return the
  current attempt rather than replacing it. A replacement attempt leaves the
  current credential available under normal expiry/refresh rules.
- Code enrollment generates and validates state and PKCE and uses the configured
  callback under the accounts public base URL. Device enrollment displays the
  verification URI, user code, and expiry while accounts polls independently of
  browser connections. Do not transfer device codes or verifier material into
  browser-owned persistence.
- Bound attempt lifetime and provider calls. Browser disconnection does not
  cancel an attempt. Reconnection reads its current state. Restart abandons
  attempts, not persisted credentials. Cancelled, expired, and abandoned
  callbacks cannot install credentials.
- Credential replacement is atomic and durable before success is observable.
  Cancellation before persistence begins prevents replacement. Once persistence
  begins, wait for and report its outcome; removing a saved replacement requires
  disconnect. Failed replacement leaves the previous local record unchanged,
  without promising its upstream validity.
- Registration identity is not upstream-account identity. Successful replacement
  may authorize another upstream account. Display the configured label; do not
  require profile retrieval or a same-user assertion.
- Serialize refresh, replacement, and disconnect for each owner/registration.
  Persist a refresh-in-progress state before a possibly consuming exchange;
  atomically replace it with returned credentials before issuance. After
  restart, an unresolved refresh cannot be retried using the old refresh token.
  This is credential lifecycle state, not a durable enrollment queue.
- A failure proven to precede submission of a refresh request may remain
  temporarily unavailable. A lost/ambiguous response, terminal OAuth failure, or
  inability to durably save a returned replacement requires reauthorization and
  blocks issuance. Never substitute another registration, ambient credential, or
  stale cached token.
- A consumer disconnect does not discard an already-started rotating refresh.
  Complete the bounded refresh/persistence operation or retain the fail-closed
  state. Local disconnect prevents new issuance immediately and coordinates with
  outstanding persistence so late results cannot restore the credential.
- Disconnect cancels enrollment and removes local issuance authority. If a
  standard revocation endpoint is configured, make a bounded revocation attempt;
  failure does not block local disconnect. Show local removal and confirmed
  upstream revocation separately.
- After a lost management response, read attempt and credential state. Never
  automatically replay a code exchange or start a replacement attempt. A
  rejected or expired attempt offers explicit fresh enrollment. An uncertain
  exchange ends as unconfirmed and requires fresh enrollment.

### Go OAuth integration

- Select `golang.org/x/oauth2` v0.35.0 for standard code/PKCE, device-token
  polling, and refresh operations. This is a specification-level dependency
  selection, not a change to dependencies or a claim of runtime compatibility.
  Pin it during implementation and verify it through the accepted accounts
  interfaces.
- Accounts retains ownership of lifecycle, persistence, and issuance. Do not
  hand consumers an auto-refreshing OAuth HTTP client. Any library token-source
  use is contained within accounts' serialized refresh transaction, with one
  bounded refresh exchange and persistence before publication.
- Supply an accounts-owned HTTP client with verified TLS, deadlines, redirects
  disabled, explicit JSON negotiation, bounded response bodies, and no implicit
  environment-proxy behavior. No generic retry wrapper may replay token
  requests.
- Use the library's grant implementations and parsing, adding small, tested
  guards only for demonstrated gaps. Successful tokens require standard typed
  fields, a supported Bearer token type, and valid expiry/scope/refresh fields
  when supplied. Preserve standard semantics when a refresh response omits the
  refresh token. Do not reject harmless provider extension fields, require
  GitHub token prefixes, or interpret extra fields as executable policy.
- Only a configured token endpoint's unambiguous JSON OAuth error may use the
  approved HTTP-200 compatibility. Reject malformed or ambiguous envelopes and
  mixed success/error objects before they can be treated as tokens or pollable
  errors. The library already recognizes HTTP-200 errors; no GitHub adapter or
  status-rewriting workaround is needed. Only `authorization_pending` and
  `slow_down` continue device polling; no other error is aliased to either
  condition. These guards do not require a parallel token parser or OAuth
  framework.
- Device initiation must apply configured client authentication, cancellation,
  bounded I/O, and response-body cleanup, and validate the returned device code,
  user code, verification URI, expiry, and polling interval. The selected
  version's device-start helper does not provide that complete boundary. A small
  standard HTTP request or a narrow dependency patch may close the demonstrated
  gaps; neither approach is prescribed. Keep the library's reusable device-token
  poller and provider-neutral RFC 8628 behavior.
- Retain rock5b's GitHub App device-flow use case with expiring user tokens and
  the declared `offline_access` scope. Provider endpoints and client ID are
  deployment data. Do not substitute an OAuth app, installation tokens, or a
  different browser grant to avoid verifying the selected workflow.

### Mitm credential placement

- Mitm owns its provisioned CA handling, guest capabilities, destination policy,
  and guest configuration. Accounts owns upstream credentials and refresh.
  Model-provider traffic originating in PDS on the host need not pass through
  mitm.
- Rules declare an exact HTTPS authority, permitted methods and path/query
  constraints, OAuth registration, accepted capability encoding, and
  `Authorization` placement as Bearer or Basic password. Basic substitution
  preserves the permitted username. Reject ambiguous rules and ambiguous or
  duplicate credential headers rather than relying on rule ordering.
- A validated capability determines the owner. A rule determines the
  registration; neither is taken from an arbitrary guest-supplied owner/account
  field. Resolve the corresponding configured credential socket and request a
  current snapshot before forwarding.
- Retain required Git-over-HTTPS and gh requests through declarative rules. No
  hostname switch executes provider-specific OAuth logic. No arbitrary rewrite
  script is an input to the rule system.
- Failed substitution, unknown capability, unavailable accounts, or unsupported
  placement fails closed before the credentialed request is forwarded. Do not
  forward a guest capability as an upstream credential or silently use another
  owner. Do not retry upstream writes because a token failed.
- Destinations without credential rules remain opaque tunnels subject to the
  existing egress restrictions, DNS/address checks, and authority/TLS agreement.
  Do not introduce universal host interception or weaken destination validation.
- Seed only capability-bearing guest configuration and public CA trust material.
  Upstream access tokens, refresh tokens, and private CA keys stay on the host.

### Independent push

- The Go guest adapter owns `org.freedesktop.Notifications` on guest root's
  session bus, without replacing an existing owner. Guest-root sending is the
  required producer interface; the standalone Go host service owns collection
  and delivery.
- The host selects ready guests from owner-scoped inventory and connects through
  normal OpenSSH configuration. The collection command emits a bounded one-way
  notification stream. Define and validate its framed records in push, not core.
  No acknowledgement, replay cursor, or durable outbox is part of that protocol.
- Frames carry notification ID, bounded plain text, and supported notification
  metadata. They cannot specify owner, recipients, subscription endpoints,
  navigation URLs, fetched images, or executable actions. The host binds source
  attribution and supplies browser tags and destinations.
- Track IDs, replacement, expiry, and closure only in adapter memory. Derive a
  host-generated tag scoped to owner, source, collection lifetime, and local
  notification ID so replacements within that lifetime reuse it. Phone
  replacement is best effort; reconnection does not replay prior notifications.
- Local notify-send success means valid input was accepted for best-effort
  forwarding. Disconnection and overload drop work rather than accumulating
  catch-up state. Invalid input still fails. Bound in-memory work, concurrency,
  timeouts, and diagnostics.
- Make one bounded send attempt per registered device, without automatic
  retries. Registration storage persists across service restarts; delivery work
  does not. Guest retirement stops collection but cannot recall submitted
  pushes.
- Keep Web Push TTL at 300 seconds, independently of the D-Bus timeout.
  `CloseNotification` and expiry do not retract an already-sent phone
  notification. Push-service buffering and browser display duration are outside
  the local delivery guarantee.
- Push serves its own registration/unregistration page, manifest, assets, and
  narrowly scoped service worker. Notification taps open that page. The
  installed iPhone PWA workflow must not require app or PDS. There is no history
  view, notification action, or coding-agent observer.
- Registration accepts only deployment-allowlisted HTTPS push-service origins
  and valid subscription keys. Bound registration counts and management request
  sizes; require same-origin management writes.
- For every send, resolve and validate destination addresses, reject non-public
  addresses, and connect to the validated address with the original TLS hostname
  verified. Do not follow redirects or allow proxies to bypass validation. Move
  these requirements into Go push, not a TypeScript push-policy dependency.

### Inventory and native SSH

- Use `drv.run list --json` for unprivileged, read-only inventory scoped to the
  calling Unix owner, extending the existing list command rather than adding a
  new subcommand. This mode does not create, start, stop, or delete instances
  and does not accept another owner as a selector. Existing human-readable
  listing and privileged administrative behavior remain separate.
- Return one JSON document with `version: 1` and an `instances` array. Each
  record contains `id` (stable instance identity), `reference` (retained flake
  reference), `host` (OpenSSH name), `ready` (boolean), and systemd
  `activeState`, `subState`, and `result` strings. No connection-file paths,
  keys, capabilities, or tokens appear in inventory. Sort records by ID for
  deterministic presentation.
- Inventory includes retained stopped and failed instances. `ready` requires
  provisioning completion for the current start and an available running
  instance, not merely a retained disk or allocated identity. It does not
  promise the next SSH connection succeeds. Ordinary restart preserves ID and
  saved PDS selections.
- Empty inventory is a successful empty array. Discovery failure exits nonzero
  and does not emit a successful partial/empty document. Consumers validate the
  version and schema; they do not parse human-readable diagnostics.
- PDS registers an optional drv.run environment source around its existing
  environment callback. It lists selectable ready instances and resolves saved
  identities, showing unavailable selections and source errors explicitly. A
  source failure does not disable other sources. Push consumes inventory
  independently rather than importing PDS's source interface.
- The public SSH connection input is a host name. Deployment owns user, route,
  keys, known hosts, and native `Host`/`Include` configuration. Applications do
  not reconstruct connection-file paths or require equivalent path fields in
  inventory.
- Carry a minimal package-applied patch against pi-env 1.5.2 for native OpenSSH
  configuration, alongside PDS's retained pi-durable conversation-context patch.
  Do not upgrade Pi or introduce a separate local fork product to obtain this
  boundary. The patch must not force an application-owned known-hosts file,
  host-key alias, global-known-hosts suppression, or alternate configuration
  file. Keep strict host-key verification and noninteractive execution; do not
  accept unknown or changed keys as a workaround. PDS does not acquire a
  host-key management UI.
- Guest deployment likewise uses normal outgoing SSH and SSH-server
  configuration. Provision server keys and authorized keys in the locations
  chosen by that configuration with appropriate ownership and permissions.

### Seed inputs and service modules

- Core accepts owner-scoped mappings from host input files to relative guest
  seed destinations. It copies bytes without interpreting them. Reject invalid,
  escaping, or conflicting destinations; inputs cannot overwrite core-managed
  seed material. Do not follow a destination symlink outside the staging tree.
- Missing or unreadable configured inputs fail startup. Deployment prepares
  inputs before instance start; component generators do not become arbitrary
  executable core hooks. Snapshot inputs on every start. Source changes take
  effect only after an explicit restart, not in a running seed.
- Packages export `passthru.services.host` and, where needed,
  `passthru.services.guest`. Keep modules package-local, inline unless a sibling
  module is warranted, using lexical dependencies and `finalAttrs.finalPackage`.

| Component export                          | Native import scope                  | Runtime identity                     |
| ----------------------------------------- | ------------------------------------ | ------------------------------------ |
| PDS, accounts, host push: `services.host` | Host NixOS `imports`                 | Configured host owner's user manager |
| Push adapter: `services.guest`            | Guest NixOS `imports`                | Guest root's user manager            |
| Shared mitm: `services.host`              | `system.services.<instance>.imports` | Dedicated system service user        |
| Mitm configuration: `services.guest`      | Guest NixOS `imports`                | Guest configuration; no extra daemon |

- Service-class modules declare `_class = "service"`; NixOS modules use the
  NixOS class. Use ordinary module-class and option checks, not scope-prefixed
  export names or an adapter that hides different import scopes.
- Rock5b selects packages, users, secrets, state/runtime access, inventory
  consumers, seed mappings, endpoint exposure, and dependencies between units.
  Central infrastructure modules do not import functional application modules.
  Extract shared composition only when there is an actual second consumer.

### HTTP composition

- PDS, accounts, and push each receive a listening endpoint and a separate
  absolute public base URL including their assigned path prefix. Deployment owns
  HTTPS and routing; a shared origin is permitted, not required.
- Forward the configured prefix unchanged. Applications generate prefix-correct
  links, form actions, assets, SSE addresses, and supported OAuth callbacks.
  Push's manifest and worker stay within its prefix; it cannot control PDS or
  accounts pages. Do not trust arbitrary forwarded-host headers or rewrite HTML
  in the router.
- Origin checks are request safeguards, not authentication. OAuth callbacks use
  validated state/PKCE rather than a blanket same-origin-write rule that would
  reject a legitimate provider callback. No particular router or deployment
  prefix is selected.

### Retirement and cutover

- WWW is initial source/build cleanup. It does not wait for replacement
  readiness or live acceptance.
- The local durable namespace can retire after its surviving harness assets,
  patches, relevant tests, and adapted API specification belong to PDS. It does
  not wait for accounts, push, or app cutover.
- App removal requires the repository gate: retained responsibilities have their
  selected owners, surviving dependencies and closures exclude retired code, and
  replacement checks cover the retained contracts. Removal may accompany its
  replacement in one change; dual operation is not required.
- Retire the custom OpenAI adapter, OpenAI token service, and PDS token
  resolver; do not relocate them into accounts. Retire durable notification
  outboxes, inbox/history, replay/ACK machinery, and agent-completion observers.
  Retire TypeScript push-policy after its consumers disappear.
- Drop app tape, its renderer benchmark, and app/www-specific Elm tooling.
  Retain PDS's fixtures and benchmark and the independent infrastructure
  benchmark. Necessary helpers follow their component; there is no new generic
  application/test package.
- Remove obsolete references from package exports, checks, development shells,
  formatting/linting commands, examples, service modules, and generated context.
  Core modules/tests must not depend on the reference example flake.
- Keep declarations and externally provisioned secrets as reusable inputs,
  including CA, VAPID, and API keys. Do not rotate them implicitly. Generated
  application and infrastructure state is disposable at authorized cutover;
  fresh OAuth enrollment, device registration, and coordinated application/guest
  restarts are acceptable. This does not change normal persistence semantics.

## Testing Decisions

The user confirmed these seams before specification publication. Test external
interfaces, resulting state, and event/lifecycle ordering. Assign each behavior
once at the highest practical public boundary; use narrower tests only where
that boundary cannot establish the contract. Do not expose production internals
solely for tests or assert log/serialized-text matches.

### Offline component evidence

| Seam                                                            | Required evidence                                                                                                                                     | Prior art                                                                                                                                                                  |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PDS HTTP, HTML, Datastar                                        | Real Harnesses, temporary SQLite, faux model; multi-store isolation, command semantics, bounded observation, errors, environment configuration        | [PDS fixtures](packages/pds/tests/fixtures.ts), [application tests](packages/pds/tests/application.test.ts), [watch tests](packages/pds/tests/watch.test.ts)               |
| PDS shared credential file                                      | Cross-process writes and locks, external login/logout visibility, persistence before use, storage failures and cancellation boundaries                | Pi 1.5.2 credential backend; detailed cases in [[packages/pds/SPEC.md]]                                                                                                    |
| Accounts management and Unix credential endpoint                | Deterministic OAuth server; both grants, HTTP-200 errors, refresh races/uncertainty, restart, replacement, disconnect, secret exclusion               | [Account scenarios](packages/durable/api/tests/accounts.test.ts), [credential failure scenarios](packages/mitm-proxy/tests/auth_test.py)                                   |
| Mitm client to controlled TLS upstream                          | Declarative placement, owner binding, opaque passthrough, failed substitution, git/gh protocol outcomes                                               | [Transport fixture](packages/mitm-proxy/tests/transport_test.py), [proxy policy cases](packages/mitm-proxy/tests/proxy_test.py)                                            |
| Public D-Bus through collection to controlled Web Push receiver | Local acceptance, input validation, owner binding, replacement, dropping/no replay, single send attempts, persistent subscriptions, safe endpoints    | [Private D-Bus fixture](packages/app/serve/tests/notification-guest.test.ts), [push safety tests](packages/app/serve/tests/push.test.ts)                                   |
| Real browser                                                    | Drafts, DOM/Datastar behavior, model-login interactions, independent management, prefix-correct assets and service-worker scope                       | [PDS Chromium suite](packages/pds/tests/flow.chromium.ts), [registration browser tests](packages/app/serve/tests/notifications.chromium.ts)                                |
| CLI, OpenSSH, Nix modules and closures                          | Parsed inventory, missing versus failed discovery, native connection/trust, generic seeds, import scopes, independence and retired-dependency absence | [CLI](nixosModules/host/cli.sh), [preparation](nixosModules/host/pre.sh), [focused proxy VM](tests/nixos/mitm-proxy.nix), [notification VM](tests/nixos/notifications.nix) |

- Existing tests are evidence, not mandates to preserve discarded behavior.
  Replace identity-pinning, request-spanning lease, notification replay, inbox,
  and agent-notification assertions with the selected contracts.
- PDS must run without accounts, mitm, push, and drv.run; test its optional
  discovery integration separately. Accounts must run without coding
  applications or mitm. Push must run without accounts, mitm, or coding
  applications. Bare drv.run must provide guest lifecycle, flake environments,
  and SSH with no application services.
- Use temporary owner state and deterministic offline provider/transport
  fixtures. Tests inspect decoded protocol fields, DOM properties, file state,
  and upstream fixture observations, not stdout/stderr strings. Machine-readable
  inventory is a parsed public protocol, not human-output matching.
- Verify actual two-Unix-owner denial and shared mitm authorization. Reserve
  focused NixOS tests for OS permissions, user/system service lifetimes, D-Bus
  ownership, guest seed/restart boundaries, and integration that cannot be
  established through cheaper public interfaces. Do not run `nixos-host-basic`.
- Every Nix-defined package runs its unit tests in `checkPhase`. Expose
  applicable focused VM tests through package test passthru and `nixos-` flake
  checks. Benchmarks remain outside flake checks. Keep authoritative Nix
  verification and relevant browser checks; do not substitute merely removing
  old checks.
- Native OpenSSH acceptance must execute through the selected pi-env
  integration, prove deployment-supplied host/user/trust settings are used, and
  reject unknown or changed keys. Testing generated argument strings alone is
  insufficient.
- Verify the selected Go dependency through public accounts flows, including
  malformed/mixed envelopes, omitted refresh tokens, explicit client-auth
  styles, bounded device-start cancellation, and no exchange replay after
  uncertainty.

### Authorized rock5b acceptance

Repository removal need not wait for live credentials or a phone. Rock5b
completion does require separately authorized evidence for:

1. Real OpenAI/Codex login and inference, with shared Pi credential
   interoperability and no accounts/mitm requirement for model auth.
2. GitHub enrollment, refresh, and guest git/gh use through accounts and mitm.
3. Independent installed-iPhone PWA registration and a guest-origin notification
   displayed without a coding application. This proves a working path, not
   stronger delivery guarantees.
4. The Tailscale-served entry point using the replacement composition rather
   than app, with prefixed routing, correct owner wiring, and coordinated
   restart and re-enrollment.

## Out of Scope

- Implementation, implementation-ticket generation, deployment, migrations,
  deletion, or live credential/device access during specification work.
- Public application exposure, HTTP application authentication/authorization, a
  central settings frontend, or a new application identity platform.
- State importers, archives, zero-downtime cutover, hot rollback, or secret
  backup/rotation tooling for disposable state.
- Full legacy feature/API parity, GraphQL, a generic local harness product,
  pi-coding-agent runtime integration, or consuming its non-credential state.
- Custom accounts/mitm provider flows, local model-provider adapters, a switch
  to newer ChatGPT token sharing, profile lookup, or upstream identity pinning.
- Durable notifications, retries, delivery receipts, host-native sending,
  arbitrary guest-user sending, inboxes, actions, or direct agent notifications.
- Guest lifecycle control from PDS discovery, a new inventory daemon, general
  executable hooks, plugin frameworks, or speculative notification backends.
- Separate telemetry deployment, Knip adoption, or 100% coverage gates copied
  from the old durable API specification.

## Further Notes

### Authority and publication

- Local publication only. `ready-for-agent` classifies the specification; it is
  not authorization to implement, deploy, delete source, or discard live state.
  The closed Wayfinder tickets keep their existing classification and status.
- Governing resolutions: [[tasks/000-foundation.md]],
  [[tasks/010-retained-workflows.md]], [[tasks/020-state-continuity.md]],
  [[tasks/030-credential-contract.md]], [[tasks/040-notification-contract.md]],
  [[tasks/050-infrastructure-contract.md]], [[tasks/060-retirement-gates.md]],
  [[tasks/070-pds-http-contract.md]], and [[tasks/080-accounts-enrollment.md]].
  Provider research remains bounded evidence in
  [[tasks/025-openai-oauth-compatibility.md]] and
  [[tasks/027-github-oauth-compatibility.md]].
- The credential endpoint spelling, inventory schema, and Go OAuth version above
  are specification-level refinements of those resolutions, not claims about
  existing interfaces. No provider-specific exception is added.

### Source and verification boundary

- Reviewed the working checkout based on `9e36cb6f`; did not rebase to or claim
  inspection of the squashed remote revision. The pre-existing mitm package
  manifest addition is unrelated and unchanged.
- Current composition evidence: [package graph](packages/default.nix),
  [flake](flake.nix), [host module](nixosModules/host/default.nix),
  [guest module](nixosModules/guest/default.nix),
  [reference composition](examples/rock5b/flake.nix), and [checks](justfile).
- Native SSH integration was checked against [pi-env 1.5.2 SSH][pi-ssh]. Its
  current forced trust paths are a gap to implement, not an accepted dependency
  behavior. Nix service scope follows the pinned [module evaluator][nix-modules]
  and [service submodules][nix-services].
- Go OAuth v0.35.0 source establishes [standard operations][go-oauth],
  [PKCE][go-pkce], [token/error and auth-style behavior][go-token], and [device
  behavior][go-device]. Its [module declaration][go-module] requires Go 1.24;
  the pinned nixpkgs Go definition is [1.26][nix-go]. Source inspection is not
  compilation, offline conformance, or live GitHub verification. No Go OAuth
  code or dependency manifest was changed or executed in this specification
  phase.
- Push library selection and storage layout are implementation details subject
  to the specified public contracts and offline checks, not new user workflows.
- The test seams are confirmed; runtime acceptance remains pending. Markdown
  validation does not establish any replacement component or deployment gate.

[pi-ssh]:
  /nix/store/66k268i56xwl405b3hnz6l84mgb4fl8c-pds-0.1.0/lib/pds/node_modules/@earendil-works/pi-env/dist/ssh.js
[nix-modules]:
  /nix/store/5kch26ml22zg5gx0gym9nff7j5rificm-source/lib/modules.nix
[nix-services]:
  /nix/store/5kch26ml22zg5gx0gym9nff7j5rificm-source/lib/services/lib.nix
[nix-go]:
  /nix/store/5kch26ml22zg5gx0gym9nff7j5rificm-source/pkgs/development/compilers/go/1.26.nix
[go-oauth]: https://github.com/golang/oauth2/blob/v0.35.0/oauth2.go
[go-pkce]: https://github.com/golang/oauth2/blob/v0.35.0/pkce.go
[go-token]: https://github.com/golang/oauth2/blob/v0.35.0/internal/token.go
[go-device]: https://github.com/golang/oauth2/blob/v0.35.0/deviceauth.go
[go-module]: https://github.com/golang/oauth2/blob/v0.35.0/go.mod

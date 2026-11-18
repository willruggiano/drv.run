# What contract separates accounts from credential consumers?

- Label: `wayfinder:grilling`
- Mode: HITL
- Status: closed
- Assignee: Pi (credential-contract discussion)
- Blocked by: [[tasks/010-retained-workflows.md]],
  [[tasks/025-openai-oauth-compatibility.md]],
  [[tasks/027-github-oauth-compatibility.md]]
- Map: [[TASKS.md]]

## Question

For the retained account workflows, what is the smallest standard-OAuth accounts
contract that lets components operate independently without duplicating OAuth
ownership or weakening the credential boundary? What generic model-login and
storage contract does PDS need to use pi-ai independently of accounts?

Respect the revised scope in [[tasks/010-retained-workflows.md]]: accounts owns
non-model credentials, including GitHub git/gh access. PDS owns model login UI and
host credential storage, with provider authentication delegated to pi-ai. This
supersedes the accounts-owned Codex exception and PDS's token-service resolver.
Standards-only OAuth remains the accounts baseline; it is not a requirement to
reimplement pi-ai's model-provider flows. Mitm owns credential placement for guest
egress, not host-native PDS/provider requests.

Settle:

- How PDS's generic Datastar login UI handles pi-ai prompts/events, cancellation,
  logout, and failures without recording credentials in conversations or returning
  stored credentials to the browser. Keep provider-specific behavior in pi-ai.
- What evidence establishes shared `auth.json` compatibility with the Pi CLI:
  schema, path selection, cross-process locking, refresh writes, and visibility of
  login/logout changes. Specify storage and model-auth failure behavior; do not
  assume pi-ai supplies the stronger accounts guarantees below.
- How the selected Go accounts implementation satisfies the approved
  provider-neutral handling of OAuth JSON error bodies returned with HTTP 200,
  without adding a GitHub adapter; see
  [[tasks/027-github-oauth-compatibility.md]]. No Go OAuth library is selected yet.
- Which standard grants and configurable OAuth metadata satisfy the required
  connections? Use the compatibility findings; distinguish OAuth configuration
  from provider-specific executable logic or token interpretation.
- How the standalone accounts page exposes OAuth flow controls for deployed
  configuration, independently of PDS. Management endpoints select configured
  owner state; application HTTP authn/authz is deferred under
  [[tasks/000-foundation.md]]. Deployment-owned HTTP routing may compose the
  separate applications; it does not move accounts' UI into PDS.
- How host callers obtain authorized non-model credential access. Guest
  capabilities go through mitm; do not impose that requirement on host-native
  model traffic. Non-model refresh tokens stay with accounts; model refresh tokens
  stay in PDS's shared host credential store.
- What declarative HTTP matching and credential-placement policy mitm needs,
  without provider-specific code paths.
- Account selection and cardinality for the required workflows, rather than
  assuming either one global account or a general multi-account platform.
- The remaining consumer-visible failure contract: expiry, refresh races,
  revocation, restarts, and unavailable accounts, consistent with the confirmed
  token-snapshot interface rather than request-spanning leases.
- Which existing behavior and tests inform the Go implementation, and what can be
  removed once the contract is satisfied. Existing TypeScript and Python code are
  references, not runtime dependencies or a selected source to port wholesale.
  Do not carry GraphQL or pi-ai dependencies into accounts.

The answer is an interface and trust-boundary decision, not an implementation or a
choice of new providers. State migration remains separate.

## Resolution

Confirmed by the user across the credential-contract discussion, including the
PDS storage, failure, interaction, replacement-login, and cancellation decisions
below. This settles the interface contract, not an implementation or permission
to retire the existing paths.

### Go implementation and Nix-owned configuration

- The user selected Go for standalone accounts and prefers Go for anything that
  does not require direct PDS/pi-durable integration; see
  [[tasks/000-foundation.md]]. The TypeScript/`oauth4webapi` extraction proposal is
  rejected. No Go OAuth dependency has been selected or verified.
- Declarative OAuth configuration remains in Nix, not browser-editable state.
  Runtime services consume the deployed configuration; they do not provide
  account/registration configuration CRUD. Adding an account declaration requires
  deployment. Endpoint metadata, client authentication, and scopes belong to that
  configuration; provisioned secrets remain separate from generated credentials.
- OAuth flow controls operate against deployed configuration; they do not create
  or edit that configuration. Credential persistence and refresh remain runtime
  responsibilities, not Nix configuration writes.

The working interpretation of "adding an account" is adding a declared account
slot. Enrolling, reauthorizing, or disconnecting credentials for an existing
declaration changes runtime state, not the declared account set. Do not infer a
deployment requirement for every token refresh or login attempt.

### Independent accounts UI

- The user clarified that "PDS flow controls" meant the existing account UI in
  `packages/app`, not PDS's model login. Accounts has its own separate page for
  enrollment, status, reauthorization, and disconnection, independent of PDS.
- The Go accounts component owns both its backend and its management frontend.
  The preferred approach is a Datastar-powered frontend served by that component;
  sharing the frontend technology does not imply a PDS dependency or a shared
  application frontend.
- Deployment may expose PDS and accounts under different paths on the same origin
  through an HTTP router/reverse proxy. This is composition of independent
  applications, not a PDS-owned accounts UI or API. Accounts remains usable without
  app or PDS.
- `/` for PDS, `/accounts` for accounts, and nginx were illustrative examples,
  not selected routes or router software. Deployment owns the routing and external
  URL configuration; see [[tasks/050-infrastructure-contract.md]]. A shared origin
  is permitted, not required.
- The UI operates OAuth flows against Nix-owned configuration; it does not edit
  account declarations. Tailscale/LAN-only exposure and deferred application HTTP
  authn/authz remain unchanged.

### Model authentication: revised ownership

The user explicitly replaced the earlier accounts-owned Codex device flow and
PDS host token-service path with PDS/pi-ai authentication. The former Codex
exception is no longer part of the accounts contract.

- Use pi-ai as a library. PDS builds its own generic `/login` UI with Datastar,
  plus logout and interaction cancellation, through `Models` and
  `AuthInteraction`. No pi-coding-agent runtime or internal API dependency.
- PDS owns a file-backed `CredentialStore` on the host, sharing the Unix owner's
  Pi `auth.json` (default `~/.pi/agent/auth.json`). Model access and refresh tokens
  live there, not in accounts. The store must support refresh writes, not merely
  load credentials at startup.
- Match the Pi CLI's credential schema and cross-process locking so PDS and the
  CLI can use the same file without independently refreshing copied credentials.
  Store one credential per model provider for the host owner, shared across PDS
  conversations; no per-conversation account switching is required.
- Consume only `auth.json`. Do not load Pi settings, sessions, extensions, or
  model configuration. Generic file storage and UI integration belong in PDS;
  provider enrollment, refresh, token interpretation, and request authentication
  stay in pi-ai. Do not copy the Codex adapter into PDS or accounts.
- Keep the existing Codex inference route and device-code enrollment through
  pi-ai's built-in provider. No switch to newer ChatGPT token sharing or additional
  provider workflow is selected. The research remains evidence, not a requirement
  to implement a separate standards-only Codex flow.
- Model authentication does not require accounts or mitm. The local OpenAI
  adapter, OpenAI token-service API, and PDS custom token resolver are retirement
  targets, not code to relocate. Removal still requires the retirement gates.
- Stored credentials and tokens stay out of browser responses, conversation
  history, and guests. The existing Tailscale/LAN exposure and deferred application
  HTTP authn/authz apply to PDS login too; see [[tasks/000-foundation.md]].
- This changes refresh-token ownership, not just the login UI. The PDS contract
  below is deliberately weaker than the non-model accounts persistence and
  failure guarantees.

### PDS credential storage and failures

- Observe CLI login/logout and refresh writes without restarting PDS. Use the
  shared file and Pi-compatible cross-process locking, not independently refreshed
  credential copies or a startup-only snapshot.
- Persist credentials before reporting login success or using refreshed
  credentials. Unreadable or malformed storage is an error, not a logged-out
  state, an empty replacement file, or permission to use stale in-memory data.
- Shared-file compatibility covers OAuth records and literal API keys, preserving
  unrelated entries. It does not include pi-coding-agent's executable key
  configuration. Explicitly reject unsupported command and environment-template
  key expressions rather than executing them or sending them as literal keys.
- Accept pi-ai's refresh-failure behavior: fail the model request, preserve the
  stored credential, and permit another attempt. Do not automatically delete
  credentials, silently fall back to another credential, or introduce
  provider-specific error classification in PDS.
- Once refresh starts, let pi-ai finish and persist it despite caller
  cancellation, subject to its timeout. This protects a returned rotating refresh
  token; it does not recover a lost refresh response or establish the accounts
  policy of requiring reauthorization after an ambiguous refresh.
- Do not promise crash-atomic storage across all writers. Pi's file backend writes
  in place; improving PDS's writes cannot strengthen the CLI's writes.

### PDS login, cancellation, and logout

- Render pi-ai's prompts and events generically through Datastar. Return sanitized
  failures, never raw provider exceptions or stored credentials. Keep login
  interaction and credential material out of conversation history.
- Allow one pending PDS login per host owner/provider, held in process memory.
  Browser reload or reconnection resumes it; explicit cancellation, expiry, or
  service shutdown ends the interaction. A PDS restart does not resume it. Another
  tab must not silently start a competing login.
- Starting a replacement login does not log out the provider. Existing
  conversations continue using the current credential. Only successful
  persistence replaces it for PDS and the CLI; failure before that leaves it
  unchanged.
- Cancellation during interaction or while waiting for the store lock prevents
  saving the replacement. Once persistence starts, await the outcome and report
  success or failure. Cancel must not report that nothing was saved if persistence
  already started; removing a saved credential requires logout.
- Logout cancels pending PDS login, waits for any PDS login commit, serializes
  removal against refresh, and deletes the provider's shared credential. PDS owns
  coordination of its pending login with logout; file locking alone does not
  provide that lifecycle boundary.
- Logout is local credential removal, not upstream revocation. It removes the
  CLI's stored credential too, but cannot recall credentials already used by
  requests, prevent a subsequent CLI login, or revoke the upstream session.
  Separately configured environment credentials may still authorize requests;
  distinguish that from stored login in the UI. Coordination with a separate CLI
  login is limited to shared-file locking.

### Non-model accounts and guest credentials

These decisions apply to accounts/mitm, not PDS's model credential store.

- Accounts owns non-model enrollment, credential persistence, and refresh.
  Non-model refresh tokens stay with accounts. Mitm obtains credentials for
  guest-egress injection; upstream credentials never enter guests. Host-native
  PDS/provider requests do not use that interface.
- Allow one enrolled upstream account per configured OAuth registration per host
  Unix owner. Rock5b requires one GitHub account per owner, shared across that
  owner's consumers. No per-guest account switching is required. Registrations
  are declarative configuration, not hard-coded provider slots.
- Keep non-model credential retrieval host-local through HTTP over owner-scoped
  Unix sockets. Mitm receives explicitly authorized access for the owners it
  serves. Browser management does not expose raw tokens. No cross-host credential
  API is required in this foundation.
- Accounts provides the independent page described above and an owner-bound
  management endpoint for enrollment, status, reauthorization, and disconnect,
  without pds or mitm's UI. Deployment owns its
  Tailscale/LAN exposure. The user explicitly deferred application HTTP
  authn/authz; do not require an authenticated reverse proxy or per-owner browser
  access enforcement. The network trust boundary and its consequences are
  recorded in [[tasks/000-foundation.md]].
- Return token snapshots, not request-spanning leases. Consumers obtain a current
  access token before each request. Accounts serializes refresh and persists
  replacement credentials atomically. Disconnect stops subsequent token issuance
  but cannot locally recall already-issued bearer tokens or guarantee cancellation
  of in-flight operations. No lock or lease spans the consumer's upstream request;
  requests are not guaranteed to survive upstream token rotation.
- Support standard authorization-code/PKCE, device authorization, and refresh.
  OAuth endpoints, client authentication, and scopes are declarative. Accounts has
  no model-provider dependency or approved custom provider flow. This is the
  required contract, not proof that an existing library already satisfies every
  retained provider's behavior.
- The user approved bounded, provider-neutral handling of an unambiguous JSON
  OAuth error returned with HTTP 200 by a configured token endpoint. Preserve
  normal successful-token validation and reject malformed or mixed error/success
  responses. Only standard `authorization_pending` and `slow_down` conditions
  continue device polling; refresh failures follow the fail-closed policy below.
  This tolerates a nonstandard response envelope, not a custom grant or a
  GitHub-specific adapter. See [[tasks/027-github-oauth-compatibility.md]].
- Distinguish not-enrolled, temporarily unavailable, and reauthorization-required.
  Fail closed when a refresh might have consumed a rotating refresh token but its
  replacement was lost: require reauthorization rather than blindly retrying the
  old refresh token. Serialize refresh and durably save replacements before
  returning them. Never silently substitute another account or credential.
- Mitm credential rules are declarative: exact HTTPS destination, method/path
  constraints, configured OAuth registration, accepted capability encoding, and
  `Authorization` placement as Bearer or Basic-password. The capability supplies
  the owner binding. No provider-specific branches or arbitrary rewriting scripts.
  Destinations without credential rules remain opaque tunnels, subject to existing
  egress restrictions. Failed credential substitution fails closed.
- Disconnect stops local token issuance and cancels pending enrollment; late
  enrollment/refresh results cannot restore the disconnected account. Attempt
  upstream revocation only through a configured standard revocation endpoint.
  Upstream failure does not block local disconnect, and the management interface
  distinguishes local disconnect from confirmed remote revocation. No
  provider-specific revocation APIs.

The GitHub research establishes provider behavior and the old JavaScript parser
limitation, not compatibility of an as-yet-unselected Go dependency. Dependency
selection and implementation verification must satisfy this contract; closing the
decision ticket does not establish that the existing implementations do.

## Evidence

- [PDS's lock](../packages/pds/package-lock.json) pins pi-ai 1.5.2. Its
  [auth interfaces][pi-ai-auth] define `AuthInteraction` and `CredentialStore`;
  [Models][pi-ai-models] owns login persistence and logout, and
  [auth resolution][pi-ai-resolve] refreshes through the store's serialized
  `modify`. These are the integration interfaces, not a new OAuth implementation.
- [Pinned Codex OAuth][codex-oauth] implements browser and device-code login,
  refresh, and `toAuth`. Its provider-specific behavior remains in pi-ai.
- The matching pi-coding-agent 1.5.2 [file store][pi-auth-storage] and
  [path configuration][pi-config] are interoperability references, not a selected
  dependency. The default is `~/.pi/agent/auth.json`, with `PI_CODING_AGENT_DIR`
  overriding the directory. `AuthStorage` is not a public export in that release's
  [entry point][pi-exports] or [package exports][pi-package].
- Pi's file backend uses `proper-lockfile` on the resolved file path, so symlinked
  aliases share a lock, and writes the file in place. Its store merges provider
  writes into the current file and detects file revisions for subsequent reads.
- Pi's [key-value resolver][pi-config-values] executes `!command` and interpolates
  environment templates in stored API-key values. Those are CLI semantics, not
  behavior supplied by pi-ai or implied by sharing the JSON schema.
- [Auth resolution][pi-ai-resolve] retains the old credential when refresh throws.
  Once refresh begins under the store lock, caller cancellation does not abort it;
  a separate 15-second timeout bounds the provider call. These sources do not
  establish crash-atomic persistence or the accounts policy of requiring
  reauthorization after an ambiguous refresh.
- [Models][pi-ai-models] distinguishes cancellation before mutation starts from
  waiting for an initiated login mutation. Its logout deletes the stored entry;
  it does not coordinate application-owned login interactions or revoke upstream
  credentials. Auth resolution can use ambient credentials when no entry exists.
- [Models errors][pi-ai-errors] include underlying cause details, and the
  [Codex provider][codex-oauth] can include token-response bodies in errors. PDS
  must not forward those messages directly to the browser or conversation history.
- These are source findings, not end-to-end interoperability verification. No live
  credential flow was tested.
- [Authorization and token leasing](../packages/mitm-proxy/auth.py).
- [Proxy consumption and owner control sockets](../packages/mitm-proxy/main.py).
- [Local OpenAI OAuth](../packages/mitm-proxy/openai.py) and
  [PDS token-service client](../packages/pds/src/auth.ts) are the superseded paths.
- [App enrollment client](../packages/app/serve/auth.ts).
- [Alternative API account implementation](../packages/durable/api/src/accounts.ts).
- [Current socket ownership](../nixosModules/host/mitm-proxy.nix).

[pi-ai-auth]: https://unpkg.com/@earendil-works/pi-ai@1.5.2/dist/auth/types.d.ts
[pi-ai-models]: https://unpkg.com/@earendil-works/pi-ai@1.5.2/dist/models.js
[pi-ai-resolve]: https://unpkg.com/@earendil-works/pi-ai@1.5.2/dist/auth/resolve.js
[pi-ai-errors]: https://unpkg.com/@earendil-works/pi-ai@1.5.2/dist/utils/models-error.js
[codex-oauth]: https://unpkg.com/@earendil-works/pi-ai@1.5.2/dist/auth/oauth/openai-codex.js
[pi-auth-storage]: https://unpkg.com/@earendil-works/pi-coding-agent@1.5.2/dist/core/auth-storage.js
[pi-config]: https://unpkg.com/@earendil-works/pi-coding-agent@1.5.2/dist/config.js
[pi-config-values]: https://unpkg.com/@earendil-works/pi-coding-agent@1.5.2/dist/core/resolve-config-value.js
[pi-exports]: https://unpkg.com/@earendil-works/pi-coding-agent@1.5.2/dist/index.js
[pi-package]: https://unpkg.com/@earendil-works/pi-coding-agent@1.5.2/package.json

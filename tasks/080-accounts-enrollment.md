# How should standalone account enrollment behave?

- Label: `wayfinder:grilling`
- Mode: HITL
- Status: closed
- Assignee: Pi (accounts-enrollment discussion)
- Blocked by: [[tasks/030-credential-contract.md]],
  [[tasks/050-infrastructure-contract.md]]
- Map: [[TASKS.md]]

## Question

What interaction and pending-enrollment lifecycle should the independent Go
accounts page expose for its Nix-declared OAuth registrations?

The component ownership, credential-consumer interface, supported grants, and
refresh/disconnect guarantees are settled in
[[tasks/030-credential-contract.md]]. This ticket resolves the remaining
enrollment interaction details, not those contracts again. PDS model login is
separate and already has its own lifecycle.

Settle:

- How deployed grant configuration determines the available enrollment controls
  for authorization-code/PKCE and device authorization. Distinguish starting a
  flow, displaying provider instructions, receiving a callback, and confirming
  persisted credentials. Do not introduce browser configuration CRUD or
  provider-specific executable logic.
- Pending-attempt cardinality per owner/registration, competing tabs, browser
  disconnect/reconnection, expiration, explicit cancellation, and service
  restart. Decide which state survives each boundary; do not silently borrow
  PDS's in-memory-login policy for accounts.
- Replacement enrollment while a credential already exists: whether it remains
  usable while enrollment is pending, when replacement becomes authoritative,
  and what cancellation means once persistence starts. Preserve the
  already-agreed rule that disconnect cancels enrollment and late results cannot
  restore it.
- What the user sees after provider rejection, transport failure, or an
  uncertain token-exchange result; which actions allow an explicit retry or
  require a new enrollment attempt. Preserve the selected non-model
  refresh-failure policy and distinguish enrolled credential status from a
  pending interaction.

The answer is an observable interaction/lifecycle contract, not a UI mockup, Go
OAuth dependency selection, implementation, or live enrollment. Deployment-owned
public base URLs and deferred application HTTP authn/authz remain as decided in
[[tasks/050-infrastructure-contract.md]] and [[tasks/000-foundation.md]].

## Resolution

The user accepted all five enrollment recommendations. This settles the
remaining interaction/lifecycle contract; it does not select a Go OAuth
dependency, implement the component, or establish live provider compatibility.

### Registration and enrollment method

- Each Nix-declared registration selects one enrollment method:
  authorization-code/PKCE or device authorization. The UI exposes that method,
  without automatic grant fallback or browser configuration CRUD.
- Authorization-code enrollment uses provider authorization followed by the
  configured callback. OAuth state/PKCE validation remains required despite
  deferred application HTTP authentication.
- Device enrollment displays the verification link, user code, and expiry.
  Accounts owns polling; a browser connection does not drive it.
- Report enrollment success only after credentials have been durably saved.

A registration is a credential slot, with distinct persisted credential state
and transient enrollment state:

```text
Nix-declared registration
 +-- persisted credential
 +-- temporary enrollment attempt
```

### Pending attempts and browser lifetime

- Allow one in-memory pending attempt per host owner/registration. Repeated
  start requests return the existing attempt; another tab cannot silently
  replace it.
- Browser disconnection does not cancel enrollment. Reconnection shows the
  current attempt.
- Attempts have bounded lifetimes. Service restart abandons them; credentials
  already persisted survive. No durable enrollment history or restart-resumable
  OAuth flow is required.
- Late callbacks for cancelled, expired, or abandoned attempts cannot install
  credentials.

### Replacement and cancellation

- Starting reauthorization does not disconnect the existing credential. It
  remains available under normal expiry/refresh rules until an atomic
  replacement succeeds.
- Cancellation before persistence prevents replacement. Once persistence starts,
  await and report its result; do not claim cancellation without saving if
  saving succeeded. Removing a saved credential requires disconnect.
- This preserves local state, not a guarantee that the provider keeps the old
  credential valid.
- The disconnect guarantees in [[tasks/030-credential-contract.md]] still apply:
  disconnect stops local issuance, cancels enrollment, and prevents late results
  from restoring the disconnected account.

### Upstream account identity

- Successful replacement may use a different upstream account. A registration is
  not a pinned upstream identity; the provider determines which account the user
  authorizes.
- Use the configured registration label. Do not require profile lookup, JWT
  interpretation, or provider-specific same-user checks. The experimental API's
  identity check is not a retained requirement.

### Failures and uncertain outcomes

- After a lost browser response, read attempt/credential status rather than
  automatically starting enrollment again.
- For rejected or expired authorization, show a sanitized reason and offer
  explicit new enrollment.
- For an uncertain upstream token exchange, do not blindly replay it or report
  success. End the attempt as unconfirmed and require fresh enrollment.
- Normal device polling continues under the already-selected
  `authorization_pending`/`slow_down` rules. The non-model refresh-failure
  policy remains unchanged; see [[tasks/030-credential-contract.md]].
- Display credential status separately from attempt status. A failed replacement
  does not itself prove that the existing credential is invalid.
- Never expose raw token responses or provider exceptions.

## Evidence

- [[tasks/030-credential-contract.md]] records the independent management page,
  Nix-owned declarations, supported standard grants, and accounts-specific
  persistence, refresh, and disconnect guarantees.
- [App enrollment client](../packages/app/serve/auth.ts) is an existing consumer
  reference, not a requirement to retain its UI or provider-specific handling.
- [API accounts implementation](../packages/durable/api/src/accounts.ts) is
  another implementation reference, not the selected Go implementation. Its
  `publish` path optionally reads user info and rejects an identity change
  during replacement; that restriction is explicitly not retained here.
- [[tasks/027-github-oauth-compatibility.md]] establishes the required bounded
  handling of HTTP 200 OAuth error responses. It does not settle the browser or
  pending-enrollment lifecycle.

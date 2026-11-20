# Can retained GitHub enrollment use the standard OAuth implementation?

- Label: `wayfinder:research`
- Mode: AFK
- Status: closed
- Assignee: Pi (GitHub OAuth research)
- Blocked by: [[tasks/010-retained-workflows.md]]
- Map: [[TASKS.md]]

## Question

Can the required GitHub git/gh enrollment and refresh workflow use the proposed
standards-based accounts implementation without provider-specific handling?
Verify compatibility before choosing the extraction basis in
[[tasks/030-credential-contract.md]]. Model authentication now belongs to
PDS/pi-ai, not an accounts-owned Codex exception; that ownership revision does
not resolve GitHub compatibility. An existing library's behavior is not the
contract.

Investigate:

- Identify the configured GitHub registration type and required client
  authentication, grants, scopes, token responses, and expiry/refresh behavior.
  Do not conflate GitHub Apps and OAuth apps or assume all old adapter checks
  are server requirements.
- Determine authoritative GitHub device-polling and refresh error formats,
  including HTTP statuses. The current local adapter models HTTP 200 errors;
  pinned `oauth4webapi` does not process those as pollable OAuth errors.
  Establish whether this is a present server requirement, an old local
  assumption, or an unverified compatibility risk. No live authorization is
  approved.
- Compare those requirements with the pinned library and existing accounts code.
  Distinguish standard configuration, library limitations, provider-neutral
  error processing, and genuinely provider-specific executable handling. Do not
  invent a general adapter framework or silently relax the standards-only
  baseline.
- Determine whether a standard alternative preserves the required git/gh access
  if device enrollment is incompatible. Report uncertainties and the smallest
  decision needed; do not approve an exception or select an untested library on
  the user's behalf.

Keep findings in this ticket. No product implementation, credential inspection,
live authorization, deployment, or remote tracker activity.

## Initial evidence

- [Rock5b registration](../examples/rock5b/flake.nix) and
  [current module configuration](../nixosModules/host/mitm-proxy.nix) describe a
  GitHub App with device flow and expiring user tokens enabled.
- [Current GitHub adapter](../packages/mitm-proxy/auth.py): `GitHub.request`
  accepts only HTTP 200, while `GitHub.authorize` processes
  `authorization_pending` and `slow_down` from the returned JSON. It also
  validates GitHub-specific token prefixes and calls `/user`; these are local
  choices, not proof of server needs.
- [Existing accounts implementation](../packages/durable/api/src/accounts.ts):
  `poll` continues only for the corresponding `oauth.ResponseBodyError` values.
  Its standard OAuth operations are a candidate, not established GitHub support.
- [Dependency lock](../packages/durable/api/package-lock.json) and the installed
  package identify `oauth4webapi` **3.8.8**. In the [versioned parser
  source][oauth-source], `checkOAuthBodyError` only examines an OAuth error body
  when HTTP status differs from the expected success status;
  `processGenericAccessTokenResponse` expects 200 and then requires
  `access_token` and `token_type`.
- An offline interface check against that installed parser passed: passing
  `Response.json({ error: "authorization_pending" }, { status: 400 })` to
  `processDeviceCodeResponse` yields `ResponseBodyError` with
  `error === "authorization_pending"`; status 200 instead yields
  `OperationProcessingError` with `code === "OAUTH_INVALID_RESPONSE"`.
  Assertions checked error types/fields, not message text. This made no network
  requests and proves only parser behavior, not GitHub's current HTTP response
  status.
- [GitHub's OAuth-app documentation][github-oauth] advertises the standard
  device grant and documents polling error values. The inspected excerpts did
  not establish their HTTP status, and the retained configuration uses a GitHub
  App. Consult the applicable first-party documentation before drawing a
  server-level conclusion.

## Resolution

**Not unchanged.** GitHub explicitly documents HTTP 200 device-polling errors,
which the pinned strict parser rejects as malformed success responses. The grant
requests and successful responses can use standard OAuth operations. Keeping
GitHub device enrollment requires either a bounded response-compatibility
allowance or another implementation that accepts that same nonstandard behavior.
Changing libraries would not make the server's response RFC-conformant.

A provider-neutral allowance is possible without a GitHub adapter. The user
subsequently approved the bounded response handling in
[[tasks/030-credential-contract.md]]. That is a human contract decision, not an
implementation or exception approved by this research.

### Provenance and checks

Verified the [oauth4webapi 3.8.8 archive][oauth-archive] against the
[lock's SHA-512 integrity](../packages/durable/api/package-lock.json). Its
`build/index.js`, `build/index.d.ts`, and package metadata match the installed
files used for the offline checks. GitHub's hosted-service documentation was
read on 2026-11-17; no live enrollment, token refresh, credential inspection, or
git/gh operation against an account was performed.

Offline interface checks passed for:

- Public-client device authorization, device-code token requests, and refresh
  requests using the configured GitHub URLs. An injected fetch checked form
  fields, JSON Accept headers, and disabled redirects, then returned synthetic
  responses. No request reached the network.
- Device authorization and token success responses with the documented field
  shapes, including empty `scope` and the extra `refresh_token_expires_in`
  field.
- Device errors `authorization_pending`, `slow_down`, and `access_denied` at 200
  versus 400, and refresh errors `invalid_grant` and `bad_refresh_token` at both
  statuses. Assertions checked returned data and error classes/fields, not log
  output or message text.

### Required GitHub registration and grant behavior

The [current configuration](../nixosModules/host/mitm-proxy.nix#L29) selects a
**GitHub App**, with device flow and expiring user tokens, not a traditional
OAuth app or an installation-token flow. The applicable [GitHub App
documentation][github-app-user] establishes:

- Device authorization at `https://github.com/login/device/code`; polling at
  `https://github.com/login/oauth/access_token` with `client_id`, `device_code`,
  and `grant_type=urn:ietf:params:oauth:grant-type:device_code`.
- `scope=offline_access` requests an expiring user access token and refresh
  token. Other permission scopes are not used for GitHub Apps: permissions come
  from the app registration and the authorizing user's access, not generic OAuth
  scopes.
- Device enrollment does not require a client secret. The [refresh
  contract][github-app-refresh] likewise does not require one for tokens
  obtained through device flow. Refresh uses `grant_type=refresh_token`, client
  ID, and the refresh token at the same token endpoint.
- Successful responses carry standard `access_token`, `token_type=bearer`,
  `expires_in`, `refresh_token`, and `scope` fields. The documented access
  lifetime is eight hours; refresh tokens last six months. The extra
  `refresh_token_expires_in` field does not require a provider-specific parser
  to exchange, store, or refresh the standard fields.
- Refresh replaces both tokens; the old access token and refresh token cease to
  work. This supports the already-recorded caveat that request snapshots do not
  guarantee survival across upstream token rotation.

GitHub's [official CLI tutorial][github-cli-tutorial] uses form-encoded POSTs
with `Accept: application/json`, then examines the JSON error field. This
confirms that form encoding is supported even where the reference calls the
inputs query parameters. The pinned library already sends those formats; setting
an Accept header does not solve the status-code mismatch.

The [local adapter](../packages/mitm-proxy/auth.py#L190) additionally validates
`ghu_`/`ghr_` token prefixes and compares `/user`'s numeric ID with
configuration. Those are local policy choices, not requirements of token
exchange or refresh. They are not part of the selected provider-neutral accounts
contract. The
[existing accounts candidate](../packages/durable/api/src/accounts.ts#L547) can
omit userinfo entirely. Its optional OIDC userinfo parser requires `sub`; do not
mistake GitHub's REST `/user` response for that interface.

### The response mismatch is documented, not conjecture

Under device polling, [GitHub states][github-app-user]:

> Until the user enters the code, GitHub will respond with a 200 status and an
> `error` response query parameter.

Its [JSON/form tutorial][github-cli-tutorial] implements the same behavior. [RFC
8628 section 3.5][rfc8628] instead incorporates the token error response from
[RFC 6749 section 5.2][rfc6749], whose default error status is 400.

In [pinned oauth4webapi][oauth-source]:

- `checkOAuthBodyError` only checks the error body when status differs from the
  expected success status; `parseOAuthResponseErrorBody` recognizes 4xx errors.
- `processGenericAccessTokenResponse` expects 200, then requires `access_token`
  and `token_type`. Thus HTTP 200 `authorization_pending` becomes
  `OperationProcessingError` / `OAUTH_INVALID_RESPONSE`, not the pollable
  `ResponseBodyError` produced for HTTP 400.
- The [current accounts poller](../packages/durable/api/src/accounts.ts#L493)
  continues only for the latter error class. It would stop on GitHub's
  documented pending response. This is a compatibility gap, not grounds to
  weaken the library's checks silently.

GitHub also documents the terminal refresh error `bad_refresh_token`, rather
than only `invalid_grant`, and says to enroll again. Its HTTP status was not
established by the inspected refresh reference; the offline status cases are
parser tests, not observations of that endpoint. Independently of status, the
[current refresh catch](../packages/durable/api/src/accounts.ts#L306) classifies
only `invalid_grant` as requiring reauthorization. That classification cannot be
copied unchanged. Unknown terminal OAuth failures can fail closed generically;
there is no need to create provider-specific error aliases or indefinitely retry
an unusable refresh token.

### Smallest compatibility decision

**Recommendation subsequently approved in the credential contract:** recognize
an unambiguous OAuth JSON error object returned with HTTP 200 by a configured
OAuth token endpoint as an error, not as a token success. Keep normal
successful-token validation and all other response checks. Reject malformed or
mixed error/success responses; do not use this as permission to accept arbitrary
invalid responses. Only the standard pending and slow-down conditions continue
device polling; other errors terminate the attempt. Refresh failures must follow
the already-approved fail-closed lifecycle policy.

This can be provider-independent accounts response handling: no hostname switch,
GitHub adapter, token-prefix parsing, identity lookup, or callback framework. It
is still tolerance of a nonconforming response envelope, so calling it strictly
RFC-conformant would be inaccurate. The approved allowance extends response
compatibility without hiding a GitHub special case behind configuration.

**Standard-grant alternative:** [GitHub documents browser
code/PKCE][github-app-user] for the same GitHub App user-token type. It requires
a registered callback and a client secret, including for later refresh of
browser-issued tokens. The current module provisions only a client ID; neither
callback registration nor secret availability was verified. This avoids the
device-polling mismatch, but uses the same token endpoint and does not establish
strict conformance for every failure path. Do not claim it is a fully verified
alternative or switch registration/token types without a human decision.

No documented switch to make device-polling errors use RFC status codes was
found in the inspected provider references. No live flow was used to search for
one. The research establishes the compatibility requirement. The response policy
is approved. The user subsequently selected Go rather than the proposed
TypeScript extraction; see [[tasks/030-credential-contract.md]]. The JavaScript
parser checks remain evidence about that candidate, not verification of a Go
implementation. GitHub's documented server behavior still applies; no Go OAuth
dependency has yet been selected or verified.

[oauth-source]: https://unpkg.com/oauth4webapi@3.8.8/build/index.js
[oauth-archive]:
  https://registry.npmjs.org/oauth4webapi/-/oauth4webapi-3.8.8.tgz
[github-oauth]:
  https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
[github-app-user]:
  https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
[github-app-refresh]:
  https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens
[github-cli-tutorial]:
  https://docs.github.com/en/apps/creating-github-apps/writing-code-for-a-github-app/building-a-cli-with-a-github-app
[rfc8628]: https://www.rfc-editor.org/rfc/rfc8628#section-3.5
[rfc6749]: https://www.rfc-editor.org/rfc/rfc6749#section-5.2

# Can required OpenAI access use standards-only OAuth?

- Label: `wayfinder:research`
- Mode: AFK
- Status: closed
- Assignee: Pi (OpenAI OAuth research)
- Blocked by: [[tasks/010-retained-workflows.md]]
- Map: [[TASKS.md]]

## Question

Can the required OpenAI/Codex workflow use standard OAuth without provider-specific
accounts/mitm handling? What does the project's pinned pi-ai actually require,
versus choices made by the current local adapter?

Investigate:

- Resolve the pi-ai version and implementation from PDS's locked dependencies, not
  a version mentioned in an adapter comment or the latest upstream release.
- Trace enrollment, token exchange, and refresh separately. Determine whether a
  configured standard authorization-code/PKCE or device flow can satisfy the
  required account access, including relevant client/redirect restrictions.
- Trace credential use separately from enrollment: token interpretation, account
  identifiers, headers, and model-request construction. Identify which layer
  actually requires each behavior rather than assigning it all to accounts.
- Distinguish server/client-registration requirements, upstream pi-ai choices,
  and local implementation choices. Read pinned sources first, then consult
  authoritative protocol/provider documentation for facts the source cannot prove.
- If a standard route is unavailable, identify the evidence and the smallest
  OpenAI-specific behavior that would need a human decision. If compatibility is
  unverified, report that uncertainty instead of claiming impossibility.

The result is evidence for [[tasks/030-credential-contract.md]], not approval of an
exception. Any exception requires a human decision in that contract ticket;
research must not assume one is necessary or introduce a general provider-adapter
framework.

No product implementation, live account authorization, credential access, or
remote tracker activity is part of this investigation. Keep findings local and
record them as this ticket's resolution with source references.

## Evidence entry points

- [PDS dependency lock](../packages/pds/package-lock.json).
- [Harness dependency lock](../packages/durable/harness/package-lock.json).
- [PDS credential client](../packages/pds/src/auth.ts).
- [Local OpenAI implementation](../packages/mitm-proxy/openai.py).
- [Current accounts API](../packages/mitm-proxy/main.py).
- [Existing standard-OAuth implementation candidate](../packages/durable/api/src/accounts.ts).

## Resolution

**Standards-only remote accounts enrollment remains unverified; the current
Codex device adapter does not establish that a standard replacement is
impossible.** Codex browser enrollment and refresh use standard grants; its
device enrollment is not RFC 8628. Separately, pinned pi-ai's Codex request builder
interprets a provider-specific token claim. It natively accepts a Codex OAuth
access token through `apiKey`; that interpretation need not move into accounts or
mitm. The user subsequently clarified that mitm's credential-placement boundary is
guest egress, not host-native PDS/provider requests
([[tasks/000-foundation.md]]). A newer ChatGPT subscription flow avoids the claim
interpretation but introduces custom registration and a different inference
endpoint. The user subsequently selected PDS-owned login/storage with pi-ai's
provider authentication in [[tasks/030-credential-contract.md]]. That decision
supersedes the earlier accounts-owned Codex exception. These protocol findings
remain evidence; they do not require implementing OpenAI support outside pi-ai.

### Version and evidence boundary

[PDS's lock](../packages/pds/package-lock.json) resolves
`@earendil-works/pi-ai` **1.5.2**. Verified the [exact npm archive][pi-ai-archive]
against that lock's SHA-512 integrity. Compared the inspected installed JavaScript
and source maps under
`packages/durable/api/node_modules/@earendil-works/pi-ai/dist/` with the archive;
they match. Extracted source maps with distinct OAuth/provider paths. The local
adapter's 1.4.0 comment is not the dependency version.

The versioned source links below refer to that release. OpenAI documentation was
read on 2026-11-17 and describes the hosted service, not a pinned server version.
No live authorization, token inspection, credential access, or inference occurred.

### Codex enrollment, exchange, and refresh

[The pinned OAuth module][codex-oauth] separates these operations:

- **Browser enrollment:** `createAuthorizationFlow` uses public client
  `app_EMoamEEZ73f0CkXaXp7hrann`, `https://auth.openai.com/oauth/authorize`,
  authorization code, S256 PKCE, state, and scopes
  `openid profile email offline_access`. Its redirect is fixed to
  `http://localhost:1455/auth/callback`. It also sends the OpenAI extensions
  `id_token_add_organizations=true`, `codex_cli_simplified_flow=true`, and
  `originator`. Their presence is proven; their necessity is not. Static extension
  parameters could be configuration, but whether to admit them under the baseline
  remains a contract decision, not proof that executable provider logic is needed.
- **Remote callback:** localhost means the browser's machine. OpenAI documents
  [SSH forwarding of port 1455][codex-auth] as a headless fallback, so device
  enrollment is not inherently mandatory. Pi also accepts a manually pasted code
  or redirect URL. That does not establish a safe owner-bound web enrollment
  interface. Neither source establishes that this client accepts an arbitrary
  HTTPS accounts callback, or that a newly registered client gets equivalent Codex
  entitlements. Loopback redirects are a standard native-client mechanism
  ([RFC 8252 sections 7.3 and 8.4][rfc8252]); they do not authorize arbitrary
  redirect substitution.
- **Code exchange:** form POST to `https://auth.openai.com/oauth/token` with
  `grant_type=authorization_code`, client ID, code, verifier, and the matching
  redirect URI. This is authorization code plus PKCE, not a custom token grant
  ([RFC 6749 section 4.1.3][rfc6749], [RFC 7636 section 4.5][rfc7636]).
- **Refresh:** form POST to the same endpoint with `grant_type=refresh_token`,
  refresh token, and client ID. Pi reads `access_token`, `refresh_token`, and
  `expires_in`. The wire operation is standard refresh
  ([RFC 6749 sections 5.1 and 6][rfc6749]). Pi then separately decodes the access
  token to build its credential object; that is not part of the refresh grant.
- **Device enrollment:** JSON POST to `/api/accounts/deviceauth/usercode` returns
  `device_auth_id`, `user_code`, and an interval. Pi supplies the verification URL
  and 15-minute lifetime itself. JSON polling of `/api/accounts/deviceauth/token`
  sends `device_auth_id` and `user_code`; success supplies an authorization code
  and verifier, which Pi exchanges using
  `https://auth.openai.com/deviceauth/callback`. Pending responses include 403/404
  and `deviceauth_authorization_pending`. This differs from
  [RFC 8628 sections 3.1-3.5][rfc8628]: form requests, `device_code`, returned
  verification URI/lifetime, device-code grant at the token endpoint, and a token
  response on success. Endpoint configuration alone cannot bridge these formats.
  OpenAI also requires [device-login enablement][codex-auth] by the personal user
  or workspace administrator.

**Accounts need not decode Codex tokens merely to exchange, store, or refresh
those tokens.** Pi's `credentialsFromToken` requires
`["https://api.openai.com/auth"].chatgpt_account_id`; the
[local adapter](../packages/mitm-proxy/openai.py#L153) additionally derives expiry
from JWT `exp` and checks it against `expires_in`. These are implementation
choices layered on the grant. Generic accounts can use the token response's
expiry and retain the access token as opaque. Whether a consumer needs decoded
metadata is a separate question.

### Codex credential consumption is a different constraint

The [pinned provider][codex-provider] selects `openai-codex-responses` at
`https://chatgpt.com/backend-api`. Its [request implementation][codex-requests]:

1. Requires `apiKey`, then calls `extractAccountId` before network access. This
   decodes the JWT payload and requires the OpenAI `chatgpt_account_id` claim;
   it does not verify a JWT signature.
2. Builds `/codex/responses` requests and sets `Authorization: Bearer ...` and
   `chatgpt-account-id` **after** merging caller/model headers. Supplying that
   header separately cannot bypass token decoding or override the derived value.
3. Supports WebSocket requests and SSE fallback. Its SSE `fetch` override runs
   after token decoding; it cannot by itself remove this precondition.

Thus an ordinary opaque mitm capability cannot replace `apiKey` in the unchanged
Codex request builder. This proves a **pi-ai client requirement**, not that the
server requires clients to decode JWTs or that accounts must do so. The inspected
sources do not independently establish which backend headers the server enforces.

[Current PDS](../packages/pds/src/auth.ts#L59) replaces only the Codex provider's
authentication with a host token resolver, validates JWT-shaped token/status
metadata, and passes the access token to pi-ai. The
[owner control socket](../packages/mitm-proxy/main.py#L649) exports that token;
the [current proxy interception targets](../packages/mitm-proxy/main.py#L60) are
GitHub-only. Pi's own [Codex OAuth `toAuth`][codex-oauth] likewise returns
`{ apiKey: credential.access }`: the field accepts this OAuth access token, not
only static API keys. Under the subsequently clarified guest-egress boundary,
PDS need not use mitm or opaque capabilities. The subsequently selected PDS/pi-ai
login and shared host credential store replace the custom token-service resolver;
see [[tasks/030-credential-contract.md]]. No accounts-issued model token or pi-ai
adaptation is required by that selected path.

### Newer Sign in with ChatGPT is not a transparent replacement

Two distinct OpenAI products must not be conflated:

- [Website sign-in][siwc-website] documents standard authorization-code/PKCE and
  OIDC with registered callbacks. Its ordinary identity-only contract requires an
  ID token, **not** an access or refresh token. This does not establish Codex/model
  access for a registered accounts web client.
- [Open-source ChatGPT plan usage][siwc-overview] does authorize eligible model
  requests. It exists in pinned pi-ai 1.5.2 as the
  [`openai` provider][openai-provider] with
  [`openai-chatgpt` OAuth][chatgpt-oauth], separate from `openai-codex`.

The latter has these requirements:

- **Registration:** [OpenAI's sign-in contract][siwc-sign-in] starts with
  `client_id=dynamic_agent_client`, an app name, and stable `ext_agent_host_id`.
  The callback supplies an issued client ID, which is used for exchange and
  retained for reauthorization. This authorization/callback registration dance is
  not [RFC 7591's registration-endpoint protocol][rfc7591]. Calling the subsequent
  exchange standard OAuth does not make registration provider-neutral.
- **Grant and refresh:** authorization code/PKCE and form-encoded refresh at
  `https://auth.openai.com/api/accounts/oauth/token`, using the issued client ID,
  appropriate scopes including `chatgpt.tokens.use.direct`, and
  `resource=https://api.openai.com/v1`. The `resource` parameter is itself a
  [standard OAuth extension][rfc8707], not an OpenAI invention. OpenAI documents
  [rotating refresh tokens and serialized refresh][siwc-sessions].
- **Remote enrollment:** the [registration contract][siwc-sign-in] uses a
  `127.0.0.1` loopback callback, not an arbitrary HTTPS callback. Its
  [self-hosted VM guide][siwc-vms] documents local enrollment and secure credential
  transfer, followed by VM-owned refresh. That is not evidence for a remote
  accounts web callback or an RFC 8628 alternative. No credential-transfer feature
  or importer is selected by this finding. The [overview][siwc-overview] separately
  directs paid/remotely hosted app offerings to an interest form; the self-hosted
  VM procedure must not be generalized to every deployment model.
- **Inference:** [use `api.openai.com/v1/responses`][siwc-inference], not ChatGPT's
  `backend-api`. The access token is a bearer credential; OpenAI says to treat its
  [authentication metadata as opaque][siwc-tokens]. Pi's
  [Responses implementation][openai-requests] does not require a Codex account-ID
  claim. This removes that particular obstacle to proxy injection, not all
  integration work. Pi detects subscription mode using provider ID, base URL, and
  a non-`sk-` credential; proxy configuration must preserve the intended request
  behavior rather than accidentally selecting API-key behavior.
- **Compatibility:** available models depend on the account. OpenAI documents
  [request/tool/input restrictions][siwc-limitations], including `store=false`,
  streaming, and no Responses `tool_search`. Switching endpoints is not proof
  that all retained PDS models/features remain available. No account-specific
  entitlement or end-to-end compatibility was tested.

Do not blindly extract the pinned newer OAuth helper: it starts new registration
on each login and checks only ID-token presence. Current
[OpenAI instructions][siwc-sign-in] instead require reusing issued registrations
and validating the ID-token signature, issuer, audience, expiry, and nonce. This
is a concrete difference between pinned client behavior and current documentation,
not permission to expand this task into an authentication rewrite.

### Handoff: PDS-owned model authentication

The subsequent human decision is recorded in **What contract separates accounts
from credential consumers?** ([[tasks/030-credential-contract.md]]):

- **Enrollment and refresh:** PDS provides generic Datastar login UI and host
  credential storage; pi-ai owns the provider flows. Codex device enrollment stays
  supported through its built-in implementation. Do not extract the local adapter
  or add a Codex exception, JWT interpretation, or pi-ai dependency to accounts.
- **Codex browser enrollment:** the loopback/callback constraints above remain
  relevant if exposed through the generic UI. Reusing pi-ai does not establish an
  arbitrary HTTPS callback or remove browser/host locality constraints.
- **Codex inference:** retain the existing route, with pi-ai owning token
  interpretation and request authentication for SSE and WebSockets. PDS's shared
  `auth.json` replaces the custom host token-service path; no accounts or mitm
  integration is required for model authentication.
- **Newer ChatGPT plan usage:** researched above, but not selected by the confirmed
  Codex-route decision. It does not justify new registration or inference work in
  this cleanup.

The remaining generic login/storage contract belongs in that ticket. These
findings do not establish file-store interoperability, persistence guarantees, or
live end-to-end authentication.

The [existing generic accounts candidate](../packages/durable/api/src/accounts.ts)
contains standard code/device/refresh operations but does not establish OpenAI
compatibility: it assumes a fixed configured client ID and builds its own web
callback. Its GraphQL/pi-ai coupling is not a reason to preserve that architecture.
A verified arbitrary-HTTPS Codex registration, necessity of the browser extension
parameters, and account-specific model equivalence remain **unverified**, not
impossible. They do not block the selected accounts extraction: OpenAI is no
longer part of that component. Any live validation needs separate authorization.
The research remains closed with these bounded findings; the ownership revision
is a human decision, not a new compatibility claim.

[pi-ai-archive]: https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-1.5.2.tgz
[codex-oauth]: https://unpkg.com/@earendil-works/pi-ai@1.5.2/dist/auth/oauth/openai-codex.js
[codex-provider]: https://unpkg.com/@earendil-works/pi-ai@1.5.2/dist/providers/openai-codex.js
[codex-requests]: https://unpkg.com/@earendil-works/pi-ai@1.5.2/dist/api/openai-codex-responses.js
[chatgpt-oauth]: https://unpkg.com/@earendil-works/pi-ai@1.5.2/dist/auth/oauth/openai-chatgpt.js
[openai-provider]: https://unpkg.com/@earendil-works/pi-ai@1.5.2/dist/providers/openai.js
[openai-requests]: https://unpkg.com/@earendil-works/pi-ai@1.5.2/dist/api/openai-responses.js
[codex-auth]: https://developers.openai.com/codex/auth.md#login-on-headless-devices
[siwc-website]: https://developers.openai.com/siwc/website
[siwc-overview]: https://developers.openai.com/siwc/token-sharing-open-source
[siwc-sign-in]: https://developers.openai.com/siwc/token-sharing-open-source/sign-in
[siwc-sessions]: https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
[siwc-vms]: https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms
[siwc-inference]: https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
[siwc-tokens]: https://developers.openai.com/siwc/token-sharing-open-source/token-reference
[siwc-limitations]: https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
[rfc6749]: https://www.rfc-editor.org/rfc/rfc6749#section-4.1.3
[rfc7636]: https://www.rfc-editor.org/rfc/rfc7636#section-4.5
[rfc8252]: https://www.rfc-editor.org/rfc/rfc8252#section-7.3
[rfc8628]: https://www.rfc-editor.org/rfc/rfc8628#section-3
[rfc7591]: https://www.rfc-editor.org/rfc/rfc7591#section-3
[rfc8707]: https://www.rfc-editor.org/rfc/rfc8707#section-2

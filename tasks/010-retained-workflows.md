# Which workflows belong in the foundation?

- Label: `wayfinder:grilling`
- Mode: HITL
- Status: closed
- Assignee: Pi (retained-workflows session)
- Blocked by: none
- Map: [[TASKS.md]]

## Question

Which concrete user workflows must the independent components support before
app/www/durable can retire, and which experiments should be deferred or dropped?

Settle the minimum for each component without choosing protocols or porting code:

- PDS: local and SSH coding sessions, conversation controls, model selection,
  attachments, and any indispensable review or inspection workflow. Which harness
  extensions are required, optional, or unwanted?
- Accounts/mitm: required provider accounts and credential-consuming workflows.
  Distinguish the existing GitHub/OpenAI use cases from generic OAuth ambitions.
- Push: required producers and receiving devices; whether an inbox, notification
  actions, or agent completion alerts are foundation requirements beyond
  app-independent `notify-send` delivery.
- Rock5b: which operator and browser workflows must remain usable while the legacy
  applications are retired?

The answer should classify workflows as retain, defer, or drop, and name the
owning component. Do not treat current functionality as automatic scope. State
preservation is a separate decision in [[tasks/020-state-continuity.md]].

## Evidence

Use these as entry points for a focused inventory, not a feature-parity checklist:

- [PDS application](../packages/pds/src/application.ts) and
  [HTTP interface](../packages/pds/src/server.ts).
- [Retained harness candidate](../packages/durable/harness/src/index.ts) and
  [legacy harness](../packages/app/harness/index.ts).
- [Legacy review](../packages/app/serve/review.ts) and
  [inspection](../packages/app/serve/inspection.ts).
- [App enrollment interface](../packages/app/serve/auth.ts),
  [proxy authorization](../packages/mitm-proxy/auth.py), and
  [API account implementation](../packages/durable/api/src/accounts.ts).
- [App notifications](../packages/app/serve/notifications.ts) and
  [API push implementation](../packages/durable/api/src/push.ts).
- [Rock5b composition](../examples/rock5b/flake.nix).

## Resolution

Confirmed by the user in the retained-workflows discussion and follow-up answers.
The retained scope is settled; implementation feasibility and contracts remain
separate decisions.

- Retain PDS's existing coding feature set; no additional app/www features or
  harness capabilities are required. The user subsequently approved generic
  Datastar model login/logout with pi-ai and shared host credential storage as
  part of separating dependencies; see [[tasks/030-credential-contract.md]]. This
  is the explicit revision to the earlier feature-complete scope. The user later
  selected the durable API specification as the basis for PDS's HTTP surface,
  retaining mostly identical endpoints with Datastar/CQRS. This reopens the
  operation-surface limit, not wholesale app/www feature parity; the exact scope
  is decided in [[tasks/070-pds-http-contract.md]].
- Retain GitHub git/gh access and OpenAI/Codex model access on rock5b. Accounts/mitm
  serve the GitHub workflow; PDS/pi-ai own model authentication. Enrollment and
  credential plumbing may change.
- Standard OAuth without provider-specific handling remains the non-model
  accounts/mitm baseline, with the approved bounded HTTP 200 error-response
  compatibility in [[tasks/030-credential-contract.md]]. Model-provider protocols
  stay in pi-ai, not a local Codex adapter or an accounts exception; see
  [[tasks/030-credential-contract.md]] and the evidence in
  [[tasks/025-openai-oauth-compatibility.md]]. Mitm's placement policy covers guest
  egress, not host-native PDS/provider traffic; see [[tasks/000-foundation.md]].
- Push retains device registration and `notify-send`-originated delivery from app.
  Sending is required on guests only, not as the host Unix owner. Preserve the
  iPhone installed-PWA registration workflow, independently of the coding
  application. No inbox, actions, or direct coding-agent integration is required
  in this foundation. Internal delivery state is not an inbox feature.
- Rock5b should remain largely unchanged in user-visible functionality, apart from
  the explicitly excluded features and component separation. These workflows gate
  replacement of the live app entry point, not early cleanup of unused www or
  durable after extraction; see [[tasks/060-retirement-gates.md]].
- State retention and cutover policy are decided separately in
  [[tasks/020-state-continuity.md]].

### Relevant constraints found in code

- [Current OpenAI enrollment](../packages/mitm-proxy/openai.py#L89) uses custom
  device endpoints and response fields, then exchanges an authorization code.
  [Token handling](../packages/mitm-proxy/openai.py#L21) also interprets
  OpenAI-specific JWT claims. It is a retirement target, not an extraction basis
  for accounts: the selected replacement delegates this behavior to pi-ai.
- [PDS authentication](../packages/pds/src/auth.ts#L59) currently obtains an OpenAI
  access token directly on the host. This does not violate the guest-egress
  boundary, but its custom token-service resolver is superseded by the selected
  native pi-ai authentication and shared credential store in
  [[tasks/030-credential-contract.md]].
- [Current notification deployment](../nixosModules/guest/notifications.nix)
  installs the D-Bus notification server for the guest root user. Host-native
  sending is not established by that module.

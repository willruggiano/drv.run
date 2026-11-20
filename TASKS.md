# Independent components: decision map

- Label: `wayfinder:map`
- Status: closed
- Specification: [[SPEC.md]] (`ready-for-agent`; specification only)

## Destination

Settle the component contracts, retained functionality, state ownership, and
cutover requirements for retiring the live app entry point, removing unused
www/durable, and composing independent components on rock5b. Finish with
decisions sufficient to write an implementation specification, not an
implementation.

## Notes

- Foundation first. Preserve selected workflows, not feature parity with every
  experiment. The agreed constraints live in [[tasks/000-foundation.md]].
- Planning only. Do not turn decision tickets into implementation work or infer
  permission to delete code, discard state, or change a running deployment.
- Existing code is evidence, not a requirement to retain its behavior. Ticket
  sources refer to the checkout based on `9e36cb6f`; the newly squashed remote
  develop commit has not been inspected. Recheck sources before implementation.
- Follow [Wayfinder][wayfinder], [grilling][grilling], and
  [domain-modeling][domain-modeling]. Keep this effort's decisions and
  terminology here and in its tickets; do not create parallel ADRs or
  glossaries.

## Decisions so far

- Foundation scope: independent components, package-owned service modules, Unix
  user ownership, selective retention, guest-egress-only mitm placement, Go
  preferred outside required PDS/pi-durable integration, and Tailscale/LAN-only
  application access with HTTP authn/authz deferred
  ([[tasks/000-foundation.md]]).
- Retained workflows: existing PDS and credential-backed workflows, with PDS
  model login and guest-only push ([[tasks/010-retained-workflows.md]]). The
  subsequent PDS API/CQRS direction revises its operation-surface limit;
  [[tasks/070-pds-http-contract.md]] settles that scope.
- State continuity: clean-slate generated state; retain declarative
  configuration and provisioned secrets ([[tasks/020-state-continuity.md]]).
- **Can required OpenAI access use standards-only OAuth?**: provider protocol
  findings remain evidence; the selected PDS/pi-ai path needs no accounts-owned
  Codex exception ([[tasks/025-openai-oauth-compatibility.md]]).
- **Can retained GitHub enrollment use the standard OAuth implementation?**:
  documented HTTP 200 polling errors break the pinned strict parser; findings
  establish the need for bounded response compatibility
  ([[tasks/027-github-oauth-compatibility.md]]).
- **What contract separates accounts from credential consumers?**: PDS owns
  generic model login and shared Pi credential storage, with explicit storage
  failures and pi-ai refresh semantics. Go accounts owns Nix-configured
  non-model OAuth, its independent management UI, and owner-local token
  snapshots for mitm, with bounded provider-neutral HTTP 200 error handling
  ([[tasks/030-credential-contract.md]]).
- **What contract makes notifications independent of coding applications?**: Go
  guest/host push with SSH collection, best-effort delivery without durable
  queues or retries, persistent device registrations, and an independent PWA.
  Retain endpoint safeguards, not the TypeScript `push-policy` dependency
  ([[tasks/040-notification-contract.md]]).
- **What infrastructure interfaces should components consume?**: native OpenSSH
  configuration, optional read-only PDS discovery through owner-scoped CLI
  inventory, canonical guest-file trees produced by owner-scoped systemd units,
  package-owned `services.host`/`guest` exports in their native import scopes,
  and explicit public HTTP base URLs ([[tasks/050-infrastructure-contract.md]]).
- **What must be true before legacy packages can retire?**: only app needs live
  retirement planning; www is initial cleanup, durable follows extraction of its
  surviving assets into PDS. Separate repository verification from authorized
  rock5b acceptance, preserving contract coverage rather than legacy-only tools
  ([[tasks/060-retirement-gates.md]]).
- **Which CQRS HTTP contract should PDS expose?**: the complete old REST
  operation surface, HTML/Datastar representations, multi-Harness session
  addressing, explicit creation and recovery, and conversation-scoped
  environment selection integrated into creation/configuration commands
  ([[tasks/070-pds-http-contract.md]]).
- **How should standalone account enrollment behave?**: one configured grant and
  one transient attempt per owner/registration, browser-independent enrollment,
  atomic replacement with an explicit cancellation boundary, no upstream
  identity pinning, and distinct credential/attempt status for uncertain
  outcomes ([[tasks/080-accounts-enrollment.md]]).

## Not yet specified

No known decision blocks specification work. Concrete provider- or
browser-specific findings may require reopening a decision; possible future
findings are not an unresolved ticket or proof of compatibility.

## Handoff

- All decision tickets remain closed. The implementation specification is
  published locally at [[SPEC.md]], with the adapted PDS product contract at
  [[packages/pds/SPEC.md]] under [[tasks/070-pds-http-contract.md]]. The user
  confirmed the original test seams before publication. The guest-file
  integration resolution has since been explicitly revised with the user;
  implementation ticket 03's amended scope and two test seams are approved.
- Ticket 05 is separately authorized for implementation. Its session lifecycle
  is in [[packages/pds/src/application.ts]] and scoped HTTP routes are in
  [[packages/pds/src/server.ts]]. Retained single-store state is not migrated;
  deployment and state migration still require operator authorization.
- Ticket 23 includes a review of guest profile and shell-activation conventions.
  Ticket 03 retains the existing Nix-managed development profile; no rename or
  conversion to a global package profile is required. See
  [[nixosModules/host/pre.sh]] and [[nixosModules/guest/shell.sh]].
- The specification selects a Go OAuth dependency and specifies native-OpenSSH
  integration with pi-env. Source review is not runtime verification; the
  specification records remaining interoperability and acceptance obligations.
  Recheck the working tree and pinned dependencies before implementation.
- The decision map is closed, not product verification or deployment acceptance.
  The repository and authorized rock5b acceptance gates remain in
  [[tasks/060-retirement-gates.md]]. `ready-for-agent` classifies the new
  specification, not the closed decisions, and does not authorize
  implementation, code or state deletion, migration, or deployment.

## Out of scope

- Product implementation, deployment, data migration, or deletion in this map.
- State importers, archives, or seamless-cutover guarantees for disposable
  state; see [[tasks/020-state-continuity.md]].
- Reproducing all app/www/durable-api features or preserving their APIs for
  their own sake.
- Application-level HTTP authn/authz and public exposure. Authn/authz is
  intentionally deferred until stabilization; see [[tasks/000-foundation.md]].
- A new application identity platform separate from host Unix users.
- PDS features beyond the selected workflows, model credentials, and HTTP
  contract; see [[tasks/010-retained-workflows.md]],
  [[tasks/030-credential-contract.md]], and [[tasks/070-pds-http-contract.md]].
- Host-native notification sending, a notification inbox, notification actions,
  or direct coding-agent notification integration; see
  [[tasks/040-notification-contract.md]].
- A pi-coding-agent runtime dependency or consuming its settings, sessions,
  extensions, or model configuration. Only shared credential storage is
  selected.
- A general provider-adapter framework, custom model-provider authentication
  outside pi-ai, or provider-specific accounts/mitm OAuth handling; see
  [[tasks/030-credential-contract.md]].
- Speculative notification backends, plugin frameworks, or a generic harness
  product without a demonstrated requirement.

## Wayfinding operations

- This file is the map index. Each `tasks/*.md` file is one child decision
  ticket; its filename is its stable identity. Refer to tickets by their titles
  in prose.
- Ticket metadata records its `wayfinder:<type>`, HITL/AFK mode, status,
  assignee, and blockers. Ticket bodies contain questions and evidence, not
  assumed answers.
- The frontier is open, unassigned tickets whose blockers are all closed. Prefer
  filename order. Inspect metadata with:

  ```sh
  for ticket in tasks/*.md; do
    sed -n '1,/^## Question/p' "$ticket"
  done
  ```

- Claim a ticket by setting its assignee before working on it. An open ticket
  with an assignee is not available to another session. Recheck the file before
  editing.
- Resolve at most one decision ticket per session, except research. HITL
  resolutions require the user's answer; recommendations are not resolutions.
- Record the answer under `## Resolution`, then close the ticket and add one
  linked summary under Decisions so far. Preserve the question and its evidence.
- Create newly precise tickets before wiring their blockers. Remove their topics
  from Not yet specified. Reopen or revise invalidated decisions explicitly.
- Charting records the questions; it does not resolve them. The closed
  foundation ticket captures the preceding discussion, not a decision made by
  the agent.
- Keep everything local: no external issues, pushed research branches, or remote
  tracker synchronization. When the map clears, hand off to specification work.
- Check tracker changes with:

  ```sh
  markdownlint-cli2 --no-globs TASKS.md 'tasks/**/*.md'
  ```

[wayfinder]:
  https://github.com/mattpocock/skills/blob/5863806dd4e15c63174bee4e7515a4256792ecfa/skills/engineering/wayfinder/SKILL.md
[grilling]:
  https://github.com/mattpocock/skills/blob/5863806dd4e15c63174bee4e7515a4256792ecfa/skills/productivity/grilling/SKILL.md
[domain-modeling]:
  https://github.com/mattpocock/skills/blob/5863806dd4e15c63174bee4e7515a4256792ecfa/skills/engineering/domain-modeling/SKILL.md

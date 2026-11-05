# www

## Application scope and requirements

### Specification authority and contributor-guide applicability

This specification owns the browser application's behavior, state ownership,
package boundaries, and acceptance criteria. It is an end-state specification,
not an implementation sequence or a backend wire schema.

| Concern                                      | Authority                                                                                                                                      |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Core REST wire contract                      | [[packages/durable/api/SPEC.md]]                                                                                                               |
| Durable record and execution semantics       | Project-pinned upstream declarations cited in [^layout-records]                                                                                |
| Elm conventions, effects, and testing idioms | [[packages/www/CONTRIBUTING.md]]                                                                                                               |
| Application integration wire contracts       | Service-owned definitions requiring approval under [[packages/www/SPEC.md#Application integration endpoints outside the core Durable surface]] |
| Browser behavior and package edit scope      | This specification                                                                                                                             |

Existing frontend code is behavioral evidence, not authority for a new service
contract. Guide examples do not add features; the state-ownership policy below
supersedes examples discussing retained drafts. Report conflicts with an
upstream authority rather than silently redefining it here.

Verification ownership is indexed under
[[packages/www/SPEC.md#Behavior-to-suite ownership and preserved regression coverage]].

### Application responsibilities and package boundaries

`packages/www` is a standalone Elm application with two primary screens: a home
page for sessions and access to settings, and a streaming conversation page.
Global preferences, provider authorization, and device push controls share the
settings page. Conversation configuration and execution controls stay within the
conversation page rather than a set of explorer/viewer pages.

Elm owns application logic; browser adapters supply missing capabilities.
Services own session persistence, credentials, admission, execution, and
scheduling. The core transport is Durable REST/SSE, including its model catalog
and canonical conversation configuration endpoint. GraphQL is out of scope.

### Non-goals and external backend dependencies

No production server, Harness factory, execution engine, filesystem service,
credential store, offline mutation queue, migration, old-frontend removal, or
production cutover belongs to this package. Do not add a remote transaction
language, browser-side Chord/Harness runtime, or fork-creation feature.

Remote file reads/viewers, path or directory completion, review workflows,
branch/tree explorers, historical-context inspection, and execution-target
selection are out of scope. Local user-selected attachments remain supported;
reading those attachments is not an execution-environment filesystem API.

Application integrations, serving/security policy, and root CI registration are
external dependencies. Unresolved contracts block their client implementation;
unavailable deployed capabilities produce explicit unavailable UI. Neither is
permission to invent a protocol, fake success, or implement backend behavior
locally. The final allowlist controls all implementation edits.

### Existing behavior inventory and regression sources

Preserve the retained workflows, not the full feature inventory of the old
frontend:

| Area              | Required behavior                                                             | Regression evidence                                          |
| ----------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Home/settings     | Session CRUD, model selection, autosave, authorization, push controls         | Existing site, settings, and browser tests                   |
| Conversation      | Streaming, submissions/queue, tools, configuration, execution controls        | Existing conversation entry point and frontend browser tests |
| Rendering         | Markdown/code, local attachments, retained disclosures, history/search/export | Existing transcript, syntax, and state tests                 |
| Browser lifecycle | Reconnect, teardown, restoration, notification navigation                     | Browser adapters and worker tests                            |

Sources: [^layout-existing], [^behavior-tests], [^application-evidence]. Only
outcomes within this scope are regression requirements; the existing frontend is
not an implicit feature checklist.

## Table of Contents

- Application scope and requirements
  - Specification authority and contributor-guide applicability
  - Application responsibilities and package boundaries
  - Non-goals and external backend dependencies
  - Existing behavior inventory and regression sources
- Application architecture and state ownership
  - Runtime composition and dependency direction
  - Elm entry points, pages, domain modules, and public interfaces
  - Server observations, page-local input, and presentation state
  - Shared state, page transitions, and child outcomes
  - Request identities, route generations, and asynchronous ownership
  - TypeScript capability boundaries and export limits
- Routes and application shell
  - Route inventory, typed parameters, and invalid addresses
  - Initial loading, direct links, history, and external navigation
  - Conversation settings, query parameters, fragments, and dialogs
  - Page-local input and reset on navigation
  - Shared layout, navigation controls, and page-level failure states
- REST API and application integration contracts
  - REST-only integration and required endpoints
  - Required Durable operations and client-side projections
  - Identifiers, payloads, attachments, omission, and null
  - Success responses, transport failures, and operation errors
  - Snapshot observations, reconnects, and terminal events
  - Pagination, query ownership, ordering, and overlapping records
  - Application integration endpoints outside the core Durable surface
  - Server-enforced access policy and client-visible capabilities
- Session, settings, and authorization workflows
  - Landing page, session catalog, creation, naming, and archival
  - Model, thinking level, and working directory
  - Dependent model choices and unavailable values
  - Global settings, defaults, and per-model overrides
  - Single-flight autosave, failure recovery, and guarded navigation
  - Provider authorization, device flows, polling, and logout
- Conversation and execution workflows
  - Observed execution state, connection health, and usage indicators
  - Composer editing, command dispatch, and completion selection
  - File selection, paste, drop, previews, and attachment removal
  - Submission capture, delivery modes, admission, and queued input
  - Uncertain acknowledgements, receipt recovery, and newer edits
  - Queued-input withdrawal, execution abort, inspection, and resume
  - Reset, compaction, and completion timing
- Transcript and history rendering
  - Record projections, streamed answers, tools, and contextual groups
  - Markdown, incomplete content, and plain-text fallback
  - Syntax tokens, source preservation, and obsolete worker results
  - History pagination, selection, anchors, and export
  - Disclosures, stable node identity, and retained browser state
- Browser capabilities and resource lifecycle
  - Startup flags, adapter installation, and readiness
  - Port contracts, correlation, and explicit failures
  - EventSource ownership, replacement, and cleanup
  - Preference storage, restoration, and storage failure
  - Focus, selection, measurement, scrolling, and viewport changes
  - Custom elements, observers, workers, and exclusive DOM ownership
  - Service workers, asset caching, push permissions, and notification links
  - Page teardown, back-forward-cache restoration, and resource reacquisition
- Interface, safety, and performance requirements
  - Responsive layout, existing styles, icons, and visual parity
  - Keyboard interaction, IME composition, caret offsets, and Unicode
  - Semantic HTML, accessible names, focus order, and status announcements
  - Untrusted text, URL schemes, file content, and download safety
  - Input privacy, credentials, and private-response caching restrictions
  - Representative workloads, rendering measurements, and bounded caches
- Build, serving, and repository integration
  - Package entry points, static assets, and installed artifact layout
  - Elm and browser dependencies, lockfiles, registry data, and licenses
  - Reproducible Nix builds and package-owned checks
  - HTTP serving, deep-link fallback, headers, and asset-version transitions
  - Server composition, Harness ownership, and shutdown responsibilities
  - Development commands, test discovery, and CI integration
- Verification and acceptance criteria
  - Behavior-to-suite ownership and preserved regression coverage
  - Elm domain, transition, decoder, encoder, and route tests
  - Browser-adapter tests through public capability boundaries
  - Chromium tests for interaction, rendering, and browser lifecycle
  - HTTP/SSE integration against the real REST API implementation
  - Deterministic fixtures, race schedules, offline execution, and cleanup
  - Installed-package checks, optimized builds, and dependency isolation
  - Performance comparisons, safety checks, and accessible interaction
  - Behavioral acceptance and file-allowlist compliance
- Project layout and exhaustive file allowlist
  - Package tree and file responsibilities
  - Exact paths and package boundary; unlisted changes are forbidden
  - Files and responsibilities
  - Generated files, dependency pins, and build-output boundaries
  - Allowlist compliance and prior approval for amendments

## Application architecture and state ownership

### Runtime composition and dependency direction

```text
Browser.application / Main
  -> active Page.* -> domain modules + Api.* + reusable views
  -> narrow ports -> browser/main.ts -> browser capabilities
                                      -> lazy highlight.js
Separate service-worker runtime       -> sw.js
Api.* -> REST service                 -> backend-owned integrations / Harness
```

Production browser code does not import `packages/app`, either Durable package,
or their Node dependencies. Tests use the public `durable-api` entry point and
pinned upstream Durable/faux-provider APIs, never another package's private
modules or fixtures.[^layout-api-entry]

Effect sequencing follows the contributor guide; this package adds no alternate
effect runtime.

### Elm entry points, pages, domain modules, and public interfaces

`Main` is the single `Browser.application` entry point. It owns navigation and
maps the active page's messages/outcomes. Page modules keep their TEA lifecycle
together; views have no independent application lifecycle. Module conventions
and public-interface discipline follow [[packages/www/CONTRIBUTING.md]].

- `Session`, `Conversation`, `Entry`, `Submission`, and `DurableTask` own their
  domain types, validation, JSON codecs, and pure operations. Each exposes its
  own opaque `Id`; `Submission` also owns `RequestId`. There is no global
  identifier registry, generic tagged-ID framework, or central domain-types
  module. Related small types stay with their owner, not in one file per type.
- Domain modules have no dependencies on pages, `Html`, HTTP effects, ports, or
  browser resources. `DurableTask` describes observed task records and results;
  it does not implement scheduling. Its name avoids colliding with Elm's
  effect-oriented `Task` module.
- `Conversation` owns ancestry and conversation-level observations assembled
  from domain values. `Entry` owns content interpretation, context edits, and
  entry relationships. `Submission` owns admitted submission states and typed
  submission input; it does not own the page's editable composer, pending HTTP
  request, or acknowledgement uncertainty.
- `Api.Durable` and `Api.Application` construct REST requests and decode
  endpoint-specific envelopes using domain codecs. HTTP errors, cursors, and
  operation-specific transport shapes may live there; domain identities and
  records do not. No second hierarchy duplicates the same domain records, and no
  adapter recreates the old server's presentation protocol.
- `Page.Conversation` composes domain observations with local composer,
  selection, disclosure, search, configuration, and execution-control state.
- `Transcript` renders interpreted entries/messages; `Syntax` handles transcript
  code blocks. `Composer` and `Settings` provide reusable views, not
  authoritative domain records or independent application controllers.

The domain dependency graph must remain acyclic. Two identity-only leaf modules
break concrete cycles in this layout, rather than following a blanket
file-per-ID rule:

- A conversation's parent boundary references an entry; an entry records its
  originating conversation.
- An entry records its producing task; a compaction task result can identify an
  entry or a submission whose record identifies an entry.[^layout-records]

`Conversation.Id` and `DurableTask.Id` define only their domain's opaque
identity, validation, and boundary codecs. Their parent modules expose the same
type as `Id` through a type alias, not a second wrapper. Cross-referencing
domain modules use the leaf when importing the parent would create a cycle.
Pages and REST adapters use the parent domain interfaces. Neither leaf imports
another domain, and neither stores unrelated identifiers.

```text
Domain import direction (core packages omitted):

Entry        -> Conversation.Id, DurableTask.Id
Submission   -> Conversation.Id, Entry
DurableTask  -> DurableTask.Id, Conversation.Id, Entry, Submission
Conversation -> Conversation.Id, Entry, Submission, DurableTask
Session      -> Conversation

Page.Conversation -> domain modules + REST adapters + views
REST adapters     -> domain modules + HTTP support
```

Preserve typed cross-references rather than erasing foreign IDs to avoid an
import cycle.

### Server observations, page-local input, and presentation state

This is the authoritative input-lifetime policy. `Page.Home` and
`Page.Conversation` own their composer text, files/previews, edit revision,
completion state, and pending request captures. They exist only for the active
page lifetime and are never persisted or recovered from history, DOM values,
browser storage, or a hidden page model.

- Navigation to a new page lifetime, reload, document exit, and BFCache
  restoration discard this state without a composer-specific guard.
- Fragment-only navigation and ordinary visibility changes preserve the current
  lifetime. Routing defines the remaining page-boundary rules below.
- Leaving invalidates pending recovery and does not replay input later or abort
  admitted Durable work. Later pages load current service observations.
- While active, a pending operation holds an immutable capture separately from
  editable input. Acknowledgement handling belongs to
  [[packages/www/SPEC.md#Submission capture, delivery modes, admission, and queued input]].

Keep four separate concerns:

```text
service observation  validated current/stale data
editable input       current page's unsubmitted values
presentation state   selection, disclosure, search, focus, viewport intent
pending operation    captured values and operation identity/outcome
```

Loading, available, stale, empty, failed, and unavailable are explicit states.
An observation updates service-owned data, not editable input or presentation
intent. History is separate from active context; device preferences are separate
from server settings.

### Shared state, page transitions, and child outcomes

`Main` owns the active-page generation, browser readiness, and shared device
preferences. A child outcome requests navigation, preferences, or capabilities;
it does not mutate sibling state. Shared catalog caches are invalidated after
relevant settings, authorization, creation, or archival changes.

A different pathname or query creates a new page lifetime. Local panel changes
and fragment selection stay in the current lifetime; exact same-route navigation
is a no-op. The settings guard is defined under
[[packages/www/SPEC.md#Single-flight autosave, failure recovery, and guarded navigation]].
Resource release belongs to
[[packages/www/SPEC.md#Page teardown, back-forward-cache restoration, and resource reacquisition]].

### Request identities, route generations, and asynchronous ownership

Every asynchronous result is checked against its live owner:

```text
page generation + operation/request identity + relevant input revision
```

- Revisiting the same URL does not reuse the old generation. URL equality alone
  cannot authorize a callback. Invalidate ownership before requesting teardown.
- Command completions include text, caret, and dismissal generation. Local
  attachment reads include attachment identity; syntax work includes source
  identity; provider polling includes provider/action identity.
- Request counters are local correlation only. Durable request IDs are separate
  opaque strings generated for captures, never inferred from timestamps or text.
- Cancellation saves work where available but is not a correctness boundary and
  does not prove that a mutation was not admitted.[^layout-guide]

### TypeScript capability boundaries and export limits

- At most three exports per TypeScript module, counting type exports. No broad
  public internals, test hooks, or alternative application controller.
- Elm performs REST requests, field validation, receipt recovery, retry
  decisions, command dispatch, settings transitions, and notification policy.
- TypeScript may initialize Elm, attach ports, use EventSource, access storage,
  generate cryptographic identities, bridge missing DOM APIs, invoke the syntax
  library, and operate service-worker/PushManager APIs.
- Service-worker network handling is limited to its public-asset cache. Push
  subscription registration with the application service is an Elm HTTP action,
  not a hidden fetch inside a browser widget.

## Routes and application shell

### Route inventory, typed parameters, and invalid addresses

```text
/                                                   session listing and creation
/settings                                           preferences, authorization, device push
/sessions/{sessionId}                                resolve session's root conversation
/sessions/{sessionId}/conversations/{conversationId} streaming conversation
```

- Root resolution uses the approved session CRUD contract and replaces the URL;
  it does not guess a root ID.
- `Route` owns parsing/construction using validated domain identifiers. Invalid
  addresses show a scoped error with a home link, without requesting or mutating
  a different conversation.
- Configuration, reset, and compact controls are local panels/dialogs on the
  conversation page, not additional routes. Directly addressing a known
  conversation is supported without requiring a branch-navigation feature.

### Initial loading, direct links, history, and external navigation

- Every listed route works from a fresh document, reload, and browser history. A
  read-only initial load never submits input, resumes execution, or authorizes a
  provider automatically.
- Use `Browser.Internal`/`Browser.External` deliberately. Normal same-origin
  application links use Elm navigation; external links retain browser behavior,
  including modifier-click and opening a new tab.
- Navigate only after the relevant creation response establishes its
  destination. Validate returned identities and construct routes locally; do not
  execute arbitrary redirect URLs from response data.
- Back/forward changes the active route with the same ownership/reset rules as
  direct navigation. Unknown or missing sessions show a scoped failure page.

### Conversation settings, query parameters, fragments, and dialogs

- `?q={text}` on the conversation route initializes transcript search;
  `#entry-{entryId}` selects an entry. An unavailable anchor is explicitly not
  loaded/not found, not a guessed selection.
- Ignore unrecognized query keys; reject duplicate recognized keys. Invalid
  fragments do not trigger a data request or scroll to an unrelated element.
- Configuration/reset/compact panels are page-local. Opening them does not
  navigate or change composer lifetime. Reset/compact require confirmation;
  opening a dialog never invokes a mutation, and confirm is disabled while
  pending.

### Page-local input and reset on navigation

Route transitions apply the state-ownership lifetime policy. Opening a local
conversation panel or selecting an entry fragment is not navigation. Browser
back/forward dispatches the route transition rather than reactivating a retained
page model.

### Shared layout, navigation controls, and page-level failure states

- Provide a consistent catalog/settings entry, conversation title/navigation,
  panel close control, scrollable content region, and composer where applicable.
- Loading, empty catalog, missing conversation, unavailable integration,
  disconnected observation, and malformed response have distinct visible states.
  Preserve useful stale content with a stale indicator rather than blanking it.
- Retry controls address the failed read/capability. They must not replay an
  unrelated mutation. Page errors leave navigation and available controls
  usable.
- Update document titles to the current session/page without embedding untrusted
  markup. Focus newly opened pages/dialogs predictably.

## REST API and application integration contracts

### REST-only integration and required endpoints

`Api.Durable` consumes the subset below from
[[packages/durable/api/SPEC.md#Core surface]] using its
[[packages/durable/api/SPEC.md#Routes]]. That specification, not this document,
defines methods, addressing, encoding, bodies, and results. No parallel route
inventory or legacy command/presentation transport is required here.

### Required Durable operations and client-side projections

The transport contracts live in [[packages/durable/api/SPEC.md]]. This smaller
frontend needs:

- `models` for available Pi AI choices; `configure` for conversation model,
  thinking level, and cwd. No application endpoint duplicates these writes.
- `watch` for the active conversation and `entries` for transcript history,
  search, and export.
- `submit`, `submissionByRequest`, and `abortSubmission` for input admission and
  recovery; `abort`, `inspect`, and `resume` for execution controls.
- `reset` and `compact` for confirmed context actions; `scanTasks` and
  submission `status` only for compaction completion/timing.

Domain owners interpret records/documents; the backend does not supply display
labels or rendered message blocks. The API's broader surface does not require
www to implement every possible view, scan, or explorer.

### Identifiers, payloads, attachments, omission, and null

The core boundary follows [[packages/durable/api/SPEC.md#Wire types]];
validation and encoding techniques follow [[packages/www/CONTRIBUTING.md]].
Domain owners validate and wrap identifiers before values reach pages. Do not
use IDs arithmetically or collapse different identifier domains into one type.

Frontend-owned consequences:

- Unknown application entry kinds/document names remain inspectable; retain the
  opaque payload needed by history export rather than silently dropping it.
- Unsupported core variants produce a scoped decoder failure, not a fabricated
  idle/completed state.
- Captured input and attachment conversion are owned by the
  submission/local-attachment workflow sections. No separate upload protocol is
  introduced here.
- Application identifiers and DTOs await the service-contract approval below;
  legacy UUID conventions are not a new universal session-ID schema.

### Success responses, transport failures, and operation errors

`Api` classifies results according to
[[packages/durable/api/SPEC.md#HTTP errors]] and
[[packages/durable/api/SPEC.md#Wire types]], using the contributor guide's HTTP
boundary conventions. This document does not maintain another status table.

The page must distinguish usable results, service failures, invalid responses,
and an absent response. Only a validated acknowledgement can advance its
acknowledged state. Show scoped read failures without destroying useful stale
data; route ambiguous mutation outcomes to the owning workflow's recovery state,
not a generic automatic retry.

### Snapshot observations, reconnects, and terminal events

`Api.Durable` decodes the watch contract in
[[packages/durable/api/SPEC.md#watch() — GET /api/s/{sessionId}/c/{conversationId}/watch]].
`Page.Conversation` installs each validated view as its sole active observation,
leaving history, editable input, and presentation state separate. An addressed
identity mismatch or decoder failure must not partially update that view.

On interruption, retain useful content marked stale. Transport opening alone
does not make it current; a validated view does. Display terminal diagnostics
without inventing fields absent from upstream serialization. Signal terminal or
protocol failure to the stream owner defined under
[[packages/www/SPEC.md#EventSource ownership, replacement, and cleanup]].

### Pagination, query ownership, ordering, and overlapping records

Ordering, continuation, and completion follow the core scan contracts in
[[packages/durable/api/SPEC.md]]. Client state additionally owns:

- The entire query, generation, accumulated records, and continuation. Changing
  scope/filter/order or refreshing invalidates outstanding pages. Errors retain
  visible results marked incomplete; repeated continuations fail instead of
  creating an infinite request loop.
- Deduplication by domain identity, including inherited entries. Conflicting
  immutable records are protocol errors, not last-writer-wins updates.
- Separation of history from active observation: replacing the active view does
  not discard loaded history, and history cannot overwrite live documents.

Refresh triggers belong to the history workflow. Do not require an atomic
multi-request view beyond the guarantees of the core contract.

### Application integration endpoints outside the core Durable surface

Only three application integration families remain:

| Capability                                                     | Frontend owner / behavior authority |
| -------------------------------------------------------------- | ----------------------------------- |
| Session CRUD: catalog, root lookup, creation, naming, archival | Home/session workflows below        |
| Global preferences and provider authorization                  | Settings workflows below            |
| Push configuration, registration, and delivery payload         | Notification workflow below         |

Pi AI model discovery and conversation model/thinking/cwd configuration belong
to [[packages/durable/api/SPEC.md]], not these application contracts. Execution
targets are deployment-owned and are not selected by this frontend.

**Approval boundary:** before implementing an application client's decoder or
wire fixture, obtain approval for the service-owned contract and cite it here.
It must define addressing, request/response types, errors, access/capability
information, and recovery guarantees required by the workflow. No application
wire contract is selected here; the existing handlers are behavioral evidence
only.[^application-evidence]

A missing contract blocks that integration, not unrelated Durable REST work.
Unavailable/denied deployed capabilities show an explained unavailable state.
Verify interoperability against the approved service or independently
service-owned conformance examples, not merely a matching frontend fixture. The
frontend allowlist does not authorize backend or contract-file edits.

### Server-enforced access policy and client-visible capabilities

`Api.Application` consumes access/capability information only through the
approved service contract. Pages disable unavailable actions with an explanation
and keep permitted reads usable; an enabled action may still be denied by the
service. Provider login authorizes a provider, not access to this website.

Deployment enforcement and credential boundaries are owned under
[[packages/www/SPEC.md#Server composition, Harness ownership, and shutdown responsibilities]]
and
[[packages/www/SPEC.md#Input privacy, credentials, and private-response caching restrictions]].
The UI is not an authorization boundary.

## Session, settings, and authorization workflows

### Landing page, session catalog, creation, naming, and archival

- Show accessible sessions with name fallback, creation date, and root link.
  Loading, empty, retry, and archival states are independent of the composer.
- Capture selected model/thinking/cwd and optional initial input once. Create
  the session through its approved CRUD contract, configure its returned root
  through Durable, then submit initial input if present. These are separate
  operations, not a cross-service transaction; service-side initialization may
  apply defaults.
- Retain an established session identity within the active operation so retrying
  configuration or input cannot create another session. Show partial failures
  explicitly; navigate after setup/admission, or let the user open the created
  session with unresolved delivery clearly indicated. `/new` has no initial
  input.
- Use only the creation contract's approved recovery guarantees. Global defaults
  may initialize editable choices; they are not a second configuration writer.
- Naming is session-scoped. Update title/catalog after acknowledgement or
  reread; validation belongs to its service contract.
- Archive on an explicit action, disabling duplicate requests. Success removes
  the item and navigates away if that session is active; failure preserves it.
  Archival is not a local delete or an implicit execution-abort command.

### Model, thinking level, and working directory

- Model choices come from the Durable API's Pi AI catalog. Configure model,
  thinking level, and cwd exclusively through its `configure` endpoint; observe
  stored values through the conversation watch. Session CRUD owns lifecycle and
  naming, not a parallel conversation-settings mutation.
- Display stored/unset values honestly. The watch is not a resolved host-policy
  snapshot; do not manufacture a default model, working directory, or effective
  configuration. Global preferences can seed user selections for a new session.
- `cwd` is an optional literal directory field within the service-selected
  environment. It has no path completion, target selector, base-directory
  browser, or frontend filesystem validation. A configuration acknowledgement
  does not claim that the directory exists or is accessible.
- Show clear/unset controls with the semantics of the core configure contract.
  Merely loading the panel never writes defaults back as stored choices.

### Dependent model choices and unavailable values

- Preserve provider/model identity from the core model catalog; labels are not
  keys. Reconcile thinking choices with the selected model's supported levels.
- An existing model absent from the available catalog remains visible as
  unavailable; do not silently replace it. New model selection requires an
  available catalog entry. A catalog failure is distinct from an empty catalog.
- Refresh choices after authorization changes or explicit retry. A stale catalog
  response cannot overwrite newer selection. No application-owned model or
  target catalog is introduced.

### Global settings, defaults, and per-model overrides

`Page.Settings` exposes the implemented policy surface in the existing
[setting definitions](../app/serve/settings.ts): model/thinking defaults and
per-model overrides, execution/delivery policy, compaction/retry toggles, and
display preferences. Preserve its read-only numeric policy fields rather than
turning them into unsupported editors.

These definitions establish UI behavior, not a new serialization contract. The
approved settings service contract supplies values, choices, validation, and
save semantics. Model-provider transport policy is distinct from browser
observation transport. Without a shared settings capability, display its
unavailability rather than claiming a local save.

### Single-flight autosave, failure recovery, and guarded navigation

```text
acknowledged A -> edit B -> save B -> edit C -> acknowledge B -> save C
                                      C remains visible throughout
```

- One in-flight save per independently addressed settings resource. Capture the
  sent value; success advances that baseline only, then saves newer dirty input.
  Conversation configuration, name, and global settings are not one transaction.
- Validation failures preserve the previous baseline and editable fields. An
  ambiguous write failure invalidates confidence in the baseline; a field
  reverting visually to its old value is not proof it is saved.
- Do not automatically replay an ambiguous mutation. Offer reread/reconciliation
  and explicit retry; a point-in-time read does not prove a concurrent write
  cannot still commit. There is no promised multi-client conflict detection.
- While settings are dirty, saving, or uncertain, internal navigation offers
  stay, retry/save where valid, or explicit discard. External document exit uses
  a browser unload warning when supported, without relying on it for
  correctness.
- Browser back/forward must not bypass the settings guard or leave the URL and
  displayed page inconsistent. Stay/discard choices do not create history loops.
- This guard applies to settings only; state ownership defines composer exit
  policy. Save callbacks obey the common asynchronous-ownership rule. Behavioral
  evidence: [^autosave-evidence].

### Provider authorization, device flows, polling, and logout

- `Page.Settings` supports configured OpenAI/GitHub entries with distinct
  unconfigured, unenrolled, usable, unavailable, reauthorization, and pending UI
  states. The approved authorization contract maps wire states into these
  meanings; errors must not masquerade as logout.
- Login/logout require explicit actions. Show identity, device code, verified
  provider destination, expiry, and failure without tokens. A login response
  alone cannot prove the subsequent device flow succeeded.
- Poll while an active flow needs updates, with one read per provider in flight
  and bounded retry delay. Scope results to provider/action identity; logout or
  replacement invalidates old polls. Common lifecycle cleanup is defined below.
- Expiry clears actionable codes; usable status refreshes model choices. Keep
  provider errors local so other settings remain usable. Behavioral evidence:
  [^auth-evidence].

## Conversation and execution workflows

### Observed execution state, connection health, and usage indicators

- Render run state, streamed assistant/tool progress, retries, queued input,
  compaction, and interrupted work from typed observations.
- Connection health follows the watch-state section, independently of execution.
- Show stored model/thinking/cwd and observed usage when available. Selected
  model metadata can supply context-window capacity; otherwise show unavailable.
  Neither the model catalog nor the watch is a general host-policy endpoint.
- Keep numeric usage until display formatting, distinguish totals/capacity from
  estimates, and do not sum inherited history again into usage totals.

### Composer editing, command dispatch, and completion selection

- Preserve whitespace while editing. Whitespace-only input without attachments
  does not submit. Unknown leading slash commands show an error rather than
  silently becoming model input.
- Optional command entry invokes the same controls as buttons:

| Commands                           | Behavior                                 |
| ---------------------------------- | ---------------------------------------- |
| `/sessions`, `/settings`, `/model` | Home or local conversation configuration |
| `/search`, `/export`               | Transcript search or history export      |
| `/new`, `/rename`                  | Session creation or naming               |
| `/reset`, `/compact`               | Confirmed context actions                |
| `/stop`, `/resume`                 | Execution controls                       |

- Complete command names locally; there are no remote completion requests or
  special `@path` behavior. Arrow keys select, Enter/Tab accept, Escape
  dismisses; acceptance restores the caret and dismissed results remain
  dismissed.
- Attachments are never silently consumed by a command. Behavioral evidence for
  retained commands and keyboard handling: [^commands-evidence].

### File selection, paste, drop, previews, and attachment removal

- Accept file selection, pasted files, and drag/drop through one attachment
  model. Keep stable local IDs, order, filename, size, read state, and errors.
- Support PNG, JPEG, GIF, WebP and valid UTF-8 text without unsupported control
  characters. Reject unsupported binary content with a file-specific error; do
  not silently replace invalid bytes. Preserve text-file contents as a text
  block headed by `File: <JSON-quoted filename>` as in the current input format.
- Use Elm File APIs where sufficient; if strict UTF-8 validation requires byte
  decoding, perform it explicitly rather than trusting a permissive text reader.
- Preview/remove individual attachments without altering other files or text.
  Removal releases that preview's resources through the common teardown
  mechanism; pending captures use the submission workflow's reconciliation rule.
- Do not impose an undocumented universal size limit. Honor declared service
  limits and surface 413; base64 expansion counts toward the JSON body size.
  Encoding evidence: [^application-evidence].

### Submission capture, delivery modes, admission, and queued input

- Capture text, encoded files, entry metadata, edit revision, request ID, and
  `whenBusy` before sending. Every input submit supplies its capture's recovery
  key. Disable duplicate sends for that capture but allow new editing; file-read
  failures prevent admission of a partial capture.
- Offer `reject`, `steer`, and `followUp` with their upstream meanings. The
  configured default selects steering/follow-up; the alternate shortcut selects
  the other. A busy-state race is resolved by the backend, not a guessed UI
  lock.
- Display admission separately from execution progress, using the core submit
  contract rather than a local optimistic message or busy flag.
- Queue rows use observed submission IDs and modes, including passive writes the
  server may have admitted elsewhere. Do not offer input-only actions for writes
  or infer placement merely because a queue row disappears.
- Clear only the captured composer revision after established admission. Any
  subsequent text, file, or delivery-intent edit prevents that clearing, even if
  the current text happens to equal the sent text.

### Uncertain acknowledgements, receipt recovery, and newer edits

`Page.Conversation` uses the core admission/receipt semantics in
[[packages/durable/api/SPEC.md#Core surface]] for this local recovery state:

```text
send capture K -> admission established       => acknowledge capture
               -> non-admission established   => rejected; keep input
               -> outcome unknown            => uncertain; check receipt K
receipt check  -> admission established       => acknowledge capture
               -> no conclusive evidence     => remain uncertain
```

Recovery stays bounded: offer check-again and explicit retry, not endless
polling or automatic resend. An explicit retry uses the original capture/key; a
separate new submission needs a new identity and a warning if older delivery
remains unresolved. Receipt lookup retains the original conversation scope.

Apply the capture reconciliation rule regardless of snapshot/acknowledgement
ordering. Its authoritative definition is under
[[packages/www/SPEC.md#Submission capture, delivery modes, admission, and queued input]];
exit behavior belongs to state ownership.

### Queued-input withdrawal, execution abort, inspection, and resume

- Render each core withdrawal outcome distinctly. Withdrawal and Stop remain
  separate actions: failed withdrawal cannot silently become execution abort.
- Describe Stop using the scope established by the core abort contract, not an
  invented “abort everything” guarantee.
- Inspection renders interrupted/blocked work and available diagnostics without
  treating persisted failures as transport errors or inventing lost Error
  fields.
- Resume is an explicit Harness-scoped action. Refresh inspection/observation
  after acknowledgement instead of labeling work complete. The authority for all
  four operations is [[packages/durable/api/SPEC.md#Core surface]].

### Reset, compaction, and completion timing

- Reset/compact use confirmed captured input and the core operation contracts.
  Show admission, ongoing work, failure, and subsequent transcript/context
  changes separately. No historical-context inspector is required.
- Compute completion badges from completed compaction tasks and their summary
  references, resolving a summary write when necessary. Missing timing or
  placement yields no badge; HTTP latency is not task duration.[^layout-records]

## Transcript and history rendering

### Record projections, streamed answers, tools, and contextual groups

- `Entry` interprets messages, context boundaries, and tool relationships;
  `Conversation` combines them with live documents; `Transcript` renders the
  resulting content without decoding transport payloads.
- Distinguish committed history from the partial assistant answer. A committed
  replacement appears once, not in both regions.
- Match tool calls/results by identity, including nested progress, errors,
  truncation, patches/diffs, successful writes, and unmatched results.
- Group turns, tools, thinking, and reset/compaction boundaries with
  disclosures. Keep source records for history/export; missing relationships
  remain explicit. Application/file-path text in messages does not create
  navigation features.

### Markdown, incomplete content, and plain-text fallback

- Required subset: paragraphs, line breaks, level-one through level-four source
  headings, bold text, inline code, fenced code with language hints, links, and
  permitted image references. This is not a claim of CommonMark compatibility.
- Incomplete fences, links, and emphasis remain readable while streaming.
  Preserve original text and use plain text for malformed/unsupported constructs
  instead of dropping it or emitting broken HTML.
- Construct Markdown nodes under the safety policy in
  [[packages/www/SPEC.md#Untrusted text, URL schemes, file content, and download safety]],
  using the contributor guide's rendering conventions.
- Code spans/fences suppress Markdown interpretation within them. Source
  headings do not replace the page's accessible heading
  structure.[^rendering-evidence]

### Syntax tokens, source preservation, and obsolete worker results

```text
concatenate(token.text) == original source
```

- `Syntax` selects canonical languages from known aliases/extensions; unknown
  languages render plain text. Load `highlight.js` only when required.
- Requests/results carry owner and request identities. Validate token text and
  allowlisted classes before accepting them; a mismatch keeps plain source and
  reports a scoped failure. Never accept tokenizer-supplied HTML.
- Reuse tokens only for the same language/source. Edited or removed sources and
  old pages ignore late replies, including lazy-import failures.
- Highlighting uses the lazy module, not another application worker or an
  additional worker entry point.
- Bound tokenization work and retained source/token data; oversized content
  remains readable without highlighting.[^syntax-evidence]

### History pagination, selection, anchors, and export

- Load history incrementally with clear progress, more/refresh controls, and
  retry at a failed page. Never label a partial scan as complete search/export.
  Refresh after observed context/head changes or run settlement as well as user
  actions; the highest ID in a snapshot is not a history completeness watermark.
- Entry anchors load additional history when possible, then report absence if
  exhausted. Selection survives unrelated snapshot and tool updates.
- Following the latest entry is explicit viewport intent. New output may scroll
  only while following; reading older content or selecting a search result stops
  automatic following until the user requests latest again.
- Export uses ascending `entries` pages and downloads a JSON array of complete
  upstream records, including application data, not rendered text or HTML. Do
  not export only the active-context snapshot. On failure, do not silently
  download a partial result as complete history.
- An export is an ordered read, not an atomic point-in-time session backup. Its
  download is subject to the common asynchronous-ownership rule.

### Disclosures, stable node identity, and retained browser state

- Key transcript entries, tool rows, and local attachments by stable identity
  within their sibling scope. List position, current label, and rendered text
  are not keys. Prefix different identity domains when they share a sibling
  list.
- Preserve disclosure state, DOM selection, and scroll position during unrelated
  snapshot/tool updates. Do not reparent completed nodes to simulate chronology.
- Prune local disclosure/cache entries when their owner disappears; they are not
  cross-page persistence. Browser-native state and Elm-owned state have explicit
  ownership and are not both updated independently.
- Use lazy views only where arguments stay stable and measurements show benefit;
  stable DOM identity is a correctness requirement even without memoization.

## Browser capabilities and resource lifecycle

### Startup flags, adapter installation, and readiness

- The static shell loads optimized Elm as a classic script and `client.js` as a
  module. Bootstrap initializes exactly one application after Elm and the mount
  point exist; initialization failure yields a readable startup error.
- Flags contain a protocol version, browser feature availability, and validated
  device preference defaults/results, not conversations, secrets, or
  server-owned state. Elm accepts a decodable value and can render invalid-flags
  failures.
- Install port subscribers before sending an explicit ready event. Elm does not
  send capability work until readiness; no zero-delay timer is the handshake.
- Lazy capabilities acknowledge their own availability/failure. Missing storage,
  worker support, or highlighting does not prevent ordinary conversation reads.

### Port contracts, correlation, and explicit failures

- Declare ports only in `Main`. Use a small tagged capability protocol with a
  version, owner, request ID where applicable, and typed payloads. Decode once
  at the boundary; do not route arbitrary strings as application messages.
- Commands cover stream open/close, preferences, identity generation, required
  selection/DOM operations, tokenization, browser lifecycle, and push
  capabilities. Replies distinguish success, unsupported, denied, and failed
  operations.
- A stream lease differs from a one-shot request. Both discard replies after
  replacement. Asynchronous failures carry the same identity as successes.
- Never pass `File` handles through JSON serialization; use Elm's supported file
  decoder/selection APIs. Browser objects, promises, and exceptions do not leak
  into ordinary domain models.

### EventSource ownership, replacement, and cleanup

`browser/main.ts` owns one EventSource lease for the active conversation page.
It implements the core watch lifecycle, with native reconnect rather than a
competing timer. Opening a replacement invalidates/closes the previous lease;
terminal/protocol failure closes it and requires an explicit new open action.

Lease identity uses the common asynchronous-ownership rule. Page/document exit
uses the common teardown mechanism below. The adapter reports transport events;
`Page.Conversation` owns stale/current/failed presentation under
[[packages/www/SPEC.md#Snapshot observations, reconnects, and terminal events]].
Behavioral evidence: [^browser-evidence].

### Preference storage, restoration, and storage failure

`Main` owns device display preferences; `browser/main.ts` only reads/writes
them. Code wrapping defaults to false (`pi.html.wrap-code`), bottom alignment to
true (`pi.bottomAlign`). Malformed/missing values use defaults. Storage
exceptions keep the in-memory choice and produce a non-blocking “not persisted”
result.

These are the only persisted client values; input lifetime is defined under
state ownership and sensitive-data restrictions under privacy. Storage handlers
do not independently toggle application classes or controls.[^browser-evidence]

### Focus, selection, measurement, scrolling, and viewport changes

- Prefer `Browser.Dom` for supported focus/viewport operations. Missing browser
  operations such as textarea selection return correlated results through ports.
- DOM work occurs after the relevant rendered node exists. Missing or replaced
  nodes are recoverable failures, not uncaught exceptions or focus on another
  page.
- Restore focus after completion acceptance and dialog closure without stealing
  it on every snapshot. Preserve manual selection while output streams.
- Observe scroll/resize only while needed and coalesce measurements. These
  resources use the common ownership/release mechanism below.
- Mobile keyboard/viewport changes must not obscure the composer or reset
  follow-latest intent. Measurement is not permission to rewrite Elm-owned DOM.

### Custom elements, observers, workers, and exclusive DOM ownership

- Prefer normal Elm views. A custom element is justified only for a missing
  browser capability, with explicit inputs/events and an isolated owned subtree.
- Elm and browser code never both render the same descendants. Browser-owned
  elements cannot hide application state machines, network operations, or
  settings controls from Elm.
- Connection installs the element's capability handlers; disconnection delegates
  to its common release path. No alternative lifetime manager is introduced.
  Service-worker lifetime is independent of an element or active page.

### Service workers, asset caching, push permissions, and notification links

- Register `sw.js` at the origin root in a secure context. Its fetch handler
  enforces the cache policy under
  [[packages/www/SPEC.md#Input privacy, credentials, and private-response caching restrictions]].
- Cache identity/activation follows the asset-version contract in the serving
  section. Delete only this application's obsolete caches; failed installation
  preserves the last usable worker/cache.
- Notification permission requires an explicit user gesture. Elm renders
  unsupported, denied, host-disabled, checking, enabled, and failed states.
- Enabling push obtains a browser subscription, then registers its serialized
  value through Elm HTTP. Disabling/key rotation reconciles backend registration
  and browser unsubscription; partial failures remain visible and retryable. Do
  not declare success merely because permission is granted.
- Decode the approved service-owned push envelope; reject malformed data and
  bound displayed text. Icons are local assets. Navigation targets must be a
  validated same-origin catalog/conversation route; invalid targets fall back to
  `/` rather than opening an arbitrary origin.
- Click closes the notification and focuses an exact matching same-origin client
  or opens the validated destination. No message text is executable markup.
  Notification delivery/storage remains a backend
  responsibility.[^notification-evidence]

### Page teardown, back-forward-cache restoration, and resource reacquisition

This is the common resource-release mechanism. `Main` invalidates the outgoing
page generation and cancels supported Elm effects; `browser/main.ts`
idempotently disposes its browser resources. On document `pagehide`, resources
that cannot survive suspension are released synchronously. Custom-element
disconnection invokes the same owner's release path, not a second application
lifecycle.

| Resource                        | Release action                                        |
| ------------------------------- | ----------------------------------------------------- |
| EventSource                     | Close source and detach callbacks                     |
| Observers/listeners             | Disconnect/remove                                     |
| Timers/animation frames         | Cancel scheduled callbacks                            |
| Attachment/download object URLs | Revoke                                                |
| Lazy imports/tokenization       | Invalidate request ownership                          |
| HTTP/polling operations         | Cancel where supported; invalidate results regardless |

A persisted `pageshow` emits one restoration event. `Main` creates a fresh page
lifetime, applies the state-ownership policy, and reacquires reads/capabilities.
Ordinary visibility changes instead pause optional polling and refresh stale
reads on return without replacing the lifetime. No parallel acquisition may
leave multiple live owners of the same capability.

The origin's service-worker registration is not page-owned and remains active.
The settings unload guard is also separate; it cannot substitute for
pagehide/pageshow handling.[^browser-evidence]

## Interface, safety, and performance requirements

### Responsive layout, existing styles, icons, and visual parity

- Preserve the current stacked conversation layout, typography, colors,
  code/tool treatment, compact usage bar, attachment affordances, pane controls,
  and icons. Existing styles are reference material, not a runtime import from
  `packages/app`.
- Verify desktop, intermediate, and narrow/mobile layouts, including 1440×900,
  900×900, and 390×844. Content scrolls within the intended region; controls do
  not overlap text, disappear below the keyboard, or force page-wide overflow.
- Keep panel close controls spatially consistent with their openers where the
  existing layout does. Long paths, names, code, and errors must remain usable.
- `tests/design-system.html` exercises shared styles and state variants. Its
  packaging is governed by the artifact contract.[^behavior-tests]

### Keyboard interaction, IME composition, caret offsets, and Unicode

- Enter inserts a newline in the composer. Ctrl/Meta+Enter sends with the
  primary delivery mode; Alt+Enter uses the alternate mode. Completion
  acceptance takes ordinary Enter/Tab when a completion is selected; modified
  Enter still sends.
- Decode `isComposing` and track composition lifecycle. Composition confirmation
  never submits, invokes a command, or accepts an unrelated completion.
- Keep DOM UTF-16 caret offsets distinct from Elm character indexing;
  conversions preserve astral characters, combining sequences, command text, and
  text before and after the replacement range. Do not truncate a surrogate pair.
- Scope Escape/arrows/shortcuts to the active widget. Prevent browser defaults
  only when an action actually consumes the event; preserve selection/copy,
  modifier navigation, and ordinary editing elsewhere.[^commands-evidence]

### Semantic HTML, accessible names, focus order, and status announcements

- Use links for navigation, buttons for actions, associated labels for fields,
  and explicit accessible names for icon-only controls. Disabled/loading/error
  states are programmatically available, not color-only.
- Use meaningful landmarks and heading order. DOM reading order matches visual
  chronology; CSS reversal cannot repair inaccessible source ordering.
- Completion lists expose selected options and keyboard behavior. Dialogs manage
  initial focus, Escape, focus containment when modal, and return focus on
  close.
- Announce operation/connection outcomes without announcing every streamed
  token. Errors identify the affected field/resource and leave a keyboard
  recovery path.
- Verify keyboard-only navigation, visible focus, text scaling, and accessible
  names in the browser; a screenshot alone is not accessibility evidence.

### Untrusted text, URL schemes, file content, and download safety

- Treat model output, tool output, metadata, filenames, and problem details as
  untrusted text. Never use them as HTML, selectors, executable CSS, or scripts.
- External clickable URLs allow HTTP(S) only; reject credentials, control
  characters, active schemes, and protocol-relative ambiguity. New-tab links use
  `noopener noreferrer`. Filesystem paths and relative file references remain
  inert text; they do not produce a file-viewer link or remote fetch.
- Only validated raster image blocks or local attachments become image sources.
  No remote Markdown image fetch, SVG execution, or HTML preview.
- Export/download filenames are derived from validated identities or sanitized
  names. No untrusted path controls a local output location; download resources
  participate in the common release mechanism.
- Unsafe references stay readable as text without speculative fetching.
  Behavioral evidence: [^rendering-evidence].

### Input privacy, credentials, and private-response caching restrictions

- Input lifetime is defined under state ownership. Discarding input makes no
  promise of secure memory erasure or removal of admitted backend data.
- No client analytics, content-bearing debug logs, or credentials in flags,
  URLs, or preferences. Diagnostics identify operation/category without dumping
  captures, provider secrets, push subscriptions, or device codes.
- The worker may cache same-origin JavaScript, CSS, icons, and manifest assets
  from the build inventory only. Navigation documents, API/SSE responses,
  private content, and mutations never enter it. Other browser persistence is
  limited by the device-preference section, not a local session database.
- Core HTTP caching follows the REST authority. Application services must
  prevent shared caching of private responses; browser cache exclusion is not a
  substitute for this deployment responsibility.
- Push registration and device-code transport use same-origin HTTPS. Display
  only information needed for the explicit user action; deployment owns
  push-content policy.

### Representative workloads, rendering measurements, and bounded caches

- Benchmark empty, small, and large histories; use 600 and 3,000 entries with
  user/assistant/tool turns, 40 streamed replacements, and 10 busy/idle cycles.
  Include transcript search, code highlighting, and return navigation.
- Measure initial usable render, snapshot application, interaction latency, DOM
  counts, asset size, and retained memory after navigation. Report raw samples,
  hardware, compiler/browser versions, viewport, and workload parameters.
- Compare equivalent visible workloads with the existing renderer; distinguish
  its delta transport from the new full snapshots. Record bytes separately from
  rendering time rather than attributing transport differences to the DOM.
- At least three fresh-browser timing runs; separate profiling and forced-GC
  memory runs. Investigate regressions and obtain approval for accepted
  tradeoffs; do not invent passing latency numbers or silently reduce the
  workload.
- No unbounded syntax, query, disclosure, or detached-page caches. Bound
  optional caches explicitly and prune by owner/current source; paginated
  retained history is visible loaded data, not permission to cache every visited
  session forever. Avoid repeated full-history scans on each token
  update.[^performance-evidence]

## Build, serving, and repository integration

### Package entry points, static assets, and installed artifact layout

`build.ts` is the shared build for local use, Nix, browser tests, and
benchmarks. Its default local output is `packages/www/dist`; Nix installs the
same public artifact set under `$out/share/www`:

```text
index.html
main.js
client.js
highlight.js
sw.js
styles.css
icon.svg
icon-192.png
icon-512.png
manifest.webmanifest
```

`src/Main.elm` produces optimized `main.js`. The three browser entry points
produce `client.js`, lazy `highlight.js`, and `sw.js`. The remaining assets are
copied from `public/`; required notices accompany their bundles.

Output contains no backend, npm installation, sources, tests, benchmark tooling,
or production Node executable. `tests/design-system.html` is test-only. Explicit
output-directory arguments cannot authorize overwriting source trees.
Verification belongs to `build.test.ts` and the installed-package checks below.
Build evidence: [^layout-build].

### Elm and browser dependencies, lockfiles, registry data, and licenses

- Use the project-pinned Elm 0.19.2 toolchain and compatible package versions;
  browser/http/file/url/time/test packages become explicit dependencies when
  used. Keep `elm.json`, `deps.json`, and `registry.dat` consistent.
- Declare browser, build, and test dependencies in the package's own npm
  manifest and lockfile. No resolution through the old app workspace or
  arbitrary latest Pi releases. Tests use the flake-pinned Durable/faux-provider
  versions.
- Syntax highlighting is the isolated third-party browser dependency. Do not add
  SPA, effect, component, codec, or state-management frameworks.
- Keep TypeScript strict; separate Window/DOM and service-worker global scopes.
  Build/Node test types must not accidentally make Node APIs legal in browser
  code.
- Preserve source-license obligations when adapting code. The artifact contract
  defines notice placement; no license-notice source file is implicitly added.

### Reproducible Nix builds and package-owned checks

- `default.nix` pins npm and Elm inputs; Nix builds/checks run without network
  lookups or an inherited developer cache. Include the relevant allowlisted
  manifests, sources, assets, and tests in each derivation's source set.
- The static package's `checkPhase` invokes the package `check` and `test`
  commands defined below; those commands own the suite inventory.
- Expose Chromium suites through `passthru.tests.chromium` with pinned browser
  dependencies and the public REST API test dependency. Expose the rendering
  benchmark through `passthru.bench.render`, not as a flake check.
- Put API/provider test dependencies in check derivations, not the static
  package's runtime closure. The fixture section owns test-resource cleanup.
- No NixOS VM test is required for this static package.

### HTTP serving, deep-link fallback, headers, and asset-version transitions

- Deployment serves the static directory with correct media types and returns
  `index.html` for recognized application routes, not for missing assets or API
  errors. API routing takes precedence over SPA fallback.
- Honor the core transport's buffering/header requirements and the privacy
  section's caching policy. Static assets use correct media types and `nosniff`;
  private API content must not become an executable document.
- Use same-origin script/style policy, restricted framing/base/form targets, and
  only the image/blob capabilities actually required. The static frontend must
  work without inline executable scripts or `unsafe-eval`.
- Version the complete asset set. Stable public filenames require revalidation
  and coordinated deployment; do not mix an Elm bundle and bridge from different
  builds. A worker update cannot claim compatibility merely because URLs match.
- Detect incompatible startup protocol/build identity and offer reload rather
  than continuing with mismatched ports. New workers do not force reload, and
  old asset sets remain available for active clients until safe replacement.

### Server composition, Harness ownership, and shutdown responsibilities

```text
external HTTP service
  core REST routes             -> public Durable API
  approved application routes  -> service-owned integrations
  assets + UI routes           -> www static directory
```

Deployment owns the listener, access/CSRF policy, Harness factory, application
integrations, telemetry, and orderly shutdown. The public API's acquisition and
shutdown contract is authoritative; www adds no close-service operation.

Use same-origin service URLs and ambient browser credentials. Hiding controls is
not access enforcement: the service must authorize every operation and enforce
environment access and request limits. Serving this static package alone does
not establish a secure deployment.[^security-evidence]

Fixtures compose the public API with upstream Harnesses and, once approved,
application contracts. They are not a production server.[^layout-api-entry]

### Development commands, test discovery, and CI integration

Package commands are explicit and runnable from the repository root:

```sh
npm --prefix packages/www run build
npm --prefix packages/www run check
npm --prefix packages/www test
npm --prefix packages/www run test:browser
nix build .#www .#www.tests.chromium
nix run .#www.bench.render -- --help
```

- `check` validates Elm formatting/optimized compilation and both TypeScript
  scopes; `test` runs Elm and `tests/*.test.ts`; `test:browser` runs the three
  `tests/*.chromium.ts` suites. Benchmarks are a separate explicit command.
- Do not claim root `just chromium` or `nix flake check` already discovers www:
  the current root configuration does not register its browser/check
  derivations. Package commands and passthru outputs are in scope; root CI/check
  registration requires a separately approved change.[^build-evidence]
- Final integration must invoke package checks in CI. Until that external wiring
  exists, report it as pending and run the package outputs explicitly; passing
  unrelated root checks is not verification of www.

## Verification and acceptance criteria

### Behavior-to-suite ownership and preserved regression coverage

The linked sections own requirements; this table owns their verification
assignment. Exercise each invariant at its narrowest public boundary. Browser
suites test integration, not copies of every domain fixture.

| Requirement authority                                                                              | Verification owner                                                                     |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Domain ownership and interpretations in architecture/transcript sections                           | Domain Elm suites                                                                      |
| [[packages/www/SPEC.md#Server observations, page-local input, and presentation state]]             | `PageTest`; conversation Chromium lifecycle cases                                      |
| Routes and application shell                                                                       | `RouteTest`; page Chromium navigation cases                                            |
| Core REST authority and client projections                                                         | `ApiTest`; real REST/SSE integration                                                   |
| Approved application contracts and settings workflows                                              | Service conformance evidence; `AutosaveTest`, `PageTest`, pages Chromium               |
| Conversation admission/recovery workflows                                                          | `PageTest`; conversation Chromium effect cases                                         |
| Transcript, syntax, and local attachments                                                          | `EntryTest`, `TranscriptTest`, `SyntaxTest`, highlight tests; attachment browser cases |
| [[packages/www/SPEC.md#Page teardown, back-forward-cache restoration, and resource reacquisition]] | Conversation/pages Chromium resource cases                                             |
| Worker/cache/push behavior                                                                         | Worker event tests; notifications Chromium                                             |
| Interface safety/accessibility                                                                     | View tests; pages Chromium                                                             |
| [[packages/www/SPEC.md#Package entry points, static assets, and installed artifact layout]]        | Build tests; installed Nix outputs                                                     |
| [[packages/www/SPEC.md#Representative workloads, rendering measurements, and bounded caches]]      | `bench.ts`, outside correctness checks                                                 |
| Final file allowlist                                                                               | Complete change review                                                                 |

Existing regression evidence is [^behavior-tests]. Testing conventions and
public-interface discipline remain in [[packages/www/CONTRIBUTING.md]].

### Elm domain, transition, decoder, encoder, and route tests

Use independent wire examples from the contract owner alongside round trips; the
same encoder/decoder mistake must not satisfy both sides of a test. Fuzz
validated domain and URL invariants with deterministic seeds.

For page/Autosave transitions, schedule result ordering explicitly, including
newer edits before acknowledgement, same-route revisits, dismissed completion
results, and removed-attachment reads. Assert public state and semantic view
messages. Testing opaque effects follows the contributor guide; actual effect
execution belongs to integration tests.

### Browser-adapter tests through public capability boundaries

Drive registered ports, DOM events, and worker handlers. Observe replies,
resource ownership, and lifecycle state rather than exporting private helpers.
Use narrow platform doubles with explicit success/failure schedules for APIs
that cannot run offline; type each test in its appropriate browser/worker scope.
The ownership matrix above identifies the requirements each suite verifies.

### Chromium tests for interaction, rendering, and browser lifecycle

Run the optimized built assets and assert observable behavior at the viewports
specified by the interface section. Use DOM identity, selection/focus, event
ordering, accessible roles, and geometry as evidence where Elm tests cannot
exercise the browser.

For BFCache acceptance, assert that a persisted restoration actually occurred; a
fresh document loaded by Back is not equivalent. Record unsupported browser
conditions explicitly. Capture console errors/unhandled rejections, and run
repeated navigation cycles to measure retained resources against baseline.

### HTTP/SSE integration against the real REST API implementation

Use `durable-api`'s public entry point, a real upstream Harness, and the pinned
faux provider. Exercise the www client's operation mapping and observation flow
through HTTP/SSE, not a mocked core handler or private fixture imports. Do not
duplicate the API package's own conformance suite.

Application integration follows its approval gate: fixtures derive from the
agreed service-owned contract, and interoperability evidence comes from the
service or independent service conformance examples. Record deployment
availability separately from client/fixture success.

### Deterministic fixtures, race schedules, offline execution, and cleanup

- Keep fixture records minimal; use upstream public Harness/faux-provider APIs
  rather than a new fake execution engine. No dependency on old private
  fixtures.
- Gate races with explicit promises/events or controlled responses, not
  arbitrary sleeps. Use bounded condition waits for browser readiness and clean
  timeouts.
- Run offline: no external models, authorization accounts, push services, or
  public network resources. Simulate provider/push browser boundaries explicitly
  while testing real local HTTP and worker registration where relevant.
- Every test owns and closes HTTP listeners, API/Harness instances, contexts,
  pages, worker resources, temporary directories, and pending operations even
  after failure. Use unique resource namespaces to avoid cross-test state.

### Installed-package checks, optimized builds, and dependency isolation

Verify the artifact contract by serving installed output, navigating routes, and
exercising the actual Elm bridge, lazy highlighter, and worker. Inspect public
build/package metadata for dependency isolation rather than matching source
strings. Validate manifests/media types through their public formats.

Run the Nix outputs and package commands defined in the build section. Report
exact commands and reasons for blocked checks; an unexecuted check cannot pass.
The contributor guide owns optimized-build/compiler conventions.

### Performance comparisons, safety checks, and accessible interaction

Use the performance section's workloads and reporting method; retain raw reports
in allowed generated/temporary locations. Do not substitute passing unit tests
for measurements or silently weaken comparison workloads.

Safety and accessibility verification targets the interface section through
semantic DOM queries, hostile-data fixtures, and keyboard/browser interaction.
Distinguish simulated platform results from native browser behavior and report
browser-dependent limits rather than extending the acceptance claim.

### Behavioral acceptance and file-allowlist compliance

Completion requires evidence for each requirement's assigned suite, the build
outputs, and the final allowlist gate. No unexplained check failure or
suppressed checker finding is acceptable.

The report must separate implemented behavior, executed checks, approved
tradeoffs, and blockers. Contract approval, application-service
interoperability, production serving/security, and root CI registration are
external gates; fixtures or a successful static build cannot mark them complete.
An unresolved integration is reported as blocked, not silently omitted or
declared implemented.

Completion grants no production cutover or additional file permissions.

## Project layout and exhaustive file allowlist

### Package tree and file responsibilities

This inventory locates the owners defined under
[[packages/www/SPEC.md#Elm entry points, pages, domain modules, and public interfaces]].
The responsibility table grants exact source-file permissions, not a second set
of behavioral requirements.

```text
packages/www/
+-- .gitignore               package-local generated output exclusions
+-- CONTRIBUTING.md          Elm conventions; retained, not implementation code
+-- SPEC.md                  application requirements and this allowlist
+-- default.nix              package, checks, browser tests, and benchmark
+-- elm.json                 Elm application and test dependencies
+-- deps.json                pinned Elm dependency hashes
+-- registry.dat             pinned Elm registry
+-- package.json             browser/build/test dependencies and commands
+-- package-lock.json        resolved npm dependencies
+-- tsconfig.json            browser adapter, build, and test type checking
+-- tsconfig.worker.json     service-worker type checking in its own global scope
+-- build.ts                 one asset build shared by Nix, tests, and benchmark
+-- bench.ts                 browser workload and measurement entry point
+-- src/
|   +-- Main.elm             application entry point and page composition
|   +-- Route.elm            typed browser routes and URL construction
|   +-- Session.elm          session identity and catalog metadata
|   +-- Conversation.elm     conversation identity, ancestry, and observations
|   +-- Conversation/
|   |   `-- Id.elm           conversation-owned identity leaf for cross-references
|   +-- Entry.elm            entry identity, content, and context edits
|   +-- Submission.elm       submission/request identity, input, and outcomes
|   +-- DurableTask.elm      observed task state and compaction results
|   +-- DurableTask/
|   |   `-- Id.elm           task-owned identity leaf for cross-references
|   +-- Api.elm              shared HTTP expectations and error representation
|   +-- Api/
|   |   +-- Durable.elm      core REST requests and response envelopes
|   |   `-- Application.elm  application REST requests and response envelopes
|   +-- Autosave.elm         editable, pending, and acknowledged save state
|   +-- Composer.elm         reusable input and attachment views
|   +-- Settings.elm         reusable settings form views and view configuration
|   +-- Transcript.elm       rendering of interpreted domain content
|   +-- Syntax.elm           token requests, validation, cache, and rendering
|   +-- Icon.elm             shared Elm icon views
|   `-- Page/
|       +-- Home.elm         catalog and session creation
|       +-- Conversation.elm streaming conversation and local controls
|       `-- Settings.elm     global settings, authorization, and device preferences
+-- browser/
|   +-- main.ts              Elm startup and narrow browser capability handlers
|   +-- highlight.ts         syntax-library boundary
|   `-- worker.ts            service-worker events, public asset cache, notifications
+-- public/                  authored documents, styles, icons, and manifest
`-- tests/                   Elm, Node, and Chromium tests and local fixtures
```

### Exact paths and package boundary; unlisted changes are forbidden

- The table below is the complete implementation file allowlist. All paths are
  repository-relative and contained in `packages/www`. Each path names one file,
  not a directory, glob, prefix, or permission to add siblings.
- Listed files may be created or modified within their stated responsibilities,
  regardless of whether they already exist. The list describes the required end
  state, not separate creation and editing permissions.
- No edits outside `packages/www` are authorized. Root build orchestration,
  other packages, backend services, and deployment configuration remain outside
  this specification's edit scope.
- Directory names in the tree explain organization; they grant no write
  permission. Imports, citations, test failures, formatter output, and generated
  dependency changes do not expand the allowlist.
- `packages/www/CONTRIBUTING.md` and this specification remain in the package,
  but are not authorized implementation edits. Amendments require explicit
  approval; implementation must not edit its own permissions.
- Existing frontend code may inform the new files without authorizing changes to
  its sources or callers. Preserve applicable license notices. Existing server
  adapters and their consumers are not disposable browser
  assets.[^layout-callers]
- Missing backend capabilities remain external dependencies; they must not be
  replaced by client-side persistence or execution logic.
- Only the generated-output locations defined below are exempt from the source
  file allowlist. They cannot contain new handwritten source or become a route
  for committing unlisted files.

### Files and responsibilities

| File                                           | Required responsibility                                                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/www/.gitignore`                      | Package-local exclusions for generated output.                                                                                                                     |
| `packages/www/default.nix`                     | Static asset package, pinned dependencies, package-owned checks, browser tests, and rendering benchmark; no production Node server.                                |
| `packages/www/elm.json`                        | Elm application and test dependencies used by the listed modules.                                                                                                  |
| `packages/www/deps.json`                       | Hashes matching the pinned Elm dependency closure.                                                                                                                 |
| `packages/www/registry.dat`                    | Pinned Elm registry consistent with that closure.                                                                                                                  |
| `packages/www/src/Main.elm`                    | Application entry point, route dispatch, shared state, page composition, and port declarations.                                                                    |
| `packages/www/src/Route.elm`                   | Browser routes, parsing, construction, query parameters, and fragments.                                                                                            |
| `packages/www/src/Session.elm`                 | Session identity, catalog metadata, related catalog values, validation, and codecs; no Harness ownership or server lifecycle management.                           |
| `packages/www/src/Conversation.elm`            | Conversation record, Id, ancestry, configuration and observation data, codecs, and pure observation operations; no page state.                                     |
| `packages/www/src/Conversation/Id.elm`         | Conversation-owned opaque identity, validation, and codecs; dependency leaf for entry/task/submission references to conversations.                                 |
| `packages/www/src/Entry.elm`                   | Entry record and Id, content interpretation, context edits, search text, tool relationships, validation, and codecs; no HTML.                                      |
| `packages/www/src/Submission.elm`              | Submission record and Id, RequestId, typed submission input, admitted status/outcomes, validation, and codecs; no editable composer or pending HTTP state.         |
| `packages/www/src/DurableTask.elm`             | Task record and Id, observed state/outcomes, timing, and typed compaction result references; validation/codecs without scheduling or task execution.               |
| `packages/www/src/DurableTask/Id.elm`          | Task-owned opaque identity, validation, and codecs; dependency leaf for entries attributed to tasks.                                                               |
| `packages/www/src/Api.elm`                     | Shared HTTP response classification, structured problems, transport failures, and decoder failures.                                                                |
| `packages/www/src/Api/Durable.elm`             | Core REST requests, pagination, and HTTP/SSE envelopes composed from domain codecs; no central domain-type definitions.                                            |
| `packages/www/src/Api/Application.elm`         | Application integration REST requests and endpoint-specific payloads using domain types; no server implementation or duplicate domain model.                       |
| `packages/www/src/Autosave.elm`                | Shared single-flight save transitions and acknowledged baselines.                                                                                                  |
| `packages/www/src/Composer.elm`                | Shared composer and attachment views; no separate application controller.                                                                                          |
| `packages/www/src/Settings.elm`                | Shared model, thinking, and cwd form views and view configuration; domain values and validation remain with their owners.                                          |
| `packages/www/src/Transcript.elm`              | Rendering of interpreted entries and messages, supported Markdown, safe references, and contextual groups; no domain identity or lifecycle definitions.            |
| `packages/www/src/Syntax.elm`                  | Language selection, correlated token requests, source-preserving validation, bounded cache, and token views.                                                       |
| `packages/www/src/Icon.elm`                    | Shared icon views without behavior or mutable state.                                                                                                               |
| `packages/www/src/Page/Home.elm`               | Session catalog and creation UI using Session and Conversation values; editable input, attachments, and pending creation state remain page-local.                  |
| `packages/www/src/Page/Conversation.elm`       | Compose domain observations, REST operations, and views; own composer state, execution controls, configuration panels, selection, and dialogs.                     |
| `packages/www/src/Page/Settings.elm`           | Global settings, provider authorization, device preferences, and notification controls.                                                                            |
| `packages/www/browser/main.ts`                 | Initialize Elm and connect narrow ports for EventSource, preference storage, identity generation, DOM, service-worker registration, and push browser capabilities. |
| `packages/www/browser/highlight.ts`            | Convert syntax-library results into source-preserving token payloads.                                                                                              |
| `packages/www/browser/worker.ts`               | Public asset caching, worker lifecycle, push display, and validated notification navigation.                                                                       |
| `packages/www/public/index.html`               | Static document shell loading the Elm bundle, browser bootstrap, styles, and manifest.                                                                             |
| `packages/www/public/styles.css`               | Shared application styles and responsive layout.                                                                                                                   |
| `packages/www/public/icon.svg`                 | Application vector icon.                                                                                                                                           |
| `packages/www/public/icon-192.png`             | Small install/notification icon.                                                                                                                                   |
| `packages/www/public/icon-512.png`             | Large install icon.                                                                                                                                                |
| `packages/www/public/manifest.webmanifest`     | Installable application metadata and icon references.                                                                                                              |
| `packages/www/package.json`                    | Explicit browser/build/test dependencies and package commands; no frontend dependency on the old npm workspace.                                                    |
| `packages/www/package-lock.json`               | Resolved versions and integrity data for that manifest.                                                                                                            |
| `packages/www/tsconfig.json`                   | Strict checking of the bootstrap, adapters, build, benchmark, and tests; excludes worker globals.                                                                  |
| `packages/www/tsconfig.worker.json`            | Strict checking of the service worker with worker-specific globals.                                                                                                |
| `packages/www/build.ts`                        | Shared optimized asset build, static asset copying, and dependency-license notices.                                                                                |
| `packages/www/bench.ts`                        | Reproducible browser workloads and measurements; not a correctness check or runtime asset.                                                                         |
| `packages/www/tests/RouteTest.elm`             | Route round trips, invalid routes, query values, and fragments.                                                                                                    |
| `packages/www/tests/ApiTest.elm`               | Request construction and transport-envelope contracts, including errors, cursors, omission, and null; domain invariants belong to domain tests.                    |
| `packages/www/tests/SessionTest.elm`           | Session identity, catalog values, validation, and domain codecs.                                                                                                   |
| `packages/www/tests/ConversationTest.elm`      | Conversation identity, record/observation codecs, configuration, and incomplete relationships.                                                                     |
| `packages/www/tests/EntryTest.elm`             | Entry identity, content interpretation, tool relationships, search text, and domain codecs.                                                                        |
| `packages/www/tests/SubmissionTest.elm`        | Submission/request identity, input encoding, admitted status variants, and domain codecs; not page request-state transitions.                                      |
| `packages/www/tests/DurableTaskTest.elm`       | Task identity, observed outcomes, compaction references, timing, and domain codecs.                                                                                |
| `packages/www/tests/AutosaveTest.elm`          | Save capture, newer edits, acknowledgement, failure, and navigation eligibility.                                                                                   |
| `packages/www/tests/TranscriptTest.elm`        | Rendering of domain content, incomplete Markdown, and safe references; domain interpretation is tested by its owner.                                               |
| `packages/www/tests/SyntaxTest.elm`            | Token correlation, source preservation, fallback, and cache ownership.                                                                                             |
| `packages/www/tests/PageTest.elm`              | Public page transitions, local input/capture races, settings state, and reusable view messages; no test-only exports from Main.                                    |
| `packages/www/tests/highlight.test.ts`         | Syntax-library adapter behavior through its production entry point.                                                                                                |
| `packages/www/tests/worker.test.ts`            | Service-worker behavior through registered browser event interfaces.                                                                                               |
| `packages/www/tests/build.test.ts`             | Built artifact availability, package isolation, and asset-serving compatibility.                                                                                   |
| `packages/www/tests/conversation.chromium.ts`  | Conversation interaction, real REST/SSE integration, input discard on navigation/reload/history restoration, and observation lifecycle.                            |
| `packages/www/tests/pages.chromium.ts`         | Session CRUD, configuration, authorization, accessibility, and responsive behavior.                                                                                |
| `packages/www/tests/notifications.chromium.ts` | Browser permissions, subscriptions, worker lifecycle, and notification navigation.                                                                                 |
| `packages/www/tests/browser-testing.ts`        | Shared Chromium, asset-serving, and cleanup fixture used by the browser suites.                                                                                    |
| `packages/www/tests/fixtures.ts`               | Minimal deterministic records, public upstream Harness setup, and application-endpoint fixtures.                                                                   |
| `packages/www/tests/design-system.html`        | Test-only style and layout fixture; not a production page.                                                                                                         |

Test responsibility and contract approval are defined under
[[packages/www/SPEC.md#Behavior-to-suite ownership and preserved regression coverage]];
the file table does not independently authorize an unapproved service fixture.

### Generated files, dependency pins, and build-output boundaries

The public artifact contract is owned under
[[packages/www/SPEC.md#Package entry points, static assets, and installed artifact layout]];
pin consistency is owned under
[[packages/www/SPEC.md#Elm and browser dependencies, lockfiles, registry data, and licenses]].
The only generated-output exemptions to the source allowlist are:

- Ignored `packages/www/dist/`, `packages/www/elm-stuff/`, and
  `packages/www/node_modules/` for tool-generated output, never handwritten
  source.
- Explicit temporary or Nix build/output directories for compiler caches, test
  files, screenshots, and benchmark reports; their callers own cleanup.

Committed dependency regeneration stays in the listed `deps.json`,
`registry.dat`, and `package-lock.json`. Build intermediates stay in exempt
locations; no generated client is added under `src/` or `browser/`. Exemptions
do not grant permission to overwrite repository source or commit unlisted files.

### Allowlist compliance and prior approval for amendments

If implementation needs another path or exceeds a listed responsibility, stop
that part and request approval before making the change. The implementation must
not edit its own permissions. Review the complete source/lockfile/generated
change against this table, preserving unrelated pre-existing changes.

This is the file-scope acceptance gate referenced by the verification section.

[^layout-guide]: [[packages/www/CONTRIBUTING.md]].

[^layout-api-entry]:
    [API package exports](../durable/api/package.json) and
    [public REST API entry point](../durable/api/src/index.ts).

[^layout-existing]:
    Existing [conversation](../app/serve/elm/src/Main.elm),
    [site](../app/serve/elm/src/Site.elm), [browser](../app/serve/elm/client.ts)
    entry points; shared [settings views](../app/serve/elm/src/Panel.elm),
    [syntax boundary](../app/serve/elm/src/Syntax.elm), and
    [PWA capabilities](../app/serve/pwa.ts).

[^layout-build]:
    [Current www derivation](default.nix), [Elm manifest](elm.json),
    [package registration](../default.nix), [flake checks](../../flake.nix), and
    existing [asset builder](../app/serve/build.ts).

[^layout-callers]:
    Existing [server](../app/serve/server.ts),
    [conversation endpoints](../app/serve/elm/frontend.ts),
    [site endpoints](../app/serve/elm/pages.ts), and the
    [tape caller of presentation helpers](../app/tape/browser.ts).

[^layout-records]:
    Pinned Durable 1.4.0
    [record definitions](/nix/store/57n99acvmwvfw5qjn7ryqzh8gxg5gcj9-app-node-modules-0.1.0/node_modules/@earendil-works/pi-durable/dist/types.d.ts)
    (`ConversationRecord`, `EntryRecord`, `SubmissionRecord`, `TaskRecord`),
    [compaction result](/nix/store/57n99acvmwvfw5qjn7ryqzh8gxg5gcj9-app-node-modules-0.1.0/node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts)
    (`CompactionResult`), and the existing
    [compaction timing consumer](../app/serve/presentation.ts).

[^behavior-tests]:
    Existing
    [conversation browser regressions](../app/serve/elm/tests/frontend.chromium.ts),
    [page/view regressions](../app/serve/elm/tests/views.chromium.ts),
    [authorization browser tests](../app/serve/tests/auth.chromium.ts), and
    [design-system tests](../app/serve/tests/design-system.chromium.ts).

[^application-evidence]:
    Existing [page integration handlers](../app/serve/elm/pages.ts),
    [conversation integration handlers](../app/serve/elm/frontend.ts),
    [forms and attachment encoding](../app/serve/forms.ts),
    [settings and choices](../app/serve/settings.ts), and
    [session lifecycle/configuration](../app/serve/sessions.ts). These establish
    behavior, not implementation of the new application routes.

[^security-evidence]:
    Existing [HTTP origin/access checks](../app/serve/server.ts) and
    [core API composition boundary](../durable/api/src/index.ts).

[^autosave-evidence]:
    Existing [autosave state transitions](../app/serve/elm/src/Autosave.elm) and
    [autosave regressions](../app/serve/elm/tests/AutosaveTest.elm).

[^auth-evidence]:
    Existing [provider authorization boundary](../app/serve/auth.ts),
    [provider-status projection](../app/serve/elm/pages.ts), and
    [authorization regressions](../app/serve/tests/auth.chromium.ts).

[^commands-evidence]:
    Existing [command/completion vocabulary](../app/serve/completions.ts),
    [composer dispatch and keyboard behavior](../app/serve/elm/src/Main.elm),
    and [completion tests](../app/serve/tests/completions.test.ts). Unicode and
    browser-event contracts are cited in [[packages/www/CONTRIBUTING.md]].

[^rendering-evidence]:
    Existing [transcript renderer](../app/serve/elm/src/Transcript.elm),
    [reference safety tests](../app/serve/elm/tests/TranscriptTest.elm).
    File-viewer expectations in those tests are outside this frontend's scope.

[^syntax-evidence]:
    Existing [syntax state and validation](../app/serve/elm/src/Syntax.elm),
    [syntax adapter](../app/serve/highlight.ts), and
    [syntax tests](../app/serve/elm/tests/SyntaxTest.elm).

[^browser-evidence]:
    Existing [browser capabilities](../app/serve/elm/client.ts),
    [transport ownership](../app/serve/elm/transport.ts), and
    [preferences/PWA integration](../app/serve/pwa.ts). The new transport uses
    the core snapshot contract rather than these adapters' old presentation
    protocol; browser standards and lifecycle references are in
    [[packages/www/CONTRIBUTING.md]].

[^notification-evidence]:
    Existing [worker](../app/serve/worker.js),
    [worker event tests](../app/serve/tests/notification-worker.test.ts),
    [notification browser tests](../app/serve/tests/notifications.chromium.ts),
    and [push browser integration](../app/serve/pwa.ts).

[^performance-evidence]:
    Existing [renderer benchmark and workload](../app/serve/benchmark.ts). Its
    workload is comparison evidence, not permission to import its private
    backend fixtures into www or reuse its transport as the new API.

[^build-evidence]:
    Current [root recipes](../../justfile),
    [flake check registration](../../flake.nix),
    [package registration](../default.nix), and
    [existing asset/license build](../app/serve/build.ts).

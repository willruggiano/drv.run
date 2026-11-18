# PDS hypermedia application

- Label: `ready-for-agent`
- Status: specified; replacement contract not yet implemented
- Parent specification: [[SPEC.md]]
- Governing decisions: [[tasks/070-pds-http-contract.md]],
  [[tasks/030-credential-contract.md]], [[tasks/050-infrastructure-contract.md]]

## Problem Statement

The user needs the retained coding workflow without coupling model login,
execution, and browser state to the legacy applications. The current PDS
prototype also lacks the selected multi-Harness addressing and complete native
operation surface. Browser reconnects, uncertain submissions, unavailable
execution targets, and shared credentials need explicit behavior rather than
accidental consequences of a single-store prototype.

## Solution

PDS owns an HTML-first coding application and its retained pi-durable harness.
It exposes native operation-oriented commands and reads, with Datastar for
bounded live projection. Sessions select independent SQLite stores;
conversations retain native IDs within each store. Model login uses pi-ai and
the Unix owner's shared Pi credentials. Execution is explicitly local, ordinary
SSH, or a selection from an optional environment source.

```text
HTML forms -- short POST --> PDS -- native commands --> session Harness
HTML reads <-- GET -------- PDS <-- native reads ----- session Harness
browser    <-- Datastar --- PDS <-- bounded watch ---- conversation

PDS model login --> pi-ai --> shared owner credential file
PDS execution  --> explicit selection --> local | native OpenSSH
optional drv.run source --> owner-scoped CLI inventory
```

Pi owns conversation execution and provider protocols. PDS owns application
lifecycle, forms, HTML projection, credential storage, and observation
resources. The browser owns drafts, selected files, disclosure state, and
scrolling, not a conversation replica. Accounts, mitm, and push remain
independent applications.

This is the selected REST-contract adaptation, not the old GraphQL transport,
frozen JSON watch, or wholesale app/www feature parity. It is self-contained for
PDS behavior; independent-component deployment and retirement gates belong in
[[SPEC.md]].

## User Stories

1. As a PDS user, I want to list persisted sessions, so that closed browser tabs
   do not hide existing work.
2. As a PDS user, I want to open a supplied session ID or obtain a generated
   one, so that I can select a stable store without selecting an execution
   target.
3. As a PDS user, I want repeated opens to select the same store, so that they
   do not reset or reconfigure conversations.
4. As a PDS user, I want root and additional-conversation creation to be
   explicit, so that opening a store or reading a page cannot create
   conversation state.
5. As a PDS user, I want native conversation IDs scoped by session, so that
   equal IDs in different databases cannot address the wrong conversation.
6. As a PDS user, I want recovery to run independently of browser connections,
   so that reconnecting is not the execution scheduler.
7. As a PDS user, I want a failed session shown as unavailable without blocking
   other sessions, so that one broken store does not hide all work.
8. As a PDS user, I want available model metadata before creating a session, so
   that model selection does not provision a store.
9. As a PDS user, I want text and supported image/source attachments, so that I
   can supply coding context with ordinary forms.
10. As a PDS user, I want invalid configuration or uploads rejected before
    creation/admission, so that validation does not leave unintended work.
11. As a PDS user, I want native submission identity on admission, so that an
    acknowledgement is distinguishable from a generated answer.
12. As a PDS user, I want steer, follow-up, and reject-on-busy semantics
    retained, so that the transport does not invent queue behavior.
13. As a PDS user, I want my draft and request ID retained after a lost
    response, so that I can recover admission without automatically duplicating
    input.
14. As a PDS user, I want submission lookup scoped to its conversation, so that
    another conversation's receipt cannot confirm my draft.
15. As a PDS user, I want queued-input cancellation distinct from execution
    abort, so that a cancellation result accurately describes what was stopped.
16. As a PDS user, I want browser disconnection to release observation only, so
    that tools and model work do not stop when I close a tab.
17. As a PDS user, I want explicit inspection and resume, so that viewing
    interrupted work does not itself enable scheduling.
18. As a PDS user, I want reset and compaction to preserve native semantics, so
    that admission, completion, and summary placement remain distinguishable.
19. As a PDS user, I want current or historical context reads, so that I can
    inspect what the model sees without treating all history as active context.
20. As a PDS user, I want conversation/task scans and submission status reads,
    so that relationships and compaction outcomes remain inspectable.
21. As a PDS user, I want bounded initial observation and explicit older pages,
    so that long histories do not require full transcript transfer.
22. As a PDS user, I want gaps and context boundaries shown accurately, so that
    omitted history is not presented as a complete transcript.
23. As a PDS user, I want incremental patches that preserve drafts and
    disclosure state, so that streaming does not disrupt interaction.
24. As a PDS user, I want reconnect to acquire a fresh bounded baseline, so that
    recovery does not depend on a browser-owned revision log.
25. As a PDS user, I want form errors distinguished from transport failures, so
    that HTTP 200 validation does not clear an unadmitted draft.
26. As a PDS user, I want omitted settings preserved and explicit clearing
    supported, so that a partial form does not overwrite unrelated choices.
27. As a PDS user, I want agent and environment changes committed atomically, so
    that subsequent execution sees a coherent selection.
28. As a PDS user, I want no execution environment until one is selected, so
    that missing or unavailable selections never fall back to host execution.
29. As a PDS user, I want task children and forks to inherit selection
    correctly, so that execution follows the native ownership and history
    boundary.
30. As a PDS user, I want active work to retain its acquired environment while
    later work uses changes, so that configuration does not relocate a command.
31. As a PDS user, I want ordinary SSH configured through OpenSSH, so that PDS
    does not require private connection paths or manage host trust.
32. As a PDS user, I want optional drv.run discovery with visible readiness and
    failures, so that other environments remain usable during discovery outages.
33. As a PDS user, I want /new, /cd, and /compact retained, so that selected
    composer workflows do not depend on the old frontend.
34. As a mobile PDS user, I want home environment selection and footer model and
    thinking controls, so that retained mobile workflows remain usable.
35. As a PDS user, I want model login prompts rendered generically, so that
    provider-specific OAuth behavior stays in pi-ai.
36. As a host Unix owner, I want PDS to share the Pi CLI credential file and
    locking protocol, so that concurrent writers do not independently refresh
    copied credentials.
37. As a PDS user, I want external login, logout, and refresh writes observed
    without restart, so that the displayed stored-login state is current.
38. As a PDS user, I want unreadable or malformed credentials to fail
    explicitly, so that a storage problem is not mistaken for logout or an empty
    file.
39. As a host Unix owner, I want literal API keys and OAuth records preserved
    without executing key expressions, so that sharing storage does not execute
    another application's configuration.
40. As a PDS user, I want one resumable-in-browser pending login per provider,
    so that competing tabs do not silently replace an interaction.
41. As a PDS user, I want replacement login to leave the old credential until
    saving succeeds, so that a failed interaction does not log out my sessions.
42. As a PDS user, I want cancellation to respect the persistence boundary, so
    that I can distinguish a cancelled interaction from a saved replacement.
43. As a PDS user, I want logout coordinated with pending login and refresh, so
    that a late PDS result cannot silently restore the removed credential.
44. As a PDS user, I want stored login distinguished from ambient credentials,
    so that local logout is not misrepresented as upstream revocation.
45. As a PDS user, I want credential material and raw provider failures excluded
    from pages and conversation history, so that login does not leak secrets.
46. As an operator, I want PDS runnable without accounts, mitm, push, or
    drv.run, so that model auth and generic coding are independently deployable.
47. As an operator, I want prefix-correct forms, links, assets, and observation,
    so that a deployment router can compose PDS without rewriting HTML.
48. As a maintainer, I want public-interface tests and measured rendering work,
    so that extraction preserves behavior rather than private implementation
    shape.

## Implementation Decisions

### Ownership, identity, and lifecycle

- PDS owns the retained harness, environment integration, relevant patches, and
  tests. Use pinned pi-durable, pi-ai, pi-env, and Chord 1.5.2. Apply a minimal
  package-owned pi-env patch for native OpenSSH configuration alongside the
  retained pi-durable conversation-context patch; no Pi upgrade or separate
  local fork product is selected. Do not import the legacy application/API
  runtime or pi-coding-agent internals.
- A session is an owner-local persisted SQLite store with one owning Harness. An
  opaque client-supplied session ID selects that store; omission at open
  generates an ID. It is not a drv.run instance or execution environment.
- Session lookup must encode/validate IDs before filesystem access, prevent
  traversal and aliasing, and preserve exact identity on repeated opens. A
  storage error is not permission to recreate the store. IDs and request sizes
  are bounded inputs, not arbitrary paths.
- Conversation, submission, task, and entry IDs remain native nonnegative safe
  integers at the transport boundary, but opaque identifiers to the application.
  Parse complete decimal values strictly. They are scoped to the session store;
  do not manufacture globally unique replacements or consolidate databases.
- Let `S` mean `/api/s/{sessionId}` and `C` mean
  `/api/s/{sessionId}/c/{conversationId}`. All routes below are relative to the
  configured PDS public base URL, whose prefix is preserved by the router.
- Startup enumerates persisted sessions, opens them, and explicitly resumes
  eligible work according to pinned pi-durable recovery. One failed/unreadable
  session remains visibly unavailable without blocking other sessions. Startup
  recovery is not owned by an HTTP observer.
- `open` opens or creates a store/Harness only. It does not create a root, apply
  conversation settings, submit input, or itself promise scheduling. Repeated
  opens share the existing owner and do not reset state. Explicit reopen may
  recover a failed owner without replacing its database.
- Root/conversation creation is a separate mutation. GET requests never
  provision missing stores, create conversations, or enable scheduling.
  Reconnecting a watch does not resume work. Commands and reads share the same
  owning Harness.
- Shutdown stops admissions and observations, closes Harnesses, then cleans up
  owned execution environments and SSH connections. A browser disconnect does
  not close the Harness or abort execution.

### HTTP surface

| Method | Route                   | Meaning                                                          |
| ------ | ----------------------- | ---------------------------------------------------------------- |
| GET    | `/`                     | Home, session navigation, and creation forms                     |
| GET    | `/api/s`                | List persisted sessions, including unavailable sessions          |
| POST   | `/api/s/open`           | Open/create a store; optional `sessionId`                        |
| GET    | `S`                     | Session page with conversation navigation and lifecycle controls |
| POST   | `S/root`                | Return existing native root or create it with initial agent/env  |
| POST   | `S/createConversation`  | Create a native conversation with initial agent/env              |
| GET    | `C`                     | Conversation page and bounded baseline                           |
| GET    | `/api/models`           | Available chat-model metadata rendered as HTML                   |
| GET    | `S/inspect`             | Native Harness inspection without scheduling                     |
| GET    | `S/scanConversations`   | Paged native conversation records                                |
| GET    | `S/scanTasks`           | Paged native task records                                        |
| GET    | `C/watch`               | Fresh bounded baseline then incremental Datastar SSE             |
| GET    | `C/entries`             | Explicit paged, fork-aware history                               |
| GET    | `C/context`             | Current or historical native context using optional `at`         |
| GET    | `C/submissionByRequest` | Conversation-scoped lookup by `requestId`                        |
| GET    | `C/submissions/status`  | Conversation-scoped submission lookup by `id`                    |
| POST   | `S/resume`              | Enable native scheduling; not a completion wait                  |
| POST   | `C/submit`              | Admit an input submission, returning native identity             |
| POST   | `C/abortSubmission`     | Withdraw queued input using native `id` result                   |
| POST   | `C/abort`               | Abort ordinary conversation-owned work using native defaults     |
| POST   | `C/reset`               | Native reset with optional `handoff`                             |
| POST   | `C/compact`             | Native compaction with optional `instructions`                   |
| POST   | `C/configure`           | Atomic partial agent and environment change                      |

- Preserve the complete selected REST operation names and methods. All reads use
  GET with no request body. There is no GraphQL transport, parallel JSON
  response API, remote transaction language, or generic document-mutation API.
- Reads return full HTML or requested HTML fragments; enhanced read application
  may use Datastar element patches. Commands accept ordinary named forms,
  URL-encoded or multipart as appropriate. Normal successful form navigation
  uses POST/redirect/GET. Enhanced responses are short Datastar acknowledgements
  and necessary form/navigation effects, not transcript/configuration replicas.
- Mark application reads, commands, and streams `Cache-Control: no-store`.
  Return labelled native result variants as HTML, not old JSON `null`, arrays,
  problem envelopes, or replacement conversation snapshots.
- Browser form helpers may adapt presentation or dispatch supported composer
  commands, but may not add a competing settings API, hidden GET mutation, or
  separate environment mutation endpoint. Canonical operations keep native
  meaning; input text at `submit` is not executable browser or shell code.

### Request fields and native mappings

- Use upstream public types for native arguments and records rather than copying
  their schemas. Transactions, callbacks, extension objects, and executable
  configuration remain server-side.
- Flat GET query fields use decimal numbers, `true`/`false` booleans, and
  omission for absent values. Reject duplicate scalar fields, unsupported
  fields, malformed IDs, and invalid query combinations. There is no JSON
  `query` parameter.
- Entry reads preserve `minEntryId`, `maxEntryId`, and `order`; addressing
  supplies `conversationId`. Conversation scans preserve
  owner-conversation/owner-task filters and order. Task scans preserve
  conversation, kind, status, abort-requested, background, and order filters
  from the pinned type.
- `cursor` is the unpadded base64url encoding of the native cursor's UTF-8 JSON.
  PDS encodes/decodes it without changing native contents. HTML continuation
  links carry it unchanged and preserve the addressed session, query, and
  interval. Invalid/foreign cursors fail rather than starting over. Omit the
  continuation when the native page has no `next`.
- Entry pages contain at most 50 records. Conversation/task scan pages are
  bounded, default to 50, and accept limits from 1 through 100. No read
  automatically drains all pages to populate a projection.
- `root` accepts optional initial agent fields and `env`. If the root already
  exists, creation options are ignored; use `configure` to change it.
  `createConversation` accepts the native ownership choice and optional initial
  agent/env; ordinary browser creation uses ownerless ownership. Task-owned
  creation must reference an existing task in the same store, not manufacture
  ownership records. Neither operation submits input.
- `submit` admits only native input submissions. Preserve optional `requestId`,
  `whenBusy` (`steer`, `followUp`, `reject`), `whenIdle` (`reject`), and native
  input-entry metadata. Omission follows native defaults; a composer may
  explicitly choose follow-up behavior. Do not expose passive writes or native
  continue submissions as additional operations.
- Named text controls and multipart attachments map to native string or
  text/image-block content. Entry metadata retains `kind` and optional `data`;
  structured metadata can be a bounded JSON-valued form field, not a browser
  conversation-state store. Validate application entry kinds before admission;
  reserved `pi.` kinds are not caller-controlled.
- The server rejects bodies above 32 MiB before consuming the complete body.
  Accept PNG, JPEG, GIF, WebP, and valid UTF-8 text/source attachments. Reject
  unsupported binary documents and images unsupported by the selected model
  before admission. Keep file input usable without preview JavaScript.
- A combined home creation workflow validates model/configuration, initial
  input, and attachments before opening/creating state, then uses explicit
  lifecycle operations and submission. It does not change `open`, `root`, or
  `createConversation` into create-and-submit APIs. Admission failure after
  creation remains a distinct boundary; no atomic create-and-submit guarantee or
  automatic rollback is introduced.

### Admission, recovery, and execution controls

- Submission success returns native submission identity and means durable
  admission, not placement, model response, or settlement. Keep that identity in
  a scoped acknowledgement available to the form; do not invent a PDS job ID.
  Unless the native operation itself waits, command connections do not wait for
  execution and do not own its lifetime.
- The browser assigns and retains a conversation-scoped request ID for a draft
  before sending. While admission is pending, prevent ambiguous draft edits.
  Reset the draft and attachments only after a matching admission
  acknowledgement or confirmed request-ID recovery. Never reset on transport
  success alone.
- After a lost response, retain the draft and request ID and read
  `submissionByRequest`. Never automatically retry a write. Native same-key,
  same-type retries return the existing submission without comparing content; a
  request ID is not a content hash. An explicitly changed/new submission uses a
  new ID.
- `submissionByRequest` preserves the native receipt and its status variants. No
  receipt at a lookup point does not prove a concurrent/disconnected request
  failed. Render this as absence with uncertainty, not a missing-resource error.
- Submission status reacquires the native submission and checks its conversation
  scope. Absent or differently scoped submissions produce a successful absence
  representation. They do not start scheduling or wait for settlement.
- `abortSubmission` passes the addressed conversation to upstream and preserves
  `aborted`, `already_placed`, `settled`, and `not_found` as successful result
  variants. `already_placed` does not become execution abort; another
  conversation's submission is `not_found`.
- `abort` uses native defaults: withdraw queued input, abort ordinary owned
  work, and wait for that abort operation's native completion. Preserve
  background boundaries and queued writes. Do not expose a background-abort
  option or strengthen it into termination of every possible task.
- `inspect` renders native scheduling, task, submission, and inspection-state
  distinctions without enabling scheduling. `resume` enables scheduling but does
  not promise completion, successful recovery of blocked definitions, or a new
  submission.
- `reset` preserves an omitted handoff versus an explicitly supplied string and
  acknowledges native reset admission, not necessarily placement. `/new` is not
  reset.
- `compact` returns the native task ID. Task admission, task completion, and
  summary placement remain distinct; subsequent reads/watch show progress and
  failure. No remote wait endpoint or arbitrary task-control surface is added.
- `context` preserves current versus historical `at` semantics and the
  distinctions between native entries, contributions, messages, and optional
  head. Render absent head as absent, not a fabricated context boundary.
- Conversation scans retain parent and ownership relationships; task scans
  retain native state/outcome discriminants, including failed outcomes. No
  second branch-tree or task-state model becomes authoritative in PDS.

### Configuration and execution environments

- `configure` accepts only model, thinking level, cwd, and environment
  selection. Model identity retains provider/model ID. Do not admit
  instructions, tools, extension objects, connection-file paths, or arbitrary
  document writes.
- For each field, omission preserves, explicit null clears, and a supplied value
  replaces. Forms represent clearing through repeated `clear` controls naming
  the fields to clear; an empty text field is not implicit null. Reject a field
  supplied both as a value and in `clear`. Keep the same tri-state semantics on
  creation where applicable.
- Agent and environment changes commit in one conversation transaction. Read
  current values rather than resubmitting stale values from untouched controls.
  Do not return another configuration projection in the command response;
  observations/read representations show committed state.
- The raw cwd change preserves the supplied directory string, as native
  configuration does. Do not normalize it against the PDS server filesystem,
  create directories, or claim that configuration validates remote existence.
  `/cd` is the separate composer convenience that resolves a relative path
  against the selected environment's current directory before configuring it.
- Clearing a stored setting removes the override. Do not invent a model/cwd
  fallback in the API; native unset thinking resolves to off. UI model changes
  can submit a supported thinking value in the same command when the previous
  value is incompatible, but omission itself must not secretly change it.
- A selected environment is explicitly local, SSH with a host name, or a named
  source/environment identity. Source references retain their logical identity;
  do not persist a transient resolution as the authoritative selection. No
  selection means no execution environment. An unavailable selection is an
  execution failure, never an implicit local fallback.
- Initial selection belongs in the creating commit, not on store-only open. New
  roots and ownerless conversations are unselected unless initialized.
  Task-owned children inherit their owner's selection; forks inherit at the fork
  point. A creation value overrides inheritance; explicit null clears it.
- Store selection in a conversation-scoped rewindable document with
  fork-at-point semantics. The server's environment factory reads committed
  selection and cwd on acquisition. That factory is not a client-supplied store
  binding.
- Configuration is allowed during active work. Subsequent acquisitions use the
  new selection; existing operations keep their acquired environment and are
  neither aborted nor relocated. Do not mutate or close an environment while
  running work still borrows it.
- Environment sources have a small application interface: stable source
  identity, listing selectable identities/labels/readiness, and resolving a
  saved identity to local/SSH execution or explicit unavailability. Errors are
  distinct from an empty list. Sources do not register tools/tasks or control
  guest lifecycle.
- Generic local and SSH execution need no drv.run. Deployment may register the
  optional drv.run source, which consumes the inventory contract in the parent
  specification. Failed discovery affects that source only. Saved unavailable
  identities remain visible through ordinary instance restarts.
- SSH requires only `host` at the application boundary. Use the selected native
  pi-env/OpenSSH integration, with deployment-owned configuration and strict
  host-key verification. Do not expose keys, trust/config paths, SSH executable,
  or daemon binaries through forms or discovery.

### Observation and history

- Each watch acquires a fresh native conversation observation. Its first
  projection is a complete bounded baseline. Retain the native 50-entry initial
  window, growth to 100, and eviction back to 50. Do not enumerate the
  transcript or materialize model context to acquire that baseline.
- Acquire the latest head marker with a bounded native read and synchronize its
  acquisition with observation so no intervening commit is missed. Keep later
  observed markers even after they leave the window. Observe the environment
  document separately where it is not in the built-in conversation view.
- Consume native values and Chord operations on the server. Send native Datastar
  element patches, not Chord operations, JSON full snapshots, application-level
  deltas for a browser replica, or a new synchronization protocol.
- Native watch callbacks are serialized. Respect socket backpressure and allow
  Chord to fold pending operations while the writer waits. No unbounded
  per-observer queue, polling snapshots, or asynchronous storage calls inside
  synchronous native observers.

| State change                     | Required projection work                              |
| -------------------------------- | ----------------------------------------------------- |
| Initial baseline or changed head | Replace the bounded transcript projection             |
| Newly committed entries          | Render and append new entries only                    |
| Window eviction                  | Drop server window state, not unchanged committed DOM |
| Partial assistant response       | Patch only the live response region                   |
| Tool progress/result             | Patch the affected tool presentation                  |
| Inbox                            | Patch queued-input presentation                       |
| Run/retry/compaction             | Patch status and failure regions                      |
| Usage                            | Patch inert statistics                                |
| Agent/environment                | Patch changed configuration controls only             |

- Stable entry DOM identity includes session and conversation scope; tool-call
  identity correlates tools and output. Preserve native roles and content kinds.
  Finalization replaces partial content without duplicates or lost final text.
- Render/highlight committed Markdown once when it enters the projection, not on
  unrelated live progress. Partial Markdown may reparse its changing block.
  Preserve native disclosure state and untouched composer/directory drafts. Do
  not replace the page, main, or transcript container for ordinary progress.
- If folded updates or a fresh window omit an interval, expose an explicit
  history affordance. Do not fabricate entries, label an incomplete transcript
  complete, or drain older history automatically.
- Older history is an explicit page request of at most 50 entries. Use native
  fork-aware reads; present each page chronologically. Server-generated links
  carry the native query bounds/cursor for the same interval. Translate an
  exclusive UI boundary to native inclusive bounds without shifting its meaning.
- Insert a requested page at its scoped history placeholder. Repeating a page
  request must not duplicate entries. Discard a stale page response when its
  target/selection has changed; do not append it elsewhere.
- A compaction marker's head identifies the first retained context entry, not
  the summary's chronological position. Reset's self-head starts at the reset
  entry. Keep inactive older history behind a disclosure without presenting it
  as active model context. A head change may rebuild the bounded projection and
  discard loaded pages, not justify full rerender on subsequent progress.
- Disconnect releases native observations and transient render state, not
  execution. Reconnect replaces live projection with a new bounded baseline. No
  resumable SSE event IDs, durable replay log, or preserved browser replica.
- Observation failure is visible as a failure/disconnected state, not idle.
  Before stream headers, use declared HTTP statuses. After headers, communicate
  a sanitized failure through available Datastar presentation or close the
  stream; do not invent a new HTTP status or guarantee terminal-frame delivery.

### Model login and shared credentials

- Use pi-ai `Models` and `AuthInteraction`; provider-specific enrollment,
  refresh, token interpretation, and request authentication remain upstream.
  Keep the existing Codex inference route and device enrollment. Do not add an
  accounts-owned Codex flow or switch to newer ChatGPT token sharing.
- Serve a generic `/login` page under PDS's prefix, with provider/method choice,
  prompt responses, cancellation, and logout. Render text, secret, selection,
  manual-code prompts, links, device codes, and progress through Datastar
  without implementing provider-specific UI branches. Respect per-prompt
  cancellation and do not echo submitted secrets into later responses.
- Remote-browser limitations of upstream loopback flows remain real. Do not
  rewrite a provider's loopback callback into an arbitrary public PDS callback
  or claim it works remotely. The selected Codex device flow supplies the
  required remote enrollment path; manual-code prompts remain generic when
  upstream uses them.
- Implement an owner-local file-backed `CredentialStore` matching the Pi 1.5.2
  schema and path selection described in Further Notes. Consume only that
  credential file, not Pi settings, sessions, extensions, or model
  configuration.
- Select `proper-lockfile` 4.1.2, matching the CLI reference. Lock the resolved
  credential-file target so symlink aliases share a lock. Coordinate serialized
  read-modify-write, refresh, and removal across processes; preserve unrelated
  entries. First-file creation must not truncate a concurrent writer's file.
- Observe external changes on subsequent reads/auth resolution without restart.
  Do not maintain independently refreshed copies or use only a startup snapshot.
  Unreadable, malformed, or compromised storage is an error, not logout, an
  empty replacement, or permission to use stale in-memory credentials.
- Support OAuth records and literal API keys, including preservation of opaque
  provider credential fields. Reject command or environment-template key
  expressions explicitly when resolving them; never execute or transmit them as
  literal credentials. Preserve unrelated records without evaluating them.
- Persist before reporting login success or using refreshed credentials. Do not
  copy the CLI's best-effort stale-read behavior. Do not promise crash-atomic
  storage across all writers: the reference CLI writes the file in place.
- Retain pi-ai refresh-failure semantics: fail that model request, preserve the
  stored credential, and permit another attempt. Do not automatically delete,
  fall back to another credential, or classify provider errors locally. This is
  deliberately weaker than accounts' ambiguous-refresh reauthorization policy.
- Once refresh starts, allow pi-ai to finish and persist despite caller
  cancellation, bounded by its provider timeout. Cancellation while waiting for
  a lock may prevent starting. This protects a returned rotating token; it does
  not recover a lost provider response.
- Allow one in-memory pending PDS login per owner/provider. Reconnection or
  another tab sees that interaction rather than silently starting another.
  Cancellation, expiry, or shutdown ends it; restart does not resume it.
- Starting replacement login does not remove the current credential. Existing
  conversations continue using it until a successful persisted replacement.
  Failure before saving leaves the previous record unchanged.
- Cancellation during interaction or lock wait prevents saving. Once persistence
  starts, await its result and report success or failure rather than claiming
  nothing was saved. Removing a saved credential requires logout.
- Logout cancels pending PDS login, waits for any PDS login commit, serializes
  removal against refresh, and deletes the shared provider record. File locking
  alone is insufficient to coordinate PDS's pending interactions.
- Logout removes the CLI's stored credential too; it is not upstream revocation,
  cancellation of already-authorized requests, or prevention of a later CLI
  login. Coordination with separate CLI login is limited to shared-file locking.
  Ambient credentials may still authorize requests; distinguish that from a
  stored login in the UI.
- Credentials, raw token responses, and provider exceptions stay out of browser
  responses, conversation documents/history, guest seeds, and diagnostics.
  Return sanitized failures. Login interactions are not coding conversations.

### Browser behavior and safeguards

- Use labelled native links, forms, selects, buttons, inputs, and details.
  Datastar 1.0.5 supplies requests, indicators, SSE, and morphing. Signals hold
  only transient interaction state, not transcript, queue, model configuration,
  or credential authority.
- Retain composer `/new` as an ownerless conversation in the selected session
  inheriting configuration/environment but no transcript, `/cd` as directory
  configuration without a model turn, and `/compact` as native compaction.
  Report failures rather than manufacturing success. `/cd` remains available on
  desktop and mobile.
- Keep footer model-ID and thinking selectors on desktop and mobile, with no
  settings popup. Desktop conversation keeps inline cwd and environment
  selection; mobile conversation omits the environment selector, while mobile
  home retains it. Statistics stay inert; context/task reads use explicit read
  representations rather than requiring an old inspector UI.
- Preserve the existing no-autofocus presentation and composer focus border;
  controls remain labelled and keyboard operable. Retain native disclosures,
  attachment previews/removal and clipboard/drop intake, and scrolling that
  follows new content without overriding deliberate upward scrolling.
- Keep custom browser code presentation-only and small. Do not relocate a large
  program into HTML attributes to claim zero JavaScript. Rejected or uncertain
  enhanced commands retain drafts; native error navigation must not silently
  resubmit a form.
- Escape text and attributes, disable raw HTML in Markdown, reject unsafe
  link/image schemes, and encode IDs before using them in selectors or scripts.
  Serve the pinned local Datastar bundle, not a runtime CDN dependency.
- The listener defaults to loopback. Deployment supplies an explicit public base
  URL including prefix when exposing PDS. Validate unsafe request origins
  against that configuration, not arbitrary forwarded-host headers. This is not
  HTTP authentication or browser-owner isolation; the parent specification's
  Tailscale/LAN trust boundary applies to coding and login equally.

### Errors and results

- Classify explicit adapter conditions and typed upstream exceptions, never
  message substrings or arbitrary `TypeError`/`Error` instances. Unexpected
  failures use a sanitized internal error without stacks, storage details, or
  secret-bearing causes.
- A handled form-validation failure returns HTTP 200 with an accessible
  invalid-form HTML/Datastar representation, because pinned Datastar applies
  patches on 200. It contains no admission acknowledgement, navigation, or
  draft-reset effect. It is not a successful command.

| Condition                                                                   | HTTP behavior    |
| --------------------------------------------------------------------------- | ---------------- |
| Invalid path/query/cursor/request shape, or rejected storage read arguments | 400              |
| Foreign unsafe browser origin                                               | 403              |
| Missing addressed session/conversation                                      | 404              |
| Unsupported method on known route                                           | 405 with `Allow` |
| Native `ConversationBusy` or `ConversationIdle` rejecting admission         | 409              |
| Body above configured limit                                                 | 413              |
| Unsupported request media type                                              | 415              |
| Known unavailable session or native `SessionFailed`                         | 503              |
| Unexpected failure, including server transaction defects                    | 500              |

- `StorageRequestError` from a read is a 400; errors from storage commit or ID
  allocation are fatal, even with that class. The first fatal failure may yield
  500 and subsequent failed-session operations 503. `ReadAfterWrite` is a server
  defect, not bad user input. Untyped upstream context/request-ID errors retain
  the fallback unless an explicit adapter check establishes a different result.
- A 503 does not prove a write failed to commit or permit automatic replay. Do
  not send `Retry-After` without knowing a recovery time. Connection loss
  creates no synthetic response, including no invented 499.
- Missing submission receipts, abort-submission result variants, blocked
  inspection states, and persisted task failures are successful read/result
  representations. Do not turn them into missing-resource or transport errors.
- Model metadata exposes only ID, provider, name, input modes, reasoning,
  context window, max tokens, cost, and supported thinking levels from current
  `Models.getAvailable()` in upstream order. No session is required. Empty
  availability is a successful empty representation, not proof credentials are
  absent or the next model request will succeed. Do not expose model headers,
  base URLs, transforms, or authentication material. The endpoint selects no
  implicit default and performs no explicit model-catalog refresh.

## Testing Decisions

The user confirmed HTTP/HTML/Datastar as PDS's primary behavioral seam, plus the
shared credential-file interoperability boundary. Use real pi-durable Harnesses,
temporary SQLite stores, and the pinned faux provider. Test decoded interface
values, DOM properties, persistent state, and lifecycle ordering rather than
serialized HTML, stdout/stderr, private helpers, or production test hooks.

### Contract coverage

1. Multiple persisted sessions, equal native conversation IDs in different
   stores, repeated concurrent open, root creation separate from open, existing
   root ignoring creation options, missing reads without provisioning, startup
   recovery without a browser, and one failed store not blocking others.
2. Every route's method, address, form/query decoding, native argument/result
   mapping, declared error, and unexpected-error fallback. Include page/cursor
   round trips and invalid/foreign cursors, metadata-only model catalog, and no
   secret-bearing metadata exposure.
3. Native input admission, when-busy/when-idle behavior, request-ID recovery
   after lost acknowledgement, scoped status, queued-input withdrawal, explicit
   abort, reset admission, and compaction task/result distinctions. No automatic
   write retries and no assumption that absence proves failed admission.
4. Agent/env atomicity; preserve/set/clear; initialization and ignored existing
   root options; task-child and fork inheritance; explicit local versus no env;
   unavailable source versus empty inventory; active-operation continuity after
   configuration changes; local/SSH operation without drv.run.
5. Bounded baseline, head outside the window, folded gaps, explicit pages,
   append/partial/final transitions, tool updates, queue, compaction/reset
   boundaries, slow writers, multiple observers, and resource cleanup on
   disconnect/reconnect without execution abort.
6. Generic login interaction, multiple tabs/reconnect, expiry/restart,
   replacement preserving old credentials, cancellation before/after commit,
   logout racing login/refresh, sanitized errors, and separate ambient/stored
   status.
7. Cross-process shared-file locking including symlink aliases; OAuth and
   literal key records; preservation of unrelated data; observed external
   writes; persist-before-success/use; unreadable/malformed files; unsupported
   key expressions; refresh cancellation and failure without account-style
   deletion. Use matching Pi 1.5.2 behavior as a test-only interoperability
   reference, never a production internal API dependency.

### Browser and integration evidence

- Use Chromium only for behavior that requires the actual browser/Datastar:
  admission/draft handling, form errors, native file controls and previews,
  disclosure/scroll preservation, unmodified committed DOM during streaming,
  model-login prompts, prefix-correct navigation, and desktop/mobile controls.
- Prefer the existing [PDS fixtures](tests/fixtures.ts),
  [application tests](tests/application.test.ts),
  [watch tests](tests/watch.test.ts), and
  [Chromium flows](tests/flow.chromium.ts), together with the retained
  [Harness tests](tests/harness.test.ts) and
  [conversation tests](tests/conversations.test.ts).
- Verify actual ordinary SSH through native configuration, including trust
  rejection, rather than matching command arguments. Test optional drv.run
  discovery independently. The parent specification assigns OS-level
  permissions, seed/restart behavior, service modules, and closure checks.
- Measure incremental rendering against the original full-transcript workload
  using equal committed history and partial updates. Report rendering work and
  generated bytes separately from model/network time. Retain PDS's benchmark; do
  not make it a flake check. Capture desktop/mobile screenshots for changed
  interactions rather than asserting visual parity without evidence.
- Relevant package checks and browser tests participate in authoritative Nix
  verification. No new telemetry deployment, Knip requirement, 100% coverage
  threshold, or prohibited `nixos-host-basic` run is imported from old specs.
- Real Codex login/inference and shared CLI interoperability on rock5b require
  separate operator authorization. Offline fixtures and source inspection do not
  satisfy those deployment gates.

## Out of Scope

- Implementation, deployment, migration, code deletion, or live credential use
  during this specification phase.
- GraphQL, a JSON conversation API, Chord replication in the browser, replay
  logs, generic remote transactions/documents, or global replacement IDs.
- Additional app/www UI parity, fork/rewind mutations, arbitrary task control,
  background-abort controls, passive-write/continue APIs, or a new usage API.
  Native fork inheritance remains required when retained harness behavior forks.
- A separate environment mutation endpoint, PDS guest lifecycle management,
  public SSH key/config/trust fields, host-key acceptance UI, or implicit local
  execution.
- Accounts/push management in PDS, provider-specific local authentication,
  accounts-issued model tokens, universal mitm routing of host model traffic,
  newer ChatGPT token sharing, or Pi CLI runtime/internal API dependencies.
- Loading Pi settings, sessions, extensions, model configuration, or executable
  credential expressions; upstream credential revocation on PDS logout.
- Public exposure or application HTTP authentication/authorization; normal
  origin and OAuth interaction safeguards remain required.
- State importers, archives, backward-compatible legacy endpoints, or promises
  stronger than the selected clean-slate cutover and upstream persistence
  behavior.

## Further Notes

### Sources and precedence

- The accepted operation/lifecycle revision is
  [[tasks/070-pds-http-contract.md]]. Credential semantics are
  [[tasks/030-credential-contract.md]]; native SSH and discovery semantics are
  [[tasks/050-infrastructure-contract.md]]. These override old prototype limits,
  GraphQL transport, and the frozen JSON watch in the extraction source.
- Current code is evidence, not a claim of conformance:
  [application](src/application.ts), [server](src/server.ts),
  [observation](src/watch.ts), [browser](src/browser.ts),
  [retained harness](src/harness/index.ts), and
  [environment wrapper](src/harness/env.ts).
- [PDS packaging](default.nix) selects Datastar 1.0.5 and applies the retained
  conversation-context patch. [Manifest](package.json) and
  [lock](package-lock.json) pin the Pi family to 1.5.2. Keep necessary patches
  with PDS when the local durable namespace is removed.
- Pinned upstream authority: [Harness behavior][harness], [Harness
  types][harness-types], [record/query types][durable-types], [submission
  behavior][submissions], [agent configuration][agent], [context
  behavior][context], [Models login/logout][models], [credential
  interfaces][auth-types], [refresh semantics][auth-resolve], and [SSH
  integration][ssh]. Source inspection does not prove runtime conformance.
- [Datastar's Tao][tao] supplies the server-authoritative interaction direction;
  [1.0.5 fetch][datastar-fetch] and [element patches][datastar-elements] govern
  version-specific behavior.

### Credential interoperability details

- Default shared path: `~/.pi/agent/auth.json`. `PI_CODING_AGENT_DIR` overrides
  the agent directory, with the credential filename retained. Any deployment
  path override must deliberately point PDS and the CLI to the same file; an
  isolated service HOME must not silently create a second credential store.
- [Pi CLI 1.5.2 backend][cli-store] uses proper-lockfile on the resolved file,
  merges provider writes, tracks external revisions, and writes in place. Its
  async lock uses a 30-second stale/wait boundary. Match the lock protocol and
  heartbeat behavior, but reject storage failures instead of copying stale-read
  fallbacks. Newly created files/directories use owner-only access; preserve
  intentional existing ownership/ACLs without broadening credential access.
- [Path selection][cli-config] and [key expression semantics][cli-values] are
  interoperability references, not libraries to import. The unsupported key
  expressions include `!command`, `$NAME`, and `${NAME}` templates. Literal
  support must not accidentally interpret those forms or silently reinterpret
  the CLI's escaped-expression syntax as another credential.
- The CLI's [package manifest][cli-package] pins proper-lockfile 4.1.2. PDS may
  depend on that locking library directly, not the CLI runtime. No dependency
  lock or source implementation was changed by this specification.

### Verification status

The test seams are user-confirmed. The specification does not establish shared
file interoperability, native-OpenSSH compatibility, new HTTP behavior, live
provider access, or deployment acceptance. Those remain implementation and
separately authorized acceptance obligations under
[[tasks/060-retirement-gates.md]].

[harness]:
  /nix/store/66k268i56xwl405b3hnz6l84mgb4fl8c-pds-0.1.0/lib/pds/node_modules/@earendil-works/pi-durable/dist/harness/harness.js
[harness-types]:
  /nix/store/66k268i56xwl405b3hnz6l84mgb4fl8c-pds-0.1.0/lib/pds/node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts
[durable-types]:
  /nix/store/66k268i56xwl405b3hnz6l84mgb4fl8c-pds-0.1.0/lib/pds/node_modules/@earendil-works/pi-durable/dist/types.d.ts
[submissions]:
  /nix/store/66k268i56xwl405b3hnz6l84mgb4fl8c-pds-0.1.0/lib/pds/node_modules/@earendil-works/pi-durable/dist/harness/submissions.js
[agent]:
  /nix/store/66k268i56xwl405b3hnz6l84mgb4fl8c-pds-0.1.0/lib/pds/node_modules/@earendil-works/pi-durable/dist/harness/agent.js
[context]:
  /nix/store/66k268i56xwl405b3hnz6l84mgb4fl8c-pds-0.1.0/lib/pds/node_modules/@earendil-works/pi-durable/dist/harness/context.js
[models]:
  /nix/store/66k268i56xwl405b3hnz6l84mgb4fl8c-pds-0.1.0/lib/pds/node_modules/@earendil-works/pi-ai/dist/models.js
[auth-types]:
  /nix/store/66k268i56xwl405b3hnz6l84mgb4fl8c-pds-0.1.0/lib/pds/node_modules/@earendil-works/pi-ai/dist/auth/types.d.ts
[auth-resolve]:
  /nix/store/66k268i56xwl405b3hnz6l84mgb4fl8c-pds-0.1.0/lib/pds/node_modules/@earendil-works/pi-ai/dist/auth/resolve.js
[ssh]:
  /nix/store/66k268i56xwl405b3hnz6l84mgb4fl8c-pds-0.1.0/lib/pds/node_modules/@earendil-works/pi-env/dist/ssh.js
[tao]: https://data-star.dev/guide/the_tao_of_datastar
[datastar-fetch]:
  https://github.com/starfederation/datastar/blob/v1.0.5/library/src/plugins/actions/fetch.ts
[datastar-elements]:
  https://github.com/starfederation/datastar/blob/v1.0.5/library/src/plugins/watchers/patchElements.ts
[cli-store]:
  https://unpkg.com/@earendil-works/pi-coding-agent@1.5.2/dist/core/auth-storage.js
[cli-config]:
  https://unpkg.com/@earendil-works/pi-coding-agent@1.5.2/dist/config.js
[cli-values]:
  https://unpkg.com/@earendil-works/pi-coding-agent@1.5.2/dist/core/resolve-config-value.js
[cli-package]:
  https://unpkg.com/@earendil-works/pi-coding-agent@1.5.2/package.json

# pi-serve architecture specification

## Status and scope

This specification records the agreed architecture for simplifying pi-serve
without losing its user-facing capabilities. It specifies the target design, not
the current implementation. Implementation has not started.

The governing rule is application composition through canonical public APIs. Do
not build a parallel framework, even a small one. Follow [[docs/unix.md]].

Requirements marked **must** are acceptance conditions. Source-backed upstream
behavior is identified separately from application choices. Unresolved
implementation mechanics appear under Implementation investigations; they are
not permission to introduce replacement APIs.

Upstream references use the Pi revision in `flake.lock`:
`71023aec1546d6d677a65669c5665c0927ce0dd0`. The sources were inspected locally
at `/nix/store/cm56v0b7yhvp7dx9gmb88697mj19p7dk-source`. The pinned source links
make that evidence accessible outside this development environment.

### Included

- A single-user server and its browser frontend.
- Multiple independently persisted harnesses.
- Upstream conversation, task, submission, configuration, and observation APIs.
- Independent model and execution-environment composition.
- Selection of available environments, including different drv.run guests.
- Environment switching and historical selection inheritance on forks.
- The existing default coding setup, composed by the application.
- Existing workflow, inspection, settings, repository, and browser capabilities.
- Tests through public interfaces, with meaningful security and lifecycle
  coverage retained.

### Excluded

- A CLI product or command-oriented configuration interface.
- Multiple users, credential tenancy, or per-user authorization inside pi-serve.
- Guest provisioning, starting, stopping, or host administration through
  pi-serve.
- A backend-independent conversation schema.
- A frontend plugin framework in this iteration.
- A replacement runtime, execution interface, extension system, or remote SDK.
- Exposing every upstream method in the first implementation.
- Compatibility layers for the current bespoke HTTP or runtime APIs.

A server process still needs startup and shutdown code. The absence of a CLI
requirement does not remove ordinary service deployment or configuration.

## Boundaries and identities

### Harnesses and UI sessions

One persistent UI session corresponds to one upstream `Harness` over its own
storage. A UI session is not a browser connection, tab, or login. Its root
conversation, forks, and task-owned conversations belong to that harness.

```text
Application
  |
  +-- Harness A / storage A
  |     +-- root conversation ------> guest X
  |     +-- fork -------------------> guest Y
  |     `-- task-owned conversation -> selected environment
  |
  `-- Harness B / storage B
        `-- root conversation ------> guest X
```

The application must manage the collection of harnesses without wrapping each
one in another agent API. Stable storage identity is necessary for selecting and
reopening a harness; it is not a new conversation identity. Resolve
conversation, entry, task, and submission identities within the selected harness
using upstream APIs.

The current SQLite-per-UI-session arrangement can remain. Do not create a new
harness because a browser reconnects, a conversation forks, a model changes, or
a different guest is selected. Multiple harnesses may use the same guest.

Upstream defines a harness as one open storage plus its agent machinery. It
already supports independent conversations, forks, and task-owned conversations.
A storage failure closes the affected harness; an ordinary tool failure does not
close all its conversations. These are meaningful storage and lifecycle
boundaries, not guest isolation boundaries. See [durable concepts and
errors][durable-readme] and [harness APIs][harness-api].

### Application composition

The application owns concrete dependency selection and resource lifetimes:

```text
Application startup
  +-- construct Models
  +-- construct Registry; install extensions
  +-- configure default extension selection and settings
  +-- supply environment resolution and connection ownership
  +-- open storage and Harness
  `-- make the Harness available to the server

Browser -> /api/harness/... -> upstream public APIs
```

Use `Harness.open(storage, options, context)`, `Registry.install()`,
`HarnessOptions.settings`, and `HarnessOptions.env` directly. The application
may compose multiple public calls to implement its own features. It must not
introduce another API for operations already supplied by upstream.

Harness creation and collection management must not import concrete coding, ask,
review, context, codemode, or drv.run extensions as mandatory dependencies. They
must accept arbitrary valid durable agent configurations, including ones that
need no filesystem or shell.

Whether any code remains in `pi-runtime` is an implementation outcome, not a
requirement. A package or shared abstraction needs actual consumers and a
responsibility that upstream does not already fulfill. Do not retain
`ManagedSession` merely to preserve its name or existing callers.

Sources: [HarnessOptions, Registry, and Extension][harness-api]; [public package
exports][durable-exports]. Current contrary responsibilities are concentrated in
`packages/pi-runtime/index.ts`, particularly `ManagedSession.open()`.

## Application defaults

### Models and settings

The standard application must retain the convenience of the existing `pi`
credentials and model configuration. Upstream coding-agent `ModelRuntime`
implements pi-ai `Models`; its default construction supplies that convenience.
This is the default application choice, not the only permitted model source.

An independently supplied `Models` implementation must work with any supported
execution environment. Simulated providers use the same public pi-ai APIs as
real providers, including `createModels()` and `setProvider()`. There must not
be separate production and test integration contracts.

Retain the existing user-facing settings capabilities. Shared settings
persistence belongs to application composition using the existing upstream
configuration APIs, not a second preference store. Explicit application settings
are inputs to durable; absent durable settings must retain upstream defaults. Do
not add hidden scheduling or admission rules while applying those settings.
Explicit conversation choices must not be overwritten merely because application
defaults change.

Sources: [Models][models-api], [ModelRuntime][model-runtime], and
[HarnessSettings and AgentChange][harness-api]. Current settings behavior is in
`packages/pi-serve/server.ts` and `packages/pi-serve/settings.ts`.

### Coding extensions

The standard application must retain the current coding setup:

- Coding tools.
- Codemode and its sandbox.
- Coding instructions and working-directory prompt information.
- Repository and instruction-file context.
- Ask support.
- Review support.

Install these through the canonical registry API in application composition, not
inside a harness factory. Select defaults through
`HarnessOptions.settings.extensions`. Per-conversation changes use upstream
agent configuration.

Preserve the distinction between installation and selection. Currently Ask is
selected by default; Review is installed but excluded from the ordinary default
selection, then selected for review work. Express those choices as
configuration. Do not forcibly reinsert Ask or any other extension after an
explicit configuration change.

Upstream selects every installed extension when there is no explicit default
selection. It stores conversation selections by name rather than persisting
executable extension objects. See [extension selection][durable-readme] and
[Registry and HarnessSettings][harness-api]. The current setup is in
`packages/pi-runtime/index.ts`, inside `ManagedSession.open()`.

## Public server contract

### Upstream APIs are the contract

Durable APIs must be exposed under `/api/harness/`. Their public names,
arguments, return semantics, errors, identities, and defaults are the contract.
HTTP must not introduce a competing agent API.

In particular:

- Expose `Conversation.submit()`, not a new `prompt()` operation.
- Expose `Conversation.abort()`, not a new `stop()` operation.
- Use `AgentChange`, not a narrower application configuration schema.
- Preserve caller-supplied fork options rather than fixing ownership in the
  server handler.
- Preserve submission and task identities and outcomes. Do not replace them with
  an application-only acknowledgement such as `{ accepted: true }`.
- Use upstream views, documents, records, and errors instead of redefining them
  as an application conversation model.
- Do not require UUID request IDs, queue-mode defaults, or lifecycle gates
  merely because the existing wrapper does so. Follow the corresponding upstream
  contract.

Only methods needed by the application must be implemented initially. A method
not yet exposed is an implementation gap, not justification for replacing it
with a bespoke operation. UI labels such as Send and Stop may remain; they do
not define backend APIs.

The method bodies must call upstream public APIs or compose those APIs. Do not
call private scheduler or storage internals to reproduce their behavior. Do not
introduce an adapter class, generic integration factory, or framework to stand
between the server and durable.

Sources: [Conversation, Harness, Submission, and SubmissionDraft][harness-api];
[Session and document APIs][session-api]. Existing replacements are visible in
`packages/pi-serve/server.ts` and `ManagedSession.prompt()`, `resume()`, and
`stop()` in `packages/pi-runtime/index.ts`.

### Required capability coverage

This inventory identifies existing capabilities to preserve, not new method
names or a second API specification. The pinned upstream definitions remain the
source of truth.

| Capability                                     | Canonical public APIs                                               |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| Create or reopen persistent work               | Storage construction, `Harness.open()`, `Harness.root()`            |
| Select and enumerate conversations             | `Harness.conversation()`, `scanConversations()`                     |
| Create independent or task-owned conversations | Upstream conversation creation and transaction APIs                 |
| Submit input, attachments, or entry writes     | `Conversation.submit(SubmissionDraft, ...)`                         |
| Observe or cancel admitted work                | `Submission.status()`, `wait()`, `abort()`; harness submission APIs |
| Configure the agent                            | `Conversation.configure(AgentChange, ...)`                          |
| Fork                                           | `Conversation.fork()` with upstream options                         |
| Abort or resume                                | `Conversation.abort()`, `Harness.resume()`                          |
| Compact or reset                               | `Conversation.compact()`, `Conversation.reset()`                    |
| Observe conversation state                     | `Conversation.watch()` or `viewState()`                             |
| Read history and model context                 | `Conversation.entries()`, `Conversation.context()`                  |
| Inspect tasks and pending work                 | `Harness.inspect()` and the upstream task APIs needed by the UI     |
| Observe extension-owned state                  | Public document snapshot and observation APIs                       |

Creating storage, enumerating independently persisted harnesses, and resolving
drv.run inventory are application responsibilities that an individual durable
harness does not provide. Keep that code limited to those responsibilities. Do
not use it as a home for another conversation API.

Likewise, session naming, transcript export, repository inspection, and path
completion must use upstream data and filesystem/process APIs where available.
Application- or extension-owned data is appropriate when no upstream data
already represents the feature. It is not appropriate to duplicate durable
state.

### HTTP mechanics

The namespace and upstream contract are agreed; complete route syntax and wire
representation are not yet specified. They require source investigation, not a
new domain model.

Public interfaces contain more than JSON values: `Context`, handles,
subscriptions, document tokens, extension objects, and transaction callbacks
need explicit treatment. A TypeScript signature alone is not a wire protocol.
The implementation must establish how each required operation preserves its
public contract across HTTP. It must not hide this issue by substituting
application commands or inventing a callback language or general remote SDK.

Transport parsing, resource addressing, cancellation, and subscription disposal
must not reinterpret durable scheduling or task ownership. In particular, losing
an HTTP connection must not become an implicit conversation abort.

## Execution environments

### Execution and model access remain independent

The environment boundary is upstream `ExecutionEnv`, which combines filesystem
and shell capabilities. Tool implementations and the codemode worker remain
server-side. For a selected guest, `RemoteExecutionEnv` sends filesystem and
process operations to the guest's pi-env daemon.

```text
Server                              Guest
  Harness
    tool implementation
      RemoteExecutionEnv ----------> pi-env daemon
                                       files
                                       child processes

  Models --------------------------> selected model provider
```

The model may be real or simulated independently of whether the execution
environment is real or simulated. Selecting a guest must not select a model
provider, and selecting a model must not constrain the guest.

Use the existing pi-env connection and `RemoteExecutionEnv` APIs directly.
Drv.run-specific code supplies inventory, owner-scoped connection information,
and the selected target. It must not require a replacement for `ExecutionEnv` or
the current `Integration` / `EnvironmentLease` contract around it.

Sources: [ExecutionEnv][execution-env], [pi-env][pi-env-readme], and
[Models][models-api]. Current drv.run connection construction is in
`packages/pi-extensions/drv-run/index.ts`.

### Selection and persistence

Users must be able to select available environments when creating persistent
work and change the selection for an existing conversation. Conversations in one
harness, including forks, may select different guests. Multiple harnesses may
select the same guest. Available local execution remains supported.

Persist the selection as conversation-scoped durable document state using
`defineDoc()` and the public commit APIs. The document must retain historical
selection and use:

```json
{
  "scope": "conversation",
  "history": "rewindable",
  "fork": "asOf"
}
```

Persist destination identity, not live connections, executable environments,
leases, or credentials. Keep the working directory in upstream `pi.agent.cwd`;
do not introduce a second authoritative cwd field. When a selection change also
requires a cwd change, compose document updates and upstream
`configure(tx, ...)` in one commit.

Supply initialization through upstream conversation creation, `init`, or
`conversationCreated` APIs as appropriate. Application-created workflows that
need an environment must initialize the intended selection through those APIs.
Do not assume that document fork rules initialize a newly created, non-forked
conversation.

Selection metadata is an application responsibility because upstream's agent
state has a cwd but no guest-selection field. Upstream already demonstrates
conversation-specific environment lookup through a document; reuse that
mechanism, not a new binding abstraction. See [agent state][harness-api],
[document APIs][session-api], [public configure export][durable-exports], and
[the upstream per-conversation example][environment-example]. The example's
`fork: "initial"` is not the inheritance selected for this application.

### Resolution and switching

Supply `HarnessOptions.env` directly. Upstream calls it with:

```typescript
export type EnvTarget = {
  readonly conversationId: ConversationId;
  readonly cwd?: string;
  readonly read: DocumentReader;
};
```

The resolver reads the selected conversation's committed destination and uses
its current cwd to return the corresponding environment. It must not ignore
`conversationId` and fall back to one frozen harness-wide binding.

Upstream resolves environments for tool execution attempts, prompt-section
preparation, and explicit `runtime.env()` calls. It does not resolve again
before every individual filesystem operation. A recovered tool attempt uses the
environment resolved at that time, not an automatically pinned historic
environment. A change may therefore affect tool calls already requested by a
model but not yet executing.

Do not add a session-wide switch lock, turn-boundary rule, or execution snapshot
that changes those semantics. Returning a different environment for a later call
does not migrate an already-running command. Do not mutate an environment object
shared by active calls to simulate switching.

A fresh environment object per use is supported. Its filesystem `id` must
identify the file namespace: equal IDs mean the same files at the same paths,
independently of cwd. Do not give different IDs to views of the same filesystem
merely because they belong to different conversations. This matters to the
upstream file-write serialization behavior.

Sources: [environment resolver][environment-resolution], [tool execution and
recovery][tool-environment], [prompt preparation][generation-environment], and
[environment documentation][durable-readme].

### Fork semantics

```text
parent selects guest A
  -> entry 10
  -> parent selects guest B
  -> entry 20
  -> fork at entry 10
       -> fork selects guest A
       -> parent still selects guest B
```

The fork inherits the selection as of its selected entry, matching upstream
`pi.agent` inheritance. Its later selection changes are independent of the
parent. This copies neither a VM nor its filesystem. Guest A is used in its
current external state, not restored to its state at entry 10.

If the inherited guest is unavailable, keep its identity and report the
execution failure. Do not silently choose the parent's current guest or the
server's filesystem. Read-only durable history remains accessible.

Sources: [AgentDoc][agent-document] and [document fork
definitions][session-api].

## Lifecycle and failure semantics

Use upstream behavior without a second application policy layer:

- Opening a harness leaves interrupted work pending. Startup must not
  automatically call `resume()`.
- Explicit `Harness.resume()` enables scheduling. Public operations that ask for
  progress may also enable it, exactly as upstream specifies.
- Submitting or aborting must not require a separate Resume action first. Remove
  the `needsResume` admission gate rather than moving it elsewhere.
- Progress in one harness enables that harness's scheduler, not every harness
  managed by the server.
- Within a harness, progress may enable eligible pending work in other
  conversations. Do not introduce a narrower application scheduler.
- Abort scope, background-task behavior, queueing, retries, compaction, request
  deduplication, and extension replacement follow upstream contracts.
- Browser disconnect and reconnect do not abort durable work or create another
  harness. Dispose the disconnected client's observations.
- Reopening reinstalls the configured extension implementations and reconnects
  to persisted state; it does not create a second source of truth for tasks.

No environment resolver means no implicit local execution environment.
Unavailable remote execution must never fall back to server-local file or
process operations. Do not turn this requirement into a new blanket gate on
model calls or read-only durable APIs. Upstream handles environment failures at
their actual use sites: tool environment construction failures become tool
errors; prompt preparation reports non-cancellation environment errors and can
continue without an environment.

Application composition owns resources it creates, including codemode sandboxes
and pi-env connections. Stop and join their consumers before closing those
resources. Shared resources must not be destroyed by closing only one of their
users. Use canonical close and cleanup APIs; distinguish cancellation of one
operation from shutdown of an entire environment. Do not introduce a lease
framework merely to encode this ownership.

Sources: [resume and abort contracts][harness-api], [open and
recovery][durable-readme], [tool failures][tool-environment], [prompt
failures][generation-environment], [Session.close()][session-api], and [pi-env
connection ownership][pi-env-readme].

## Extensions and frontend

### Extension-owned behavior

Coding, codemode, ask, review, repository context, and related domain behavior
belong in extensions or their public application composition, not in harness
management. Existing ask/review capabilities must survive; their placement in
`ManagedSession` is not a contract to preserve.

Extensions own their schemas, state transitions, validation, and public
operations. Implement those operations through durable's existing tools, tasks,
hooks, documents, and transaction APIs. Do not create an application workflow
engine or require extensions to implement a new pi-serve integration interface.

The upstream `Extension` interface has no frontend component or HTTP-handler
field. Do not pretend such a facility exists. Determine how the required
extension public operations reach the browser without placing another generic
workflow API in server core. This is an implementation investigation, not a
mandate to build a plugin framework.

Sources: [Extension][harness-api]; current extension and workflow logic in
`packages/pi-runtime/workflows.ts` and `packages/pi-runtime/context.ts`.

### Frontend state

The frontend is specifically for pi-durable. It may depend on upstream public
`ConversationView`, agent, task, submission, entry, and document types. Do not
introduce a backend-neutral replacement model or continue a bespoke aggregate
`Snapshot` as the authoritative conversation contract.

Durable owns committed execution state. The frontend owns presentation state:
selection, drafts, focus, scroll position, disclosure state, and request or
subscription lifetimes. Derived displays must remain derived, not competing
copies of durable state.

Use upstream observation semantics. A fresh watch starts at the current view;
slow consumers may receive a full-state replacement rather than every
intermediate operation. Reconnect handling must accept that behavior. Late
responses or events from an abandoned view must not overwrite the current
selection or draft.

`ConversationView.docs` contains the mounted built-in documents, not every
extension document. Obtain extension state through the public document APIs
rather than modifying upstream views or reading private storage.

Direct frontend support for specific extensions is acceptable in this iteration.
Keep it dependent on those extensions' public types and operations. A frontend
component-registration or plugin-loading design is explicitly deferred.

Sources: [ConversationView][conversation-view] and [watching a
conversation][durable-readme]. Existing presentation behavior is exercised by
`packages/pi-serve/tests/*.chromium.ts`.

### Capabilities to preserve

Simplification must retain meaningful behavior, not necessarily current code,
endpoint names, or package boundaries:

- Session listing, naming, selection, creation, and reopening.
- Independent model/thinking configuration and available environment selection.
- Initial drafts, attachments, submission retries, and preservation of edits
  made while requests are pending.
- Branch navigation, abort, explicit resume, compaction, reset, and export.
- Streaming text, thinking, tools, images, usage, and execution/context
  inspection, including historical views.
- Ask responses and review creation, reporting, and return/apply behavior.
- Repository status, base-directory selection, and path completion through the
  selected environment.
- Shared settings persistence and conversation-specific choices.
- Reconnect, offline reload behavior, service-worker behavior, responsive
  layout, touch, clipboard, keyboard navigation, focus, scroll, and DOM
  identity.
- Renderer benchmarks and profiling capabilities.

The existing suites are the behavioral inventory, not proof that every tested
wrapper restriction belongs in the new design. Tests enforcing explicit Resume
before other operations or unconditional target validation before model progress
must be reconsidered against the upstream contracts above.

## Security boundary

This is a single-user service. Access control remains at the deployment, proxy,
or network boundary; do not add a multi-user identity system.

Retain meaningful security properties while removing application policy:

- Host/origin validation and cross-site request protections.
- Explicit trusted proxy-origin configuration; forwarded headers must not
  silently bypass the boundary.
- Bounded transport input and safe rendering of untrusted content.
- Private credential and state handling.
- Owner-scoped drv.run discovery, routing, and pinned SSH host keys.
- No remote-to-local execution fallback.
- Correct harness/conversation scoping for operations and returned data.

Transport checks and SSH trust are not substitutes for upstream validation, nor
reasons to narrow arbitrary upstream method arguments. Distinguish real boundary
enforcement from incidental restrictions in the current wrappers.

Current evidence: the request checks in `packages/pi-serve/server.ts`,
`packages/pi-serve/tests/server.test.ts`, and the connection construction and
tests in `packages/pi-extensions/drv-run/`. Existing deployment boundaries are
described in [[docs/security.md]] and [[docs/architecture.md]].

## Test architecture

### One system, its public interface

Each test must name the system whose behavior it verifies and use that system's
public interface. Exporting an internal helper solely for a test does not
establish a public contract. Do not build special cross-component wiring or a
second application architecture for tests.

Application composition must support these independent dimensions:

| Models    | Execution environment |
| --------- | --------------------- |
| Real      | Real                  |
| Real      | Simulated             |
| Simulated | Real                  |
| Simulated | Simulated             |

Use canonical `Models`, providers, `ExecutionEnv`, registries, and storage. A
simulated provider is not a different kind of server integration. Routine
regression tests must remain deterministic and offline; real provider calls are
not required for ordinary verification of this composition contract.

### Backend and extension tests

- Exercise the server through its public network interface, with dependencies
  supplied through normal application composition.
- Exercise extensions through their public APIs and durable's public execution
  and state-observation APIs.
- Assert observable state, identities, outcomes, and resource lifetimes. Do not
  assert stdout/stderr or use string snapshots as behavioral substitutes.
- Verify admission/deduplication, disconnect/reconnect, abort, recovery,
  extension selection, settings persistence, and failure cleanup.
- Verify selected-guest execution, absence of host fallback, switching,
  historical fork selection, and independent selection in sibling conversations
  and separate harnesses.
- Do not require Chromium to prove model/tool/environment composition.
- Core tests must not depend on `example/` flakes.

The existing root drv.run Chromium composition test must not remain a required
browser dependency for backend composition. Its meaningful remote execution,
workflow, and lifecycle coverage belongs in public-interface backend tests. The
existing fixture substitutes SSH/systemd and uses a local pi-env daemon; it is
not evidence of actual SSH or VM execution.

Sources: `tests/pi-serve-drv-run.chromium.ts`, `tests/pi-serve-drv-run.test.ts`,
and `packages/pi-extensions/drv-run/tests/drv-run.test.ts`.

### Browser tests

Retain real browser coverage for native events, focus, geometry, scrolling, DOM
identity, touch, clipboard, and service workers. These cannot be replaced by
string comparisons or backend assertions.

Use deterministic state delivered through the frontend's public interface for
renderer coverage. Rendering fixtures must not require provider calls. Keep
non-browser setup and server tests free of eager Playwright imports.

Test the actual browser/server connection where that connection is the subject;
do not repeat an entire tool-and-guest scenario for each visual behavior.
Screenshots may remain diagnostic artifacts; the current suite does not
establish golden screenshot comparison as a requirement.

## Implementation sequence

This is the order of work, not a commitment to new packages or files.

1. Inventory current feature entry points and their canonical upstream APIs.
   Resolve the implementation investigations below before defining replacement
   network contracts.
2. Move concrete model, extension, default-setting, and resource composition
   into the application. Keep the current coding setup as its configuration.
3. Expose the required upstream public APIs under `/api/harness/`. Remove
   alternate operation names and wrapper-only lifecycle rules as callers move.
4. Replace the frozen harness binding with conversation document selection and
   direct `ExecutionEnv` resolution. Verify switching and historical forks.
5. Move extension-owned behavior out of harness management. Connect the frontend
   to upstream state and extension public interfaces without a new generic UI or
   workflow framework.
6. Reorganize tests around the public boundaries. Retain browser-specific
   coverage and remove unnecessary Chromium dependency from backend tests.
7. Delete code, imports, fixtures, and package boundaries made obsolete by the
   changes. Update affected build inputs and test commands in the same change.
8. Verify feature coverage, security, lifecycle behavior, and measurements
   before claiming the refactor complete.

There is no backwards-compatibility requirement for the old runtime or HTTP API.
Existing persisted data must not be silently discarded or rewritten as a side
effect of a refactor. Any required data-format transition must be explicit; this
specification does not authorize destructive migration.

## Acceptance and verification

The implementation is complete only when these conditions are demonstrated:

1. Two independently persisted UI sessions use separate harnesses and storage. A
   fork stays within its originating harness.
2. Each exposed durable operation matches its pinned upstream public contract;
   no parallel `prompt`, `stop`, or narrower agent API remains.
3. Concrete installed/default extensions are chosen in application composition.
   Harness management works with a valid non-coding registry and does not
   force-install an extension.
4. Standard startup retains the coding configuration and `pi` model/credential
   convenience; independently supplied `Models` still work.
5. Environment selection is conversation-scoped and persistent. Two
   conversations in one harness can execute against different guests.
6. Switching changes subsequent environment resolution without changing model,
   harness, or transcript identity. Historical forks inherit the guest selected
   at their entry, not the parent's current guest.
7. Missing or failed remote execution never performs the operation locally.
   Durable history remains available without requiring guest access.
8. Reopen does not automatically resume. Public progress operations retain
   upstream scheduler behavior without a mandatory Resume gate.
9. Disconnect releases client observations without aborting durable work.
   Resource shutdown does not destroy dependencies still used by another harness
   or active consumer.
10. Existing workflow, inspection, settings, repository, and browser
    capabilities have public-interface coverage at the appropriate boundary.
11. Backend composition tests require no browser. Browser-only properties still
    have real browser tests, and renderer fixtures make no provider calls.
12. Relevant checks pass, remaining failures are reported accurately, and
    obsolete wrapper code is removed rather than left as compatibility glue.

For implementation changes, use `just check`, `node --test "**/*.test.ts"`, and
the relevant Chromium suites. Use `zmx` for long-running commands. Measure
before and after performance work; structural simplification alone does not
prove a performance improvement.

Follow [[CONTRIBUTING.md]] for validation. Do not run the full `nix flake check`
in the coding guest. For Nix-affecting changes, identify the specific checks for
operator execution; CI remains responsible for the full suite. Distinguish
checks actually passed from blocked or pending verification. This
specification-only change requires Markdown validation, not a runtime or Nix
test run.

The prior post-move Chromium run was not fully green: the renderer profiling
test failed a transcript-visibility assertion in
`packages/pi-serve/benchmark.ts`. Do not present that baseline as a passing
suite or silently remove its profiling coverage to complete the refactor.

## Implementation investigations

These mechanics require source-backed resolution before the corresponding
implementation. They do not reopen the agreed architectural requirements.

- Define the exact HTTP addressing and representation of upstream handles,
  results, errors, watches, and cancellation. Verify the necessary methods
  against the pinned public exports, not just their implementation classes.
- Resolve operations involving document tokens, extension/tool objects,
  transaction callbacks, and initialization callbacks. Preserve their public
  semantics without inventing an alternate command API or exposing private
  internals.
- Determine how extension-owned public operations are reached from their
  explicit frontend support. Upstream `Extension` does not supply an HTTP
  dispatch or UI registration contract.
- Choose the minimal stable destination identity and conversation document
  definition. Verify initialization for roots, independent conversations, review
  conversations, and task-owned conversations separately from forks.
- Establish concrete resource ownership and close ordering for registries,
  sandboxes, environment objects, and connections. Do not assume all resources
  have the same lifetime as one harness.
- Confirm whether existing stored data needs an explicit transition. Do not
  invent compatibility infrastructure without an actual requirement.
- Determine final package/file boundaries from the resulting responsibilities
  and real consumers. No new runtime package or plugin framework is presumed.

If investigation reveals a genuine missing upstream capability, state it with
source evidence before proposing additional public surface. Do not disguise a
bespoke replacement as a thin implementation detail.

[durable-readme]:
  https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/README.md
[harness-api]:
  https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/harness/types.ts
[session-api]:
  https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/types.ts
[durable-exports]:
  https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/index.ts
[models-api]:
  https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/ai/src/models.ts
[model-runtime]:
  https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/core/model-runtime.ts
[execution-env]:
  https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/env/index.ts
[pi-env-readme]:
  https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/env/README.md
[environment-example]:
  https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/test/examples/29-sandbox-per-conversation.ts
[environment-resolution]:
  https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/harness/harness.ts#L229
[tool-environment]:
  https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/harness/tool.ts#L401
[generation-environment]:
  https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/harness/generation.ts#L154
[agent-document]:
  https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/harness/agent.ts#L45
[conversation-view]:
  https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/harness/view.ts#L26

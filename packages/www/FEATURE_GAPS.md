# Frontend feature gaps

## Basis

Comparison: the existing `packages/app/serve` frontend against the current
[GraphQL schema and resolvers](../durable/api/graphql/graphql.ts) plus
[HTTP SSE watch](../durable/api/src/stream.ts). Other Durable REST operations
and all old application endpoints are excluded, even where they still exist.

[[packages/www/SPEC.md]] describes the target UX, not only implemented features.
This document records current missing capabilities and parity limits, not an
implementation plan. The agreed additions are instance listing, application
configuration, extensible OAuth2 accounts, best-effort push, and Durable
document queries/mutations. Their contracts are in
[[packages/durable/api/graphql/SPEC.md]]. They remain unimplemented unless the
schema and service provide them; a specification change does not close a gap.

The existing SSE API stays unchanged except for bug fixes. Workflow parity gaps
below do not require new review, directory-validation, or environment
operations. Generic entry writes and model prompts are not substitutes for
document access or privileged application actions.

## Service readiness

The GraphQL schema is executable in tests, but the installed API does not yet
expose it over HTTP. The public entry point exports the REST/SSE API; GraphQL is
a development dependency, and installation includes the SDL rather than an
exported GraphQL runtime. Thus GraphQL-backed features below are supported by
the schema, not yet available through the production package's HTTP interface.

The shared Harness owner is also a composition requirement, not completed
transport wiring. The current REST/SSE API privately owns its instance manager;
GraphQL receives borrowed Harnesses through callbacks. Independently opening the
same persisted storage for each transport would not satisfy the architecture.

Sources: [API entry point](../durable/api/src/index.ts),
[instance owner](../durable/api/src/sessions.ts),
[GraphQL context](../durable/api/graphql/graphql.ts),
[package exports/dependencies](../durable/api/package.json),
[installation](../durable/api/default.nix), and
[[packages/durable/api/graphql/SPEC.md#Ownership, recovery, and deployment]].

## drv.run instance inventory

The existing host CLI enumerates retained instances and reads systemd state.
There is no GraphQL instance inventory. `harnesses` lists Durable sessions, not
host instances, and the conversation watch is not an instance-status feed.

The target is read-only listing with instance identity, available flake
reference, and explicit systemd state/result. The existing retained-directory
listing alone also misses units still starting before their retained metadata
exists. Instance lifecycle mutations are not part of this iteration.

Sources: [host inventory](../../nixosModules/host/command.sh),
[host control](../../nixosModules/host/cli.sh), and
[[packages/durable/api/graphql/SPEC.md#Application services]].

## Session lifecycle and catalog metadata

Existing UX: create a session from the home composer with model, environment,
directory, and optional attachments; `/new` reuses current choices; rename;
archive; recent-session rows show name/date/environment; a session URL opens its
root conversation.

Missing:

- Session creation, rename, and archival mutations.
- Designated root-conversation identity.
- Session name, creation time, execution binding, and the old catalog's
  metadata.

`harnesses` lists accessible persisted session keys. `scanConversations` lists
existing records but cannot distinguish the application's designated root from
other ownerless conversations. Reading a session does not create one. The
built-in SSE documents exclude application `Metadata` and `Environment` docs.

Supported remainder: browse session keys, list their conversations, open an
explicit conversation, and read its resolved model/cwd. No recent-by-creation
ordering or root redirect is implied.

Sources: existing [home/catalog handlers](../app/serve/elm/pages.ts),
[creation and configuration forms](../app/serve/forms.ts),
[session lifecycle and documents](../app/serve/sessions.ts),
[GraphQL Harness and Query fields](../durable/api/graphql/schema.graphql), and
[^mounted-docs].

## Application configuration and captured settings

Existing UX: shared default model/thinking, per-model thinking overrides,
provider transport preference, default delivery mode, steering/follow-up
batching, automatic compaction and retry toggles, read-only policy numbers, and
shared thinking/image visibility preferences.

There is no application-configuration GraphQL read/write surface. The target is
configuration owned by each application (`www`, `harness`, and so on), resolved
through XDG precedence, not a device/global/server settings hierarchy. The old
single settings store and browser-local display persistence are not that
contract.

GraphQL `configure` exposes conversation model, thinking level, and cwd. `agent`
exposes resolved model, thinking, cwd, and instructions, not the full effective
Harness policy. The old `GlobalSettingsStore.bind()` supplies live policy
getters; changing that store can affect existing sessions. That does not satisfy
the new-session capture and existing-session pinning requirement. `pi.agent`
alone is not a snapshot of every `HarnessSettings` field.

Missing:

- XDG application-configuration reads, validated saves, and stale-save
  rejection.
- Creation-time capture and reopen behavior preserving session-effective policy
  rather than reapplying changed application defaults.
- Authoritative effective compaction, retry, and queue policy for inspection.
  The old `(auto)` usage-bar indicator is not generally derivable from stored
  agent values.

The model catalog supplies available models, not application defaults. Existing
conversation configuration, context inspection, and observed usage remain
available. Browser SSE is unrelated to the model-provider transport setting.

Sources: existing [setting definitions](../app/serve/settings.ts),
[settings UI](../app/serve/elm/src/Site.elm),
[context policy projection](../app/serve/inspection.ts),
[usage metadata](../app/serve/elm/stream.ts),
[Agent/AgentChange fields](../durable/api/graphql/schema.graphql),
[current settings persistence and binding](../app/serve/server.ts), and
[[packages/durable/api/graphql/SPEC.md#Application configuration]].

## Linked OAuth2 accounts

Existing UX: OpenAI/GitHub status and identity, device-code login, verification
URL, polling, reauthorization, and logout.

Neither GraphQL nor watch exposes account authorization status or actions. The
existing frontend adapter also hard-codes the OpenAI/GitHub provider set; it
does not satisfy the target of adding other OAuth2 providers without new
frontend pages. Extensible account management is separate from login to drv.run
itself.

Model availability cannot distinguish unconfigured, logged-out, expired, and
failed authorization states. The browser cannot reproduce this workflow from
`models`, and must not receive credentials to bypass the missing boundary.
Provider configuration, grant support, and identity lookup must be explicit;
OAuth2 alone does not make these identical across providers.

Sources: existing [authorization handlers](../app/serve/elm/pages.ts),
[provider boundary](../app/serve/auth.ts),
[model catalog contract](../durable/api/graphql/schema.graphql), and
[[packages/durable/api/graphql/SPEC.md#Linked accounts]].

## Push notifications

Existing UX: enable/disable this device, register a push subscription, reconcile
subscription changes, and open the relevant conversation from a notification.

Missing: push configuration/public key, subscription registration/removal, and
server delivery integration. Browser permission alone does not enable delivery.
SSE supplies neither background push nor a guarantee of updates while the page
is suspended or closed.

The target is best-effort delivery, not a durable notification queue or restart
recovery. Missing reliable-delivery machinery is not a feature gap. Persisted
subscriptions and server-side credentials are still required. No SSE change is
needed for push.

Local notification rendering, safe link handling, and installable static assets
are browser capabilities, not substitutes for these missing service operations.

Sources: existing [push UI/integration](../app/serve/pwa.ts),
[push service](../app/serve/notifications.ts),
[server routes](../app/serve/server.ts), and [worker](../app/serve/worker.js).

## Durable documents

The current GraphQL schema exposes entries and a limited `configure` mutation,
not general document reads/writes. New document queries and mutations are
specified in [[packages/durable/api/graphql/SPEC.md#Durable documents]] and are
not yet implemented. Application `Metadata`, `Environment`, and `Review` are
also absent from the existing SSE mount; adding GraphQL access does not change
that mount.

Document access enables reading and changing registered state, not additional
review, directory-validation, or environment-selection workflow operations.
Absent-document reads must remain non-creating. Document mutations must use the
same Harness owner as the existing SSE API.

Sources: [current schema](../durable/api/graphql/schema.graphql),
[application documents](../app/serve/sessions.ts), and [^mounted-docs].

## Execution environment and filesystem

Existing UX: choose an execution target, browse base directories, complete
`@path` and `/cd` arguments, validate/canonicalize a directory change, open
guest source citations with line anchors, and render guest-file images.

Missing:

- Execution-target catalog, availability, binding reads, and binding changes.
- Filesystem enumeration/completion, canonicalization, and directory validation.
- Guest-file reads for the source viewer and path-backed Markdown images,
  including lazy image loading and file-response revalidation.

GraphQL's literal `cwd` override is supported but does not reproduce the old
`changeDirectory` checks, `~` resolution, or base-directory policy. An arbitrary
entry payload containing a file path does not hydrate its contents. Asking the
agent to read a file is not an equivalent, passive viewer operation.

Document mutations can expose stored execution bindings and cwd; they do not add
target connection checks or path validation. Those additional operations are not
required by the agreed document surface.

Supported remainder: local text/image attachments, embedded image blocks,
recorded tool output, displayed patches/diffs, and literal cwd configuration.
Guest paths can remain readable without a broken viewer link.

Sources: existing [file and completion handlers](../app/serve/elm/frontend.ts),
[environment and directory operations](../app/serve/sessions.ts),
[file viewer](../app/serve/elm/src/FileView.elm),
[reference/image rendering](../app/serve/elm/src/Transcript.elm),
[GraphQL configuration](../durable/api/graphql/schema.graphql), and
[[packages/durable/api/graphql/SPEC.md#Application data and input content]].

## Review lifecycle and application relationships

Existing UX: `/review` creates/reuses a fresh review conversation with copied
agent/environment choices; `/endreview` stops it, sends its report back, clears
review state, and returns to the original conversation. Branch labels and parent
links incorporate application review relationships.

The current GraphQL surface cannot create conversations or read/write the
application documents used by this workflow. Passive writes append transcript
entries; they do not update `Review`, `Metadata`, or `Environment` documents.
The SSE mount does not include those documents either. A stored `app.review`
entry is readable but cannot substitute for current review relationships.

The agreed addition is document access only. It does not require new review
start/end operations or promise the old coordinated review lifecycle. Reading
and editing review state is distinct from creating conversations and
transferring reports.

Supported remainder: navigate ordinary persisted parent/owner relationships,
read existing review transcript content, and render application entries. The old
`/fork` command opens a tree; ordinary tree browsing does not require a fork
mutation and is not itself a gap.

Sources: existing [review lifecycle](../app/serve/review.ts),
[branch relationships](../app/serve/branches.ts),
[command vocabulary](../app/serve/completions.ts),
[GraphQL mutations](../durable/api/graphql/schema.graphql), and [^mounted-docs].

## Live cross-conversation views

The old conversation stream subscribes to Harness-wide commit publications and
adds updated branch trees, session trees, metadata, policy, and context
inspection. The new watch is scoped to one conversation's active entries and
built-in documents. It does not expose the Harness commit feed or invalidate a
catalog when a different conversation changes.

GraphQL can reconstruct ordinary branch/transcript trees and read current or
historical context. Explicit refresh can update those views, but the current
surface does not provide equivalent push-driven freshness across the entire
Harness. It also does not supply the old enriched presentation frames. This is
an accepted limitation: the existing stream remains unchanged except for bug
fixes. Document access does not require enriched frames, deltas, replay, or a
new synchronization endpoint.

This is not a blocker for streaming assistant text, tool progress, inbox,
compaction, or usage in the active conversation. Those are present in the
built-in watch documents. Full-snapshot SSE rather than the old delta protocol
is a transport difference, not evidence that these features are missing.

Sources: existing [enriched stream](../app/serve/elm/stream.ts),
[branch invalidation](../app/serve/branches.ts),
[tree projection](../app/serve/trees.ts),
[current SSE](../durable/api/src/stream.ts), and [^mounted-docs].

## Client constraints, not missing frontend features

The reviewed elm-graphql revision is
[`7b7bdc21bcd5e6021e8fd6223f640f97792087c2`](https://github.com/dillonkearns/elm-graphql/tree/7b7bdc21bcd5e6021e8fd6223f640f97792087c2),
not an installed www dependency. Its selections support objects, interfaces, and
output unions; HTTP distinguishes GraphQL errors with partial data from
transport failures. Optional inputs distinguish omission from explicit null, and
custom scalar codecs can represent native numeric IDs and opaque JSON cursors.
These do not require REST fallbacks. [^elm-client]

Its input-object parser does not read `isOneOf`; generated inputs remain records
of optional fields rather than exclusive alternatives. Thus compile-time
validity does not cover this API's `@oneOf` constraints. Valid submission inputs
are representable, but generated types alone do not prevent selecting zero or
multiple variants. This is a client validation constraint, not a missing submit
operation. [^elm-inputs]

Draft persistence, offline sends, and a generic task-control UI are not required
by [[packages/www/SPEC.md]]. Draft persistence is a deliberate difference from
the old frontend, not a limitation of GraphQL or SSE. No new features follow
merely from the API exposing a lower-level operation.

[^mounted-docs]:
    Pinned Durable 1.4.0
    [view contract](/nix/store/57n99acvmwvfw5qjn7ryqzh8gxg5gcj9-app-node-modules-0.1.0/node_modules/@earendil-works/pi-durable/dist/harness/view.d.ts)
    and
    [mounted document list](/nix/store/57n99acvmwvfw5qjn7ryqzh8gxg5gcj9-app-node-modules-0.1.0/node_modules/@earendil-works/pi-durable/dist/harness/view.js):
    `AgentDoc`, `LiveDoc`, `InboxDoc`, `ProviderDoc`, and `UsageDoc` only.

[^elm-client]:
    Reviewed elm-graphql
    [SelectionSet](https://github.com/dillonkearns/elm-graphql/blob/7b7bdc21bcd5e6021e8fd6223f640f97792087c2/src/Graphql/SelectionSet.elm),
    [HTTP](https://github.com/dillonkearns/elm-graphql/blob/7b7bdc21bcd5e6021e8fd6223f640f97792087c2/src/Graphql/Http.elm),
    [error details](https://github.com/dillonkearns/elm-graphql/blob/7b7bdc21bcd5e6021e8fd6223f640f97792087c2/src/Graphql/Http/GraphqlError.elm),
    [optional arguments](https://github.com/dillonkearns/elm-graphql/blob/7b7bdc21bcd5e6021e8fd6223f640f97792087c2/src/Graphql/OptionalArgument.elm),
    and
    [scalar codecs](https://github.com/dillonkearns/elm-graphql/blob/7b7bdc21bcd5e6021e8fd6223f640f97792087c2/src/Graphql/Codec.elm).

[^elm-inputs]:
    Reviewed elm-graphql
    [input-object parser](https://github.com/dillonkearns/elm-graphql/blob/7b7bdc21bcd5e6021e8fd6223f640f97792087c2/generator/src/Graphql/Parser/Type.elm)
    and
    [input generation](https://github.com/dillonkearns/elm-graphql/blob/7b7bdc21bcd5e6021e8fd6223f640f97792087c2/generator/src/Graphql/Generator/InputObjectFile.elm).

# Frontend feature gaps

## Basis

Comparison: the existing `packages/app/serve` frontend against the current
[GraphQL schema and resolvers](../durable/api/graphql/graphql.ts) plus
[HTTP SSE watch](../durable/api/src/stream.ts). Other Durable REST operations
and all old application endpoints are excluded, even where they still exist.

[[packages/www/SPEC.md]] describes the supported UX. This document records
missing capabilities and parity limits, not proposed routes or an implementation
plan. A feature requiring a new service contract remains unsupported; generic
entry writes and model prompts are not substitutes for privileged application
actions.

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

## Shared settings and effective policy

Existing UX: shared default model/thinking, per-model thinking overrides,
provider transport preference, default delivery mode, steering/follow-up
batching, automatic compaction and retry toggles, read-only policy numbers, and
shared thinking/image visibility preferences.

There is no shared-settings read/write surface. GraphQL `configure` exposes only
conversation model, thinking level, and cwd. `agent` exposes resolved model,
thinking, cwd, and instructions, not the full effective host policy. Stored
`pi.agent` overrides do not establish inherited host defaults.

Consequences:

- Shared autosave and cross-device defaults are unavailable.
- The context panel cannot report authoritative effective compaction thresholds,
  reserve/recent-token policy, or retry/queue policy. The old `(auto)` usage-bar
  indicator is not generally derivable from stored overrides.
- The catalog supplies available models, not the service's selected default.

Supported remainder: conversation model/thinking/cwd configuration, raw context
inspection, observed usage, and local display preferences. Local delivery choice
is not a saved server queue policy. Browser SSE is unrelated to the old setting
for model-provider transport.

Sources: existing [setting definitions](../app/serve/settings.ts),
[settings UI](../app/serve/elm/src/Site.elm),
[context policy projection](../app/serve/inspection.ts),
[usage metadata](../app/serve/elm/stream.ts), and
[Agent/AgentChange fields](../durable/api/graphql/schema.graphql).

## Provider authorization

Existing UX: OpenAI/GitHub status and identity, device-code login, verification
URL, polling, reauthorization, and logout.

Neither GraphQL nor watch exposes provider authorization status or actions.
Model availability cannot distinguish unconfigured, logged-out, expired, and
failed authorization states. The browser cannot reproduce this workflow from
`models`, and must not receive credentials to bypass the missing boundary.

Sources: existing [authorization handlers](../app/serve/elm/pages.ts),
[provider boundary](../app/serve/auth.ts), and
[model catalog contract](../durable/api/graphql/schema.graphql).

## Push notifications

Existing UX: enable/disable this device, register a push subscription, reconcile
subscription changes, and open the relevant conversation from a notification.

Missing: push configuration/public key, subscription registration/removal, and
server delivery integration. Browser permission alone does not enable delivery.
SSE supplies neither background push nor a guarantee of updates while the page
is suspended or closed.

Local notification rendering, safe link handling, and installable static assets
are browser capabilities, not substitutes for these missing service operations.

Sources: existing [push UI/integration](../app/serve/pwa.ts),
[push service](../app/serve/notifications.ts),
[server routes](../app/serve/server.ts), and [worker](../app/serve/worker.js).

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

Missing: conversation creation, application document reads/writes, and review
start/end operations. GraphQL passive writes append transcript entries; they do
not update `Review`, `Metadata`, or `Environment` documents. The SSE mount does
not include those documents either. A stored `app.review` entry is readable but
cannot substitute for the complete lifecycle or current review relationships.

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
historical context. Refresh or polling can update those views, but the current
surface does not provide equivalent push-driven freshness across the entire
Harness. It also does not supply the old enriched presentation frames.

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

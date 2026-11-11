# Frontend feature gaps

## Basis

Remaining parity gaps against the existing `packages/app/serve` frontend,
assuming [[packages/www/SPEC.md]] and [[packages/durable/api/graphql/SPEC.md]]
are fully implemented. Specified features are not gaps merely because their
implementation is pending. This is not an implementation checklist or a request
to add every old workflow.

## Session creation and archival

The old home composer and `/new` create a session with selected model,
environment, directory, and attachments. The target only opens existing
sessions. It also lacks the old session archival action.

Sources: [creation handlers](../app/serve/elm/pages.ts),
[creation forms](../app/serve/forms.ts), and
[session creation and archival](../app/serve/sessions.ts).

## Root-conversation navigation

The old application assigns a root conversation and opens it from a session URL.
The specified catalog exposes session keys and conversation listings, not a
designated root. Neither ordinary conversation ancestry nor readable application
metadata supplies a guaranteed root identity. The session URL therefore opens a
conversation list rather than the old direct landing page.

Source: [existing root acquisition and catalog](../app/serve/sessions.ts).

## Execution-target discovery and filesystem access

The old frontend discovers execution targets with labels, availability, and
base-directory policy. Instance inventory reports host service state; it does
not supply that full execution-target catalog or verify a connection to a
selected environment. Stored binding and cwd documents are readable and writable
under the spec and are not themselves gaps.

Remaining filesystem features are directory browsing, `@path` and `/cd`
completion, directory validation/canonicalization, source-file viewing with line
anchors, and guest-file Markdown images. Neither literal cwd changes nor
document access performs these filesystem operations.

Sources: [target and directory operations](../app/serve/sessions.ts),
[file/completion handlers](../app/serve/elm/frontend.ts),
[file viewer](../app/serve/elm/src/FileView.elm), and
[reference/image rendering](../app/serve/elm/src/Transcript.elm).

## Starting a review conversation

The old `/review` creates a fresh conversation and copies agent/environment
choices while updating both review documents in one transaction. The specified
API permits document reads/writes but not conversation creation or a remote
multi-document transaction. It therefore cannot reproduce that start operation.
Review metadata access is not a gap, and this does not require a dedicated
review operation as part of document access.

Source: [review creation](../app/serve/review.ts).

## Harness-wide live freshness

The old conversation stream invalidates branch/session trees and presentation
metadata after Harness-wide commits. The retained SSE API observes one
conversation's active entries and built-in documents. Other specified views
remain GraphQL reads; they do not receive equivalent push-driven updates when
another conversation changes. This is a freshness gap, not missing read/write
access, and does not prevent live assistant text, tools, inbox, or usage in the
active conversation.

Sources: [old enriched stream](../app/serve/elm/stream.ts),
[branch invalidation](../app/serve/branches.ts),
[tree projection](../app/serve/trees.ts), and
[retained SSE adapter](../durable/api/src/stream.ts).

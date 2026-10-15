# Frontend feature gaps

## Basis

Remaining parity gaps against the legacy frontend, assuming
[[packages/www/SPEC.md]] and [[packages/durable/api/graphql/SPEC.md]] are fully
implemented. Specified features are not gaps merely because their implementation
is pending. This is not an implementation checklist or a request to add every
old workflow. Current deployment limitations are distinguished below from
missing API contracts.

## Session archival

The target lacks a session archival action. Session creation and reserved root
navigation are specified and are not gaps. Archival requires an
application-owned contract for catalog visibility and coordination with open
Harnesses; it is not a Durable close operation.

Sources: [API schema](../durable/api/graphql/schema.graphql) and
[[packages/www/SPEC.md#Creating sessions and conversations]].

## Execution-target verification and filesystem access

Instance discovery, SSH connection data through `Instance.connect`, and typed
conversation target selection through `env` are covered. Agent and target
changes use `configure`; they do not require generic document writes. These are
not target-discovery or selection gaps.

What remains absent is verified connectivity and base-directory policy.
Inventory state and connection material do not prove that a selected target is
reachable or that a working directory is valid.

Remaining filesystem features are directory browsing, `@path` completion,
directory validation/canonicalization, source-file viewing with line anchors,
and guest-file Markdown images. Neither literal cwd changes nor document access
performs these filesystem operations.

Sources: [inventory service](../durable/api/src/inventory.ts),
[API schema](../durable/api/graphql/schema.graphql), and
[[packages/durable/api/graphql/SPEC.md#Execution environment]].

## Starting a review conversation

The missing atomic start operation creates a fresh review conversation, copies
agent/environment choices, and updates both review relationships in one
transaction. The API permits conversation creation and, where deployment allows
it, individual document reads/writes, but not a remote transaction combining
those operations. Separate commands do not reproduce the atomic start operation.
Generic conversation creation is not a gap, and generic document access does not
imply a dedicated review operation.

Review metadata access is also unavailable in the current deployment:
`app.review` exists in the extracted Harness, but the application exposes only
`AgentDoc` and `Env` for document discovery and reads, without generic write
bindings. Exposing review metadata would not by itself supply the atomic review
workflow.

Sources: [review document and extension](../durable/harness/src/review.ts),
[application bindings](../durable/api/src/application.ts), and
[mutation contracts](../durable/api/graphql/schema.graphql).

## Harness-wide live freshness

The watch stream synchronizes one conversation's bounded fork-visible entry
window and built-in documents, plus a separate head marker, using Chord
operation batches. It is not a Harness-wide change feed. Catalogs, branch and
ancestry views, and other conversations remain GraphQL reads; they do not
receive equivalent push-driven updates when another conversation changes.

This is a freshness gap, not a missing read contract, and does not prevent live
assistant text, tools, inbox, or usage in the observed conversation.
Reconnecting obtains a fresh bounded baseline, not a replay of Harness-wide
changes.

Sources: [[packages/durable/api/watch/SPEC.md]],
[watch implementation](../durable/api/watch/watch.ts), and
[GraphQL reads](../durable/api/graphql/schema.graphql).

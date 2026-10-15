# Datastar prior art

Five source-reading candidates for PDS, reviewed on 2026-11-17. Repository
documentation and selected implementation files were inspected; these are not
production-quality audits or dependency recommendations.

Check examples against the Datastar version pinned in
[default.nix](default.nix). In particular, historical examples are architectural
references, not syntax-compatible drop-ins.

## 1. Official Datastar website

- Live: [data-star.dev](https://data-star.dev/).
- Historical source:
  [`site/` at `v1.0.0-beta.11`](https://github.com/starfederation/datastar/tree/v1.0.0-beta.11/site).
- Stack: Go, Chi, Templ.
- Start with
  [`router.go`](https://github.com/starfederation/datastar/blob/v1.0.0-beta.11/site/router.go)
  and
  [`routes_examples.go`](https://github.com/starfederation/datastar/blob/v1.0.0-beta.11/site/routes_examples.go),
  then the paired `routes_examples_*.go` and `.templ` files.

This is actual website code, including routing, interactive examples, and smoke
tests, rather than isolated snippets.

**Caveat:** current website source was not located. The public historical source
uses an older API. The project's
[contribution guide](https://github.com/starfederation/datastar/blob/develop/CONTRIBUTING.md)
documents development in a private repository, with framework releases published
publicly; it does not establish where the current website implementation lives.

## 2. Todostar

- [Repository](https://github.com/romshark/todostar).
- Stack: Go, Templ, Datastar.
- Read [`server/`](https://github.com/romshark/todostar/tree/main/server),
  [`get_index.go`](https://github.com/romshark/todostar/blob/main/server/get_index.go),
  and [`events/`](https://github.com/romshark/todostar/tree/main/events).

A compact collaborative todo application. Useful for mutation handlers, forms,
domain events, subscriptions, and connection cleanup.

**Caveat:** explicitly a tech demo. Its subscription handler re-queries and
patches the complete todo view on changes; it is not an incremental-rendering
reference.

## 3. ForumChat

- [Repository](https://github.com/atvirokodosprendimai/forumchat).
- Stack: Go, Chi, Templ, SQLite.
- Start with
  [`internal/agent/handler.go`](https://github.com/atvirokodosprendimai/forumchat/blob/main/internal/agent/handler.go).

A substantial self-hosted community application with chat, forums, attachments,
persistent AI conversations, streaming responses, MCP tools, and notifications.
It has the closest functional overlap with PDS among these candidates.

The agent handler subscribes before initial rendering to avoid missing updates.
Its generation-response path patches the growing assistant bubble and performs a
final conversation morph. It also handles disconnects and subscription cleanup.

**Caveats:** other paths still re-render whole conversations, and periodic
re-sync loops remain. Study those trade-offs rather than copying the
architecture wholesale. The repository uses AGPL-3.0.

## 4. Soffio

- [Repository](https://github.com/xfyyzy/soffio).
- Stack: Rust, Axum, Askama, SQLx.
- Read
  [`templates/admin/`](https://github.com/xfyyzy/soffio/tree/main/templates/admin)
  and
  [`src/infra/http/admin/`](https://github.com/xfyyzy/soffio/tree/main/src/infra/http/admin).

A self-hosted publishing system with an extensive Datastar-powered
administration interface. Useful examples of editors, uploads, job status,
settings, and separately rendered panels.

**Caveat:** archived; its README identifies `v0.1.17` as the final release.
Useful source material, not an actively maintained dependency.

## 5. TypeScript chat example

- [Repository](https://github.com/Mortalife/datastar-chat-example-ts).
- Stack: TypeScript, Hono, SQLite.
- Start with
  [`src/`](https://github.com/Mortalife/datastar-chat-example-ts/tree/main/src),
  especially
  [`page-update.ts`](https://github.com/Mortalife/datastar-chat-example-ts/blob/main/src/page-update.ts).

The closest language match to PDS. Useful for comparing SSE and HTML-rendering
plumbing.

**Caveat:** `sendPage` rebuilds the complete chat page. Treat this as a teaching
example, not a performance or authentication reference.

## Suggested reading order

For PDS, inspect ForumChat's streaming handler first, then Todostar's
subscription lifecycle. Use the historical official site for broader interaction
examples and Soffio for administration and form workflows.

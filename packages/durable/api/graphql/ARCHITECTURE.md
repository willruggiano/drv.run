# GraphQL architecture

This document gives the target architecture. It assumes the contracts in
[[packages/durable/api/graphql/SPEC.md]].

## Package and module layout

GraphQL is part of `durable-api`. The package uses this layout:

```text
packages/durable/api/
  graphql/
    graphql.ts             all handwritten GraphQL code, including HTTP handling
    schema.graphql         generated SDL, tracked in version control
    generated/graphql.ts   generated executable schema, not tracked
    tsconfig.grats.json    Grats configuration
    graphql.test.ts        executable-schema tests
    tests/*.test.ts        HTTP and shared-owner tests
  src/
    index.ts               API owner and router for GraphQL and REST/SSE
    sessions.ts            shared Harness manager
    stream.ts              SSE adapter
    telemetry.ts           telemetry adapter
  tests/                   REST/SSE and Harness manager tests
  dist/                    compiled JavaScript and declarations
```

[graphql.ts](graphql.ts) contains all handwritten GraphQL declarations,
resolvers, scalars, context, schema construction, and HTTP handling. Durable,
settings, inventory, accounts, and push are peers in one application schema.
There are no domain-specific schema modules or schema-extension frameworks.

Resolvers are exported functions next to their interfaces, not interface
methods. Schema construction does not start a listener. Service implementations
remain separate from GraphQL code and supply typed dependencies.

The [manifest](../package.json) lists package exports. The
[Nix derivation](../default.nix) installs the compiled modules and generated
schema at those paths. SDL is a reference for consumers, not the runtime schema
source.

## Dependencies and schema construction

The package uses strict TypeScript, Node.js ES modules, Grats, and GraphQL.js.
The [manifest](../package.json) and [lockfile](../package-lock.json) pin
dependencies. Nix supplies the TypeScript compiler. Grats and TypeScript are
build dependencies. GraphQL.js is a runtime peer dependency and a development
dependency for generation and tests. The deploying application supplies one
shared GraphQL.js instance. Any HTTP integration library is a runtime
dependency.

Grats generates SDL and executable bindings from TypeScript declarations and
annotations. Each API instance constructs one executable schema with explicit
scalar coercion functions. Requests do not generate or modify the schema. There
is no second handwritten resolver map. TypeBox validators apply only where their
contracts match the scalar contracts.

Grats supplies typed resolver contexts through its native context mechanism.
Sources: [schema factory](graphql.ts),
[Grats configuration](tsconfig.grats.json),
[[packages/durable/api/node_modules/grats/llm-docs/docblock-tags/context.md]],
and
[[packages/durable/api/node_modules/grats/llm-docs/docblock-tags/scalars.md]].

## Composition and ownership

```text
application
  |-- authorized service bindings
  |     |-- Durable: shared Harness manager + factory
  |     |-- settings
  |     |-- instance inventory
  |     |-- accounts
  |     `-- push
  `-- API owner/router
        |-- GraphQL HTTP handling -> GraphQL.js -> one application schema
        `-- REST/SSE handlers

GraphQL resolvers -----> typed service interfaces
GraphQL and REST/SSE --> shared Harness manager
```

The application constructs the services and supplies authorized bindings to one
API owner. The API constructs one schema and request contexts with typed service
bindings. Scalars and identity conventions are shared across the schema.
`Query.node` dispatches both Durable and other service identities.

Resolvers receive dependencies through typed arguments and contexts, not mutable
global variables. Durable resolvers call upstream interfaces directly, without
the [REST dispatcher](../src/operations.ts). The application supplies the
[Harness factory](../../harness/src/index.ts). Resolvers do not import that
factory.

The Harness manager owns acquisition, failure recovery, and shutdown. Request
contexts borrow its interfaces and carry cancellation signals. GraphQL and
REST/SSE do not keep separate Harness caches.

GraphQL and REST/SSE share a listener and router, with separate protocol
handlers. Deployment owns the listener. No specific HTTP or GraphQL server
framework is necessary. A framework compatibility layer is not necessary.

Application services own provider protocols, file persistence, host control, and
notification delivery. Their internal architecture is outside this package.
Sources: [sessions](../../../app/serve/sessions.ts),
[settings](../../../app/serve/settings.ts),
[authorization](../../../app/serve/auth.ts), and
[notifications](../../../app/serve/notifications.ts).

## Tests

Tests use these interfaces:

| Interface            | Test method                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| Executable schema    | GraphQL.js execution and schema introspection                                                            |
| Durable              | Real Harness, MemoryStorage, and deterministic faux models. Persistent storage for reopen tests          |
| HTTP adapter         | Local Node server and HTTP requests                                                                      |
| Harness manager      | GraphQL and REST/SSE with one manager. Observable acquisition, failure, cancellation, and shutdown state |
| Application services | Service tests and executable-schema tests with injected interfaces                                       |
| Installed package    | Consumer import and execution tests with the runtime peer and without development dependencies           |

The schema tests use generated bindings, not only direct resolver calls. Service
tests supply their own provider fixtures and persistence tests. Schema tests
exercise fields from multiple services in one operation. Durable tests do not
require other service implementations.

Tests inject failures through typed service and storage interfaces. Explicit
state transitions control concurrent operations, not elapsed-time delays.
Assertions examine decoded data, error codes, error paths, resource state, and
calls. They do not compare logs, source text, or serialized responses.

Node tests validate the package interfaces. Consumer packages own browser tests.
VM tests validate only host/guest integration. Nix checks validate generation,
types, tests, and installation. Coverage includes handwritten GraphQL code, but
excludes generated bindings.

Sources: [schema tests](graphql.test.ts), [REST/SSE tests](../tests),
[Nix checks](../default.nix), and [coverage configuration](../package.json).

## Benchmarks

Benchmarks measure adapter overhead with deterministic fixtures, without
model-provider latency. They compare direct upstream calls, schema execution,
and HTTP requests. They measure schema construction, cold acquisition, and warm
requests separately.

Workloads include nested selections, repeated aliases, pagination, large
content, and concurrent GraphQL/SSE observation. Results include latency
distributions, throughput, memory, and upstream call counts. They identify
fixture sizes, concurrency, runtime versions, and hardware. Before-and-after
measurements use the same workloads and protocol budgets.

Measurements justify optimizations. Benchmarks use optional `passthru.bench`
outputs, not flake checks. Correctness checks use deterministic tests, not
timing thresholds.

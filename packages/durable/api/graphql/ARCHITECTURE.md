# Durable GraphQL architecture

This is the target architecture, not an implementation plan or a claim that all
components already exist. [[packages/durable/api/graphql/SPEC.md]] is prior
reading. Application-service internals belong to their owning packages; this
architecture covers their composition with GraphQL.

## Package and module layout

GraphQL belongs to `durable-api`, not a separate npm package. The enclosing
[manifest](../package.json), [TypeScript configuration](../tsconfig.json), and
[Nix derivation](../default.nix) own dependencies, compilation, and
installation.

```text
packages/durable/api/
  graphql/
    graphql.ts             handwritten Durable schema, resolvers, schema factory
    http.ts                HTTP integration, independent of listener ownership
    schema.graphql         generated SDL, checked in for consumers
    generated/graphql.ts   generated executable schema, not checked in
    tsconfig.grats.json    schema-generation configuration
    graphql.test.ts        executable-schema tests
    tests/*.test.ts        HTTP and composition tests
  src/
    sessions.ts            shared instance-ownership implementation
    stream.ts              existing SSE adapter
    telemetry.ts           existing telemetry integration
  tests/                   existing REST/SSE and owner tests
  dist/                    installed JavaScript and declarations
```

Handwritten Durable types, functional resolvers, scalar implementations, and
projection helpers stay together in `graphql.ts`. Resolvers are exported
functions colocated with their associated interfaces, not methods on GraphQL
interfaces. HTTP integration is separate so schema execution has no dependency
on request objects, routing, or a listening socket.

Application schema extensions and service bindings live with the application,
not in this directory. They depend on the reusable GraphQL surface; the reusable
package has no reverse dependency on application implementations. Module
extraction follows an actual ownership boundary or multiple consumers, not one
file per GraphQL type or a generic repository/service framework.

The package exposes the schema factory and context types independently of HTTP
integration. Compiled handwritten and generated modules ship together; SDL is a
consumer artifact, not the runtime schema source. Package exports and installed
artifact paths agree. Grats and the TypeScript compiler are build dependencies;
GraphQL.js and any selected HTTP integration library are runtime dependencies.

Sources: [schema module](graphql.ts),
[generation configuration](tsconfig.grats.json),
[package exports and scripts](../package.json), and
[installation](../default.nix).

## Technology and schema construction

The implementation uses strict TypeScript, Node.js ES modules, Grats, and
GraphQL.js. Dependency versions come from the enclosing manifest and lockfile;
the compiler comes from Nix. This retains the existing toolchain rather than
introducing another schema language or execution engine.

TypeScript declarations and Grats annotations are the sole authored schema.
Grats generates SDL and executable bindings at build time. Each API instance
constructs its executable schema once, with scalar implementations supplied to
the generated factory. There is no request-time generation, SDL reload, second
handwritten resolver map, or patching of generated bindings.

Scalar coercion is explicit runtime code, not a consequence of a TypeScript
alias. Existing TypeBox validators are reused only where their contracts match.
Grats supplies the resolver context through its native context mechanism.

Sources: [schema factory and validators](graphql.ts),
[generation options](tsconfig.grats.json), and the pinned
[[packages/durable/api/node_modules/grats/llm-docs/docblock-tags/context.md]]
and
[[packages/durable/api/node_modules/grats/llm-docs/docblock-tags/scalars.md]].

## Composition and dependency direction

```text
application composition
  |-- executable schema: Durable + application extensions
  |-- authorized service bindings
  |-- shared Harness owner + factory
  `-- listener/router
        |-- GraphQL HTTP integration -> GraphQL.js -> functional resolvers
        `-- SSE adapter

Durable resolvers ----> injected capabilities ----> upstream Harness interfaces
application resolvers -> application services
GraphQL and SSE ------> the same service-owned Harness manager
```

The composition root connects schema, services, access policy, and transports.
Application extensions participate in schema construction, not request-time
resolver-map mutation. Their contexts carry their own service capabilities
rather than turning the Durable context into a service locator. Shared scalar
and identity definitions have one schema owner, not parallel handwritten copies.

Resolvers call upstream interfaces directly. The
[REST dispatcher](../src/operations.ts) is a reference, not an internal RPC
layer for GraphQL. The concrete [Harness factory](../../harness/src/index.ts) is
bound by the composition root, not imported by resolvers. Dependencies arrive
through explicit typed arguments and contexts, not ambient mutable state.

Service-lifetime state and request-lifetime state are separate. The owner
manager holds acquisition and lifecycle state; request contexts borrow
capabilities and carry cancellation. The owning service controls failed-instance
retirement and reacquisition. Neither an HTTP handler nor a resolver owns an
independent Harness cache. This places lifecycle coordination at one boundary
instead of adding inter-transport locking.

GraphQL and SSE may share a listener and router. Colocation does not merge their
protocol handlers, and separate mounts do not imply separate owners. No HTTP or
GraphQL server framework is prescribed. The HTTP integration adapts protocol
requests to the executable schema; the embedding application supplies routing
and listener policy. A framework is replaceable without changing resolvers or
service ownership. A generic framework compatibility layer is not required.

Application resolvers translate between the schema and their service interfaces;
provider protocols, file persistence, host control, and notification delivery
remain behind those interfaces. Sharing an endpoint does not move those
implementations into the Durable package. Existing owners are visible in
[application sessions](../../../app/serve/sessions.ts),
[settings](../../../app/serve/settings.ts),
[authorization](../../../app/serve/auth.ts), and
[notifications](../../../app/serve/notifications.ts).

## Verification boundaries

Tests exercise the smallest public boundary that can establish a property:

| Boundary             | Evaluation                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| Executable schema    | GraphQL.js execution with real generated bindings; decoded results and schema introspection          |
| Durable integration  | Real Harness with MemoryStorage and deterministic faux models; persisted storage for reopen behavior |
| HTTP integration     | Local Node server and real requests, independent of the application server framework                 |
| Shared ownership     | GraphQL and SSE composed with one owner; acquisition, cancellation, failure, and shutdown state      |
| Application services | Service-owned suites plus schema-composition tests using narrow injected interfaces                  |
| Installed package    | Export imports and execution after development dependencies are pruned                               |

The behavioral cases come from SPEC, not a second checklist here. Schema tests
prove resolver binding as well as conversion; calling a resolver directly alone
does not establish executable-schema correctness. HTTP tests isolate transport
behavior from Harness execution. Composition tests establish that independently
correct adapters actually share ownership. Application-service suites own local
provider fixtures and persistence tests rather than requiring those systems in
the reusable Durable suite.

Fault injection occurs at typed service and storage boundaries. Deferred
operations and explicit state transitions control races; elapsed-time sleeps do
not establish ordering. Assertions inspect decoded data, error codes and paths,
resource state, and observed calls, not logs, generated-source text, or
serialized response snapshots. Real interfaces remain the reference for minimal
test doubles.

Node tests are sufficient for this package's schema, HTTP, and lifecycle
boundaries. Browser tests belong to consumers; VM tests are reserved for
behavior that actually depends on host/guest integration. Nix checks verify
generation, types, tests, and the installed runtime artifact. Coverage includes
handwritten GraphQL production code, not generated bindings; generated-schema
execution and installation tests cover the latter boundary. Coverage thresholds
are not a substitute for lifecycle and failure tests.

Sources: [existing executable-schema fixtures](graphql.test.ts),
[REST/SSE tests](../tests), [check and install phases](../default.nix), and
[coverage configuration](../package.json).

## Performance evaluation

Optimization is justified by measured adapter overhead, not schema size alone.
Benchmarks separate direct upstream calls, executable-schema execution, and HTTP
round trips over the same deterministic fixtures. They exclude model-provider
latency and distinguish schema construction, cold owner acquisition, and warm
requests.

Representative workloads include nested selections, repeated aliases,
pagination, large content projections, and concurrent GraphQL/SSE observation.
Measurements record latency distributions, throughput, memory, upstream call
counts, fixture sizes, concurrency, runtime versions, and hardware. Call counts
and resource state reveal amplification or retention hidden by latency alone.
Before/after comparisons use identical workloads and the same protocol budgets.

Benchmarks are optional package `passthru.bench` outputs, not timing-sensitive
flake checks. There is no speculative cache, batching layer, or benchmark
framework requirement; any optimization remains subject to the independent-read
and ownership contracts. Correctness regressions belong in deterministic tests.

# Durable API

TypeScript backend extracted from `packages/app`. `packages/durable` is an
organizational directory, not a package.

## Direction

- Manage persisted Harness instances through an injected factory function for
  creating a Harness. Depend only on upstream Durable's `Harness` type, not on
  `packages/durable/harness`.
- Implementing the factory and connecting it to the API is a configuration and
  deployment concern.
- Treat upstream Durable as canonical for conversations. Keep operation names,
  arguments, results, and semantics as close to upstream as transport permits.
- Expose JSON-, stream-, or event-based operations such as submit, fork, and
  configure. Add only the minimum application-specific API needed by drv.run.
- Keep transactions and execution callbacks server-side. Do not introduce a
  remote transaction language or adopt Chord's distributed object runtime.
- Preserve submission identity, admission semantics, and the distinction between
  disconnecting an observer and aborting execution.
- Keep interfaces small and deep, with at most three exports per TypeScript
  module. Do not export production internals solely for tests.

## Next steps

- Map existing callers to upstream operations and identify necessary transport
  adaptations and application-specific additions.
- Settle observation delivery, including snapshot cost versus client
  bookkeeping.
- Extract the backend while preserving lifecycle behavior and regression
  coverage.

# www

Elm frontend extracted from `packages/app`.

## Direction

- Use idiomatic Elm organization. Replace TypeScript application logic with Elm.
- Keep the client more or less stateless: retain presentation state and drafts,
  but leave execution, persistence, and consistency to Durable.
- Request operations and display observations through `packages/durable/api`.
- Keep browser interop narrow. Do not introduce a client transaction engine or
  Chord's distributed object runtime.
- Keep TypeScript modules to at most three exports. Do not export production
  internals solely for tests.

## Next steps

- Define the API surface needed by the existing frontend.
- Settle observation delivery before committing to client-side bookkeeping.
- Move the frontend into this package and replace TypeScript application logic
  incrementally, preserving existing behavior and regression coverage.

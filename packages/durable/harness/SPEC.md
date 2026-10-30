# Harness

The existing `packages/app/harness` implementation as a standalone package.

## Direction

- Move the implementation unchanged; do not redesign the Harness or its
  extensions.
- Keep it self-contained and independent of `packages/durable/api` and
  `packages/www`.
- Preserve the project's pinned Pi dependencies and required Durable patch.
- Keep internal export cleanup outside this extraction.

## Next steps

- Extract the existing implementation and tests into this package.
- Establish its standalone build without changing execution semantics.
- Verify the existing Harness tests against the same patched dependencies.

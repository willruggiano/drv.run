# Contributing to Durable GraphQL

Read [[packages/durable/api/graphql/SPEC.md]] and
[[packages/durable/api/graphql/ARCHITECTURE.md]] before changing the package.
Repository-wide commands and contribution rules are in [[README.md]] and
[justfile](../../../../justfile).

## Making a change

1. Identify the affected contract in SPEC and inspect the corresponding pinned
   upstream interface and implementation. For an intentional contract change,
   update SPEC; for an internal organization change, update ARCHITECTURE. Keep
   README as the navigation entry point, not another description of either.
2. Change the handwritten declarations, descriptions, and resolvers. Regenerate
   the schema rather than editing generated files. Review the SDL diff for
   unintended changes to names, nullability, input variants, and exposed fields.
3. Add regression coverage at the boundary selected by ARCHITECTURE. Exercise
   the relevant SPEC contracts through the executable schema, not only helpers.
   For storage-error changes, inject failures at the read, commit, and ID-mint
   boundaries; an exception-class-only fixture does not establish origin-aware
   classification. For public projections, use secret-bearing fixtures and
   inspect decoded selections as well as schema field definitions.
4. When adding modules or runtime dependencies, check the TypeScript and Grats
   inputs, package exports, Nix source fileset, installed artifacts, test
   discovery, and coverage inclusion. Verify the package after pruning
   development dependencies. Do not lower coverage thresholds or exclude new
   production code to make checks pass.

Sources: [manifest and coverage](../package.json),
[Grats inputs](tsconfig.grats.json), [build inputs](../tsconfig.build.json),
[package build and dependency patch](../default.nix), and
[executable-schema tests](graphql.test.ts).

## Verification commands

Run commands from the repository root. The self-contained package build uses
pinned dependencies, applies the package's upstream patch, and runs its check
and installation phases:

```sh
nix build .#durable-api --no-link -L
```

For iteration with the package's dependencies available and the Nix-provided
compiler on PATH:

```sh
npm --prefix packages/durable/api run build:graphql
npm --prefix packages/durable/api run check
node --test packages/durable/api/graphql/graphql.test.ts
npm --prefix packages/durable/api test
```

`npm test` selects the enclosing package's `tests/*.test.ts`; it does not select
the GraphQL suite. Run that suite explicitly. Inspect actual test and coverage
selection in [package.json](../package.json), not just a successful percentage.

For documentation changes:

```sh
nix fmt -- packages/durable/api/graphql/*.md
markdownlint-cli2
```

Use the repository checks in [justfile](../../../../justfile) for cross-package
changes. Keep long checks in a task-specific zmx session; wait for completion
and inspect its exit status. Report exact commands and outcomes, including
anything not verified. A generated schema or a successful type check alone is
not proof that the installed server works.

# Contributing to Durable GraphQL

Read [[packages/durable/api/graphql/SPEC.md]] before you change the package.
Then read [[packages/durable/api/graphql/ARCHITECTURE.md]]. Repository
contribution rules are in [[README.md]].

## Code changes

1. Find the affected contract in [[packages/durable/api/graphql/SPEC.md]].
   Examine the pinned upstream interface and implementation. Update the contract
   if the intended behavior changes.
2. Change the handwritten declarations, descriptions, and resolvers. Generate
   the schema again. Examine the SDL diff for changes to names, nullability,
   input variants, and public fields. Do not edit generated files.
3. Add regression tests through the executable schema. Use the test interfaces
   in [[packages/durable/api/graphql/ARCHITECTURE.md#Tests]].
4. For new modules or dependencies, examine these files:
   - [Grats configuration](tsconfig.grats.json).
   - [TypeScript configuration](../tsconfig.build.json).
   - [Package exports, tests, and coverage](../package.json).
   - [Nix inputs and installation](../default.nix).
5. Update [[packages/durable/api/graphql/ARCHITECTURE.md]] if the architecture
   changes.

For storage-error changes, inject failures at reads, commits, and ID allocation.
Examine the failure source, not only the exception class. For public
projections, use fixtures that contain secrets. Examine decoded selections and
schema fields for secret exposure. Do not reduce coverage thresholds or exclude
new production code.

## Verification

Run commands from the repository root. The [package build](../default.nix)
installs pinned dependencies and applies the upstream patch. It runs the package
checks and validates the installed package:

```sh
nix build .#durable-api --no-link -L
```

For local checks, first make the package dependencies and Nix-provided compiler
available. Then run:

```sh
npm --prefix packages/durable/api run build:graphql
npm --prefix packages/durable/api run check
node --test packages/durable/api/graphql/graphql.test.ts
npm --prefix packages/durable/api test
```

`npm test` does not select the GraphQL suite. The separate Node command runs
that suite.

Use
[ASD-STE100 Issue 9](https://www.asd-ste100.org/assets/files/ASD-STE100_ISSUE9.pdf)
for prose. Use project and upstream names for technical terms. Keep schema
identifiers and code examples unchanged during prose edits.

For documentation changes, run:

```sh
nix fmt -- packages/durable/api/graphql/*.md
markdownlint-cli2
```

Use [justfile](../../../../justfile) for repository checks. Run long checks in a
task-specific zmx session. Wait for completion. Read the exit status. Report the
commands, results, and checks that did not run.

# API file organization

Apply this order to handwritten, non-test TypeScript files in this directory and
its subdirectories. Tests, test fixtures, and generated files are excluded.

1. Imports.
2. Exports, grouped by topic. Within each topic, place types and interfaces
   first, constants second, and functions last. Include supporting signature
   types and constants needed to initialize exported constants. Schema
   declarations count as exports even without a TypeScript `export` keyword.
3. Helpers, grouped by topic. Place private types and constants before helper
   functions. Order functions by first use: direct helpers of the first exported
   function come first, then those of subsequent exports, then their
   dependencies. Keep overload signatures together. Preserve constant
   initialization dependencies.

Separate groups with blank lines, not comments. Keep captured helpers inside
their lexical scope, below the function's main flow. Within classes, keep state
fields first, public methods next, and private helper methods last. Keep
executable module startup last.

Only comments required by tooling are allowed. Preserve Grats tags and schema
descriptions: they define the generated GraphQL contract. See
[[packages/durable/api/graphql/src/graphql.ts]] and the Grats configuration in
`graphql/tsconfig.grats.json`. Do not edit generated files.

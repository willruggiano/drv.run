# Durable GraphQL API

Start with the contracts, then the implementation choices:

1. [[packages/durable/api/graphql/SPEC.md]] defines the API contracts and
   expected behavior, including target capabilities not yet implemented.
2. [[packages/durable/api/graphql/ARCHITECTURE.md]] defines the target package
   structure, composition boundaries, technology choices, and evaluation model.
3. [[packages/durable/api/graphql/CONTRIBUTING.md]] describes how to change and
   verify the code.

The generated [schema](schema.graphql) describes the implemented Durable
surface. The separate REST/SSE contract is [[packages/durable/api/SPEC.md]].

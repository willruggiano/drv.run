# packages/www

This packages is a _refactor_ of the original packages/app Elm-based frontend.
Goals are described in [[./SPEC.md]].

When contributing code to this package, you SHOULD read [[./CONTRIBUTING.md]]
first.

This package, along with packages/pds, is being evaluated as a replacement for
packages/app. We have not yet decided which to keep.

DO NOT share code between packages/app and packages/{www,pds}. Two of the three
packages will be DELETED once I am happy with whichever one I choose to move
forward with. The ONLY exception to this rule is `packages/durable/harness`,
which provides the frontend agnostic pi-durable coding agent harness.

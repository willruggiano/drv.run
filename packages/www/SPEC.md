# www

## Table of Contents

- Project layout and exhaustive file allowlist
  - Package tree and file responsibilities
  - Exact paths and package boundary; unlisted changes are forbidden
  - Files and responsibilities
  - Generated files, dependency pins, and build-output boundaries
  - Allowlist compliance and prior approval for amendments
- Application scope and requirements
  - Application responsibilities and package boundaries
  - Existing behavior inventory and regression sources
  - Specification authority and contributor-guide applicability
  - Non-goals and external backend dependencies
- Application architecture and state ownership
  - Runtime composition and dependency direction
  - Elm entry points, pages, domain modules, and public interfaces
  - Server observations, editable drafts, and presentation state
  - Shared state, page transitions, and child outcomes
  - Request identities, route generations, and asynchronous ownership
  - TypeScript capability boundaries and export limits
- Routes and application shell
  - Route inventory, typed parameters, and invalid addresses
  - Initial loading, direct links, history, and external navigation
  - Conversation panes, query parameters, fragments, and dialogs
  - Draft retention and navigation with unsaved changes
  - Shared layout, navigation controls, and page-level failure states
- REST API and application integration contracts
  - REST-only integration and required endpoints
  - Required Durable operations and client-side projections
  - Identifiers, payloads, attachments, omission, and null
  - Success responses, transport failures, and operation errors
  - Snapshot observations, reconnects, and terminal events
  - Pagination, query ownership, ordering, and overlapping records
  - Application integration endpoints outside the core Durable surface
  - Server-enforced access policy and client-visible capabilities
- Session, settings, and authorization workflows
  - Landing page, session catalog, creation, naming, and archival
  - Model, thinking level, execution target, and working directory
  - Dependent choices, unavailable values, and directory completion
  - Global settings, defaults, and per-model overrides
  - Single-flight autosave, failure recovery, and guarded navigation
  - Provider authorization, device flows, polling, and logout
- Conversation and execution workflows
  - Observed execution state, connection health, and usage indicators
  - Composer editing, command dispatch, and completion selection
  - File selection, paste, drop, previews, and attachment removal
  - Submission capture, delivery modes, admission, and queued input
  - Uncertain acknowledgements, receipt recovery, and newer edits
  - Queued-input withdrawal, execution abort, inspection, and resume
  - Context inspection, reset, compaction, and completion timing
  - Review workflows and their application integration boundary
- Transcript, history, and file rendering
  - Record projections, streamed answers, tools, and contextual groups
  - Markdown, incomplete content, and plain-text fallback
  - Syntax tokens, source preservation, and obsolete worker results
  - Branch navigation, recursive trees, filtering, and search
  - History pagination, selection, anchors, and export
  - File references, text views, line navigation, and image previews
  - Disclosures, stable node identity, and retained browser state
- Browser capabilities and resource lifecycle
  - Startup flags, adapter installation, and readiness
  - Port contracts, correlation, and explicit failures
  - EventSource ownership, replacement, and cleanup
  - Draft and preference storage, restoration, and storage failure
  - Focus, selection, measurement, scrolling, and viewport changes
  - Custom elements, observers, workers, and exclusive DOM ownership
  - Service workers, asset caching, push permissions, and notification links
  - Page teardown, back-forward-cache restoration, and resource reacquisition
- Interface, safety, and performance requirements
  - Responsive layout, existing styles, icons, and visual parity
  - Keyboard interaction, IME composition, caret offsets, and Unicode
  - Semantic HTML, accessible names, focus order, and status announcements
  - Untrusted text, URL schemes, file content, and download safety
  - Draft privacy, credentials, and private-response caching restrictions
  - Representative workloads, rendering measurements, and bounded caches
- Build, serving, and repository integration
  - Package entry points, static assets, and installed artifact layout
  - Elm and browser dependencies, lockfiles, registry data, and licenses
  - Reproducible Nix builds and package-owned checks
  - HTTP serving, deep-link fallback, headers, and asset-version transitions
  - Server composition, Harness ownership, and shutdown responsibilities
  - Development commands, test discovery, and CI integration
- Verification and acceptance criteria
  - Behavior-to-suite ownership and preserved regression coverage
  - Elm domain, transition, decoder, encoder, and route tests
  - Browser-adapter tests through public capability boundaries
  - Chromium tests for interaction, rendering, and browser lifecycle
  - HTTP/SSE integration against the real REST API implementation
  - Deterministic fixtures, race schedules, offline execution, and cleanup
  - Installed-package checks, optimized builds, and dependency isolation
  - Performance comparisons, safety checks, and accessible interaction
  - Behavioral acceptance and file-allowlist compliance

## Project layout and exhaustive file allowlist

### Package tree and file responsibilities

`packages/www` is a standalone Elm application distributed as static browser
assets. It contains no production HTTP server, Harness factory, execution
engine, or persistence service. It communicates with the backend through REST
and the REST API's SSE observation endpoint.[^layout-rest]

```text
packages/www/
+-- .gitignore               package-local generated output exclusions
+-- CONTRIBUTING.md          Elm conventions; retained, not implementation code
+-- SPEC.md                  application requirements and this allowlist
+-- default.nix              package, checks, browser tests, and benchmark
+-- elm.json                 Elm application and test dependencies
+-- deps.json                pinned Elm dependency hashes
+-- registry.dat             pinned Elm registry
+-- package.json             browser/build/test dependencies and commands
+-- package-lock.json        resolved npm dependencies
+-- tsconfig.json            browser adapter, build, and test type checking
+-- tsconfig.worker.json     service-worker type checking in its own global scope
+-- build.ts                 one asset build shared by Nix, tests, and benchmark
+-- bench.ts                 browser workload and measurement entry point
+-- src/
|   +-- Main.elm             application entry point and page composition
|   +-- Route.elm            typed browser routes and URL construction
|   +-- Id.elm               distinct identifiers and their validation
|   +-- Api.elm              shared HTTP expectations and error representation
|   +-- Api/
|   |   +-- Durable.elm     core REST records, codecs, and requests
|   |   `-- Application.elm application integration records, codecs, and requests
|   +-- Draft.elm            editable input and captured submission state
|   +-- Autosave.elm         editable, pending, and acknowledged save state
|   +-- Composer.elm         reusable input and attachment views
|   +-- Settings.elm         reusable model/target/directory settings fields
|   +-- Transcript.elm       record projections and safe content rendering
|   +-- Tree.elm             ancestry, visible rows, filtering, and selection
|   +-- Syntax.elm           token requests, validation, cache, and rendering
|   +-- Icon.elm             shared Elm icon views
|   `-- Page/
|       +-- Home.elm         catalog and session creation
|       +-- Conversation.elm conversation and its settings/context/tree panes
|       +-- Settings.elm     global settings, authorization, and device preferences
|       `-- File.elm         source and image viewing, including line anchors
+-- browser/
|   +-- main.ts              Elm startup, ports, storage, and DOM capabilities
|   +-- stream.ts            EventSource acquisition and disposal
|   +-- highlight.ts         syntax-library boundary
|   +-- push.ts              service-worker and push browser capabilities
|   `-- worker.ts            service-worker events, public asset cache, notifications
+-- public/                  authored documents, styles, icons, and manifest
`-- tests/                   Elm, Node, and Chromium tests and local fixtures
```

- `Main` owns application-wide state and navigation. Page modules own their TEA
  state; reusable views receive data and caller-supplied messages. There are no
  global `Model`, `Update`, or `View` layers.[^layout-guide]
- `Api.Durable` decodes upstream records, not the old server's presentation
  protocol. `Api.Application` is the separate boundary for catalog, settings,
  authorization, filesystem, review, and notification integrations.
- `Transcript` owns shared message/content rendering used by the transcript and
  context pane. `Syntax` is shared with the file page; `Composer` and `Settings`
  are shared by session creation and conversation views. Helpers with only one
  owner stay with that owner.
- Browser adapters expose capabilities, not application controllers. Elm owns
  navigation decisions, draft transitions, settings state, and interaction
  policy. Each TypeScript module has at most three exports; no production export
  exists solely for tests.
- The production dependency direction is `www -> REST service`. Browser code
  does not import `packages/app`, either Durable package, or their Node
  dependencies. Tests may use the public `durable-api` entry point and pinned
  upstream Durable/faux-provider APIs; they may not import another package's
  private modules or test fixtures.[^layout-api-entry]
- The page and capability boundaries come from the existing conversation, site,
  file, and browser entry points. Their behavior is evidence, not a requirement
  to preserve their implementation or internal protocol.[^layout-existing]

### Exact paths and package boundary; unlisted changes are forbidden

- The table below is the complete implementation file allowlist. All paths are
  repository-relative and contained in `packages/www`. Each path names one file,
  not a directory, glob, prefix, or permission to add siblings.
- Listed files may be created or modified within their stated responsibilities,
  regardless of whether they already exist. The list describes the required end
  state, not separate creation and editing permissions.
- No edits outside `packages/www` are authorized. Root build orchestration,
  other packages, backend services, and deployment configuration remain outside
  this specification's edit scope.
- Directory names in the tree explain organization; they grant no write
  permission. Imports, citations, test failures, formatter output, and generated
  dependency changes do not expand the allowlist.
- `packages/www/CONTRIBUTING.md` and this specification remain in the package,
  but are not authorized implementation edits. Amendments require explicit
  approval; implementation must not edit its own permissions.
- Existing frontend code may inform the new files without authorizing changes to
  its sources or callers. Preserve applicable license notices. Existing server
  adapters and their consumers are not disposable browser
  assets.[^layout-callers]
- Missing backend capabilities remain external dependencies; they must not be
  replaced by client-side persistence or execution logic.
- Only the generated-output locations defined below are exempt from the source
  file allowlist. They cannot contain new handwritten source or become a route
  for committing unlisted files.

### Files and responsibilities

| File                                           | Required responsibility                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/www/.gitignore`                      | Package-local exclusions for generated output.                                                                                       |
| `packages/www/default.nix`                     | Static asset package, pinned dependencies, package-owned checks, browser tests, and rendering benchmark; no production Node server.  |
| `packages/www/elm.json`                        | Elm application and test dependencies used by the listed modules.                                                                    |
| `packages/www/deps.json`                       | Hashes matching the pinned Elm dependency closure.                                                                                   |
| `packages/www/registry.dat`                    | Pinned Elm registry consistent with that closure.                                                                                    |
| `packages/www/src/Main.elm`                    | Application entry point, route dispatch, shared state, page composition, and port declarations.                                      |
| `packages/www/src/Route.elm`                   | Browser routes, parsing, construction, query parameters, and fragments.                                                              |
| `packages/www/src/Id.elm`                      | Distinct session, conversation, entry, submission, and request identifiers; validation and boundary conversion.                      |
| `packages/www/src/Api.elm`                     | Shared HTTP response classification, structured problems, transport failures, and decoder failures.                                  |
| `packages/www/src/Api/Durable.elm`             | Core REST types, request construction, response decoding, pagination, and SSE payload decoding.                                      |
| `packages/www/src/Api/Application.elm`         | Typed client contracts for application integrations outside the core Durable surface; no server implementation.                      |
| `packages/www/src/Draft.elm`                   | Draft edits, attachment identity, submitted captures, acknowledgement correlation, and restoration decoding.                         |
| `packages/www/src/Autosave.elm`                | Shared single-flight save transitions and acknowledged baselines.                                                                    |
| `packages/www/src/Composer.elm`                | Shared composer and attachment views; no separate application controller.                                                            |
| `packages/www/src/Settings.elm`                | Shared editable model, thinking, target, and directory values, validation, and views.                                                |
| `packages/www/src/Transcript.elm`              | Transcript projections, message/tool rendering, supported Markdown, safe references, and search text.                                |
| `packages/www/src/Tree.elm`                    | Conversation/entry ancestry, visible tree rows, filtering, search, selection, and tree views.                                        |
| `packages/www/src/Syntax.elm`                  | Language selection, correlated token requests, source-preserving validation, bounded cache, and token views.                         |
| `packages/www/src/Icon.elm`                    | Shared icon views without behavior or mutable state.                                                                                 |
| `packages/www/src/Page/Home.elm`               | Session catalog, creation inputs, attachments, and creation outcomes.                                                                |
| `packages/www/src/Page/Conversation.elm`       | Conversation observations, composer, execution controls, review, and conversation-owned panes and dialogs.                           |
| `packages/www/src/Page/Settings.elm`           | Global settings, provider authorization, device preferences, and notification controls.                                              |
| `packages/www/src/Page/File.elm`               | Text/image file presentation, syntax requests, line selection, and anchors.                                                          |
| `packages/www/browser/main.ts`                 | Initialize Elm; install port handlers; provide storage, identity generation, selection, measurement, and DOM lifecycle capabilities. |
| `packages/www/browser/stream.ts`               | Own EventSource instances and correlate callbacks with their captured observation owner.                                             |
| `packages/www/browser/highlight.ts`            | Convert syntax-library results into source-preserving token payloads.                                                                |
| `packages/www/browser/push.ts`                 | Service-worker registration, notification permission, and browser push subscription capabilities; controls remain in Elm.            |
| `packages/www/browser/worker.ts`               | Public asset caching, worker lifecycle, push display, and validated notification navigation.                                         |
| `packages/www/public/index.html`               | Static document shell loading the Elm bundle, browser bootstrap, styles, and manifest.                                               |
| `packages/www/public/styles.css`               | Shared application styles and responsive layout.                                                                                     |
| `packages/www/public/icon.svg`                 | Application vector icon.                                                                                                             |
| `packages/www/public/icon-192.png`             | Small install/notification icon.                                                                                                     |
| `packages/www/public/icon-512.png`             | Large install icon.                                                                                                                  |
| `packages/www/public/manifest.webmanifest`     | Installable application metadata and icon references.                                                                                |
| `packages/www/package.json`                    | Explicit browser/build/test dependencies and package commands; no frontend dependency on the old npm workspace.                      |
| `packages/www/package-lock.json`               | Resolved versions and integrity data for that manifest.                                                                              |
| `packages/www/tsconfig.json`                   | Strict checking of the bootstrap, adapters, build, benchmark, and tests; excludes worker globals.                                    |
| `packages/www/tsconfig.worker.json`            | Strict checking of the service worker with worker-specific globals.                                                                  |
| `packages/www/build.ts`                        | Shared optimized asset build, static asset copying, and dependency-license notices.                                                  |
| `packages/www/bench.ts`                        | Reproducible browser workloads and measurements; not a correctness check or runtime asset.                                           |
| `packages/www/tests/RouteTest.elm`             | Route round trips, invalid routes, query values, and fragments.                                                                      |
| `packages/www/tests/ApiTest.elm`               | Identifier validation and core/application wire contracts, including omission, null, and malformed data.                             |
| `packages/www/tests/DraftTest.elm`             | Draft/submission races, attachment identity, and restoration.                                                                        |
| `packages/www/tests/AutosaveTest.elm`          | Save capture, newer edits, acknowledgement, failure, and navigation eligibility.                                                     |
| `packages/www/tests/TranscriptTest.elm`        | Record projections, content rendering, incomplete Markdown, and safe references.                                                     |
| `packages/www/tests/TreeTest.elm`              | Ancestry, incomplete data, ordering, filtering, search, and stable selection.                                                        |
| `packages/www/tests/SyntaxTest.elm`            | Token correlation, source preservation, fallback, and cache ownership.                                                               |
| `packages/www/tests/PageTest.elm`              | Public page transitions and reusable view messages; no test-only exports from `Main`.                                                |
| `packages/www/tests/highlight.test.ts`         | Syntax-library adapter behavior through its production entry point.                                                                  |
| `packages/www/tests/worker.test.ts`            | Service-worker behavior through registered browser event interfaces.                                                                 |
| `packages/www/tests/build.test.ts`             | Built artifact availability, package isolation, and asset-serving compatibility.                                                     |
| `packages/www/tests/conversation.chromium.ts`  | Conversation interaction, real REST/SSE integration, draft races, and observation lifecycle.                                         |
| `packages/www/tests/pages.chromium.ts`         | Catalog, settings, authorization, review, file views, accessibility, and responsive behavior.                                        |
| `packages/www/tests/notifications.chromium.ts` | Browser permissions, subscriptions, worker lifecycle, and notification navigation.                                                   |
| `packages/www/tests/browser-testing.ts`        | Shared Chromium, asset-serving, and cleanup fixture used by the browser suites.                                                      |
| `packages/www/tests/fixtures.ts`               | Minimal deterministic records, public upstream Harness setup, and application-endpoint fixtures.                                     |
| `packages/www/tests/design-system.html`        | Test-only style and layout fixture; not a production page.                                                                           |

The tests own distinct behaviors, not a coverage copy of the old suites. Browser
fixtures exercise the real core REST API. Fixtures for external application
endpoints establish client behavior only; they do not establish that a
deployment implements those endpoints.[^layout-rest]

### Generated files, dependency pins, and build-output boundaries

- `elm.json` and `package.json` are authored manifests. `deps.json`,
  `registry.dat`, and `package-lock.json` are committed dependency inputs;
  regeneration is limited to their explicitly allowlisted paths. No compiler or
  library is selected from an unpinned network lookup during a Nix build.
- `build.ts` writes the following public files to its output directory. The
  normal local directory is `packages/www/dist`; the installed directory is
  `$out/share/www`. The output contains no backend, tests, npm installation,
  TypeScript sources, or Elm source files.

```text
index.html
main.js
client.js
highlight.js
sw.js
styles.css
icon.svg
icon-192.png
icon-512.png
manifest.webmanifest
```

- `main.js` is the optimized Elm output. `client.js` bundles the bootstrap and
  its browser adapters. `highlight.js` is the lazy syntax-library bundle;
  `sw.js` is the service-worker bundle. Required third-party notices accompany
  their corresponding bundles, rather than becoming unlisted source files.
- `packages/www/dist/`, `packages/www/elm-stuff/`, and
  `packages/www/node_modules/` may contain ignored tool-generated artifacts.
  They are not committed source or additional implementation modules.
- Compiler caches, test servers' files, screenshots, and benchmark reports may
  also use explicit temporary directories or Nix build/output directories. Tests
  own cleanup of temporary resources. A report-output argument does not
  authorize overwriting repository source.
- Build intermediates stay in those generated locations. No generated Elm or
  TypeScript client is added under `src/` or `browser/`; no code generation is
  required to consume the REST surface.
- Browser test fixtures and benchmark tooling are available to their Nix check
  or benchmark derivations, not installed into the public asset directory.
  Benchmarks are not flake checks.[^layout-build]

### Allowlist compliance and prior approval for amendments

- Every added or modified repository source file must appear in the table and
  remain within `packages/www`. Include untracked files in the audit; reviewing
  only the tracked diff is insufficient.
- Check the responsibility as well as the path. Permission to adjust a build
  file is not permission to change unrelated dependencies, suppress checks, or
  alter backend behavior.
- If a required file is missing from the allowlist, stop and request approval
  for the exact package-local path and responsibility. Do not create it first,
  hide it in a generated directory, or broaden the list unilaterally.
- Renaming or deleting a listed end-state file requires an approved layout
  amendment. An external integration need does not expand this allowlist beyond
  `packages/www`.
- Specifications and contributor guidance outside this section remain
  applicable; the allowlist limits the edit surface but does not waive tests,
  formatting, type safety, or the required behavior.

[^layout-rest]:
    [[packages/durable/api/SPEC.md]], particularly its core surface, observation
    contract, and separation of application integrations.

[^layout-guide]: [[packages/www/CONTRIBUTING.md]].

[^layout-api-entry]:
    [API package exports](../durable/api/package.json) and
    [public REST API entry point](../durable/api/src/index.ts).

[^layout-existing]:
    Existing [conversation](../app/serve/elm/src/Main.elm),
    [site](../app/serve/elm/src/Site.elm),
    [file](../app/serve/elm/src/FileView.elm), and
    [browser](../app/serve/elm/client.ts) entry points; shared
    [settings views](../app/serve/elm/src/Panel.elm),
    [syntax boundary](../app/serve/elm/src/Syntax.elm), and
    [PWA capabilities](../app/serve/pwa.ts).

[^layout-build]:
    [Current www derivation](default.nix), [Elm manifest](elm.json),
    [package registration](../default.nix), [flake checks](../../flake.nix), and
    existing [asset builder](../app/serve/build.ts).

[^layout-callers]:
    Existing [server](../app/serve/server.ts),
    [conversation endpoints](../app/serve/elm/frontend.ts),
    [site endpoints](../app/serve/elm/pages.ts), and the
    [tape caller of presentation helpers](../app/tape/browser.ts).

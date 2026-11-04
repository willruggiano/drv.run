# Contributing

## Table of Contents

- Program structure and state ownership
  - Choosing `Browser.application`, `Browser.document`, or `Browser.element`
  - Modules around pages and domain types, not Model/Update/View layers
  - Local helpers before shared modules; reuse without component frameworks
  - Page-level TEA composition with `Html.map`, `Cmd.map`, and `Sub.map`
  - Parent-owned shared state and explicit child outcomes
  - Separating server observations, editable drafts, and transient UI state
  - Deriving values instead of maintaining redundant model fields
- Domain modeling with Elm types
  - Records for product types; custom types for alternatives and state machines
  - Loading, empty, available, stale, and failed states without boolean puzzles
  - Distinct identifiers and validated values; wrap early and unwrap late
  - `Maybe` for absence, `Result` for failure, and deliberate defaulting
  - `List`, `Array`, `Dict`, and `Set`: ordering, identity, and comparable keys
  - Recursive types for content and trees; explicit missing-reference handling
  - Numeric limits, units, `Time.Posix`, time zones, and display formatting
- Elm style and module interfaces
  - `elm-format`, type annotations, and declaration layout
  - Descriptive names, qualified imports, and explicit exposing lists
  - Data-last arguments, named configuration records, and readable pipelines
  - Small pure helpers, pattern matching, and `Maybe`/`Result` composition
  - Opaque types, intentional constructor exposure, and minimal public APIs
  - Elm documentation comments, invariants, and call-site examples
- Updates, commands, and subscriptions
  - Messages describing user actions and external outcomes
  - Exhaustive transitions, pure update helpers, and deliberate ignored messages
  - Independent `Cmd.batch` effects versus message- and `Task`-based sequencing
  - Model-driven subscriptions and ownership of ongoing work
  - Request identities and stale results, including same-page revisits
  - Debouncing, polling, and cancellation without timing-dependent correctness
- Typed routing and navigation
  - Route custom types, `Url.Parser`, and encoded URL construction
  - Navigation keys, internal/external links, history, and invalid routes
  - Route-owned state: retaining drafts and resetting obsolete page work
  - Query parameters, fragments, deep links, and navigation-sensitive UI state
- JSON and HTTP boundaries
  - Decode external values once; keep `Json.Decode.Value` at the boundary
  - Composing record, tagged-union, and recursive decoders
  - Distinguishing missing, null, malformed, and unknown data
  - Explicit encoders, omitted fields, and wire/domain representation choices
  - Typed HTTP requests, encoded parameters, and opaque pagination cursors
  - Success bodies, problem responses, transport failures, and decode failures
- Observations and asynchronous operation state
  - Connection state versus observed execution state
  - Replacing observations without discarding local presentation state
  - Observation ownership, reconnects, terminal events, and obsolete callbacks
  - Paginated history: ordering, deduplication, query identity, and refresh
  - Pending, acknowledged, rejected, and uncertain mutation outcomes
  - Correlating acknowledgements without assuming observation arrival order
- Forms, drafts, and files
  - Raw editable fields versus parsed submission values
  - Controlled inputs, field errors, dependent choices, and unavailable values
  - Capturing submitted drafts without overwriting subsequent edits
  - Single-flight autosave, acknowledged baselines, and guarded navigation
  - Draft restoration, storage failures, and non-restorable file handles
  - `File.Select`, `File.decoder`, file-reading tasks, previews, and downloads
- View composition and interaction
  - Plain `Html msg` functions with caller-supplied messages
  - Narrow view arguments and configuration records, not whole application
    models
  - Unwrapping state at view boundaries and composing conditional content
  - Semantic HTML, labels, ARIA state, and accessible loading/error feedback
  - Event decoders, default prevention, propagation, and keyboard scope
  - IME composition, caret offsets, Unicode, and completion selection
  - Focus, dialogs, disclosures, and native DOM state versus Elm-owned state
- Rendering transcripts and structured content
  - Pure projections from records into messages, tools, and contextual groups
  - Recursive tree views, filtering, search, and selection by stable identity
  - Markdown and incomplete streamed text without raw HTML injection
  - Safe link/image construction and file references with line anchors
  - Syntax-token rendering, source preservation, and plain-text fallback
- Browser interoperability
  - Prefer Elm package APIs; reserve ports for missing browser capabilities
  - Startup flags, explicit decoding, and recoverable initialization failures
  - Narrow port protocols with typed Elm messages and explicit failures
  - Asynchronous port replies, correlation, and startup subscription timing
  - Custom elements, attributes/properties, and exclusive DOM ownership
  - Focus, measurement, selection, and scroll effects after DOM updates
  - Resource cleanup on navigation, disconnect, and browser page restoration
- Virtual DOM performance
  - Profiling Elm updates, projections, and rendering before optimizing
  - `Html.Keyed`: stable sibling keys, node identity, and retained browser state
  - `Html.Lazy`: stable functions, reference equality, and narrow dependencies
  - Avoiding repeated traversal, quadratic list building, and unbounded UI
    caches
- Elm testing and development feedback
  - Testing public Elm interfaces without exposing internals solely for tests
  - Deterministic transition sequences and asynchronous race regressions
  - Decoder/encoder and route contracts, malformed inputs, and fuzz properties
  - `Test.Html.Query` and `Test.Html.Event` for view structure and messages
  - Opaque `Cmd`/`Sub` boundaries and browser tests for actual effects
  - Elm compiler feedback, `elm-test`, and formatting validation
  - Dependency compatibility and optimized builds without `Debug` calls
- Elm references and applicability
  - Official Elm documentation and Elm Guide
  - Package design guidelines
  - Elm Patterns and Elm patterns skill
  - elm/package.elm-lang.org
  - rtfeldman/elm-spa-example
  - Example-project version caveats and pinned Elm package APIs

## Program structure and state ownership

**Importance:** Prevents the rewrite from reproducing the existing large
coordinators or importing a component framework’s architecture into Elm.

**Position:** Comes first because state ownership and module boundaries frame
every subsequent decision.

**Overlap:** Owns where state and behavior live, while domain modeling owns
their representation and updates own their transitions.

**Grounding:** The
[official structure guidance](https://guide.elm-lang.org/webapps/structure)
supports page-oriented TEA and data-oriented modules; the server/client
ownership boundary is a project decision recorded in [[packages/www/SPEC.md]].

### Choosing `Browser.application`, `Browser.document`, or `Browser.element`

### Modules around pages and domain types, not Model/Update/View layers

### Local helpers before shared modules; reuse without component frameworks

### Page-level TEA composition with `Html.map`, `Cmd.map`, and `Sub.map`

### Parent-owned shared state and explicit child outcomes

### Separating server observations, editable drafts, and transient UI state

### Deriving values instead of maintaining redundant model fields

## Domain modeling with Elm types

**Importance:** Makes invalid combinations harder to construct and distinguishes
identifiers, absence, failure, and operation states.

**Position:** Follows structure and precedes interface style and update
mechanics because those depend on the chosen types.

**Overlap:** Establishes modeling principles that the observations and forms
sections apply rather than explain again.

**Grounding:** [Custom types](https://guide.elm-lang.org/types/custom_types),
[Elm Patterns](https://sporto.github.io/elm-patterns/), and version-matched core
package sources provide the foundation, but concrete application types require
explicit justification.

### Records for product types; custom types for alternatives and state machines

### Loading, empty, available, stale, and failed states without boolean puzzles

### Distinct identifiers and validated values; wrap early and unwrap late

### `Maybe` for absence, `Result` for failure, and deliberate defaulting

### `List`, `Array`, `Dict`, and `Set`: ordering, identity, and comparable keys

### Recursive types for content and trees; explicit missing-reference handling

### Numeric limits, units, `Time.Posix`, time zones, and display formatting

## Elm style and module interfaces

**Importance:** Establishes consistent call sites, imports, signatures, and
module interfaces.

**Position:** Follows structure and domain modeling because those explain what
the interfaces represent.

**Overlap:** Leaves module decomposition to program structure and type
invariants to domain modeling; this section owns how those interfaces are
expressed.

**Grounding:** The
[design guidelines](https://package.elm-lang.org/help/design-guidelines) and
[documentation format](https://package.elm-lang.org/help/documentation-format)
support the guidance, while exact naming and exposure conventions remain
explicit project choices.

### `elm-format`, type annotations, and declaration layout

### Descriptive names, qualified imports, and explicit exposing lists

### Data-last arguments, named configuration records, and readable pipelines

### Small pure helpers, pattern matching, and `Maybe`/`Result` composition

### Opaque types, intentional constructor exposure, and minimal public APIs

### Elm documentation comments, invariants, and call-site examples

## Updates, commands, and subscriptions

**Importance:** Explains how pure state transitions interact with asynchronous
effects without relying on accidental execution order.

**Position:** Follows structure, modeling, and interfaces and precedes routing
and network-specific applications.

**Overlap:** Owns general sequencing, correlation, and cancellation rules;
observations and forms cover their domain-specific consequences.

**Grounding:** [Commands and subscriptions](https://guide.elm-lang.org/effects/)
and pinned
[`Platform.Cmd`](https://github.com/elm/core/blob/1.0.5/src/Platform/Cmd.elm)
establish semantics, while stale-result strategies also need explicit invariants
and regression tests.

### Messages describing user actions and external outcomes

### Exhaustive transitions, pure update helpers, and deliberate ignored messages

### Independent `Cmd.batch` effects versus message- and `Task`-based sequencing

### Model-driven subscriptions and ownership of ongoing work

### Request identities and stale results, including same-page revisits

### Debouncing, polling, and cancellation without timing-dependent correctness

## Typed routing and navigation

**Importance:** Gives page identity, browser history, and retained state a
consistent typed interpretation.

**Position:** Provides an early concrete application of state ownership and
effects before network data handling.

**Overlap:** Owns route transitions and history; forms own whether a draft
permits departure, and browser interoperability owns unsupported browser
mechanics.

**Grounding:** [Navigation](https://guide.elm-lang.org/webapps/navigation),
[URL parsing](https://guide.elm-lang.org/webapps/url_parsing), and the inspected
application examples support the mechanics, while retention policies must come
from project requirements.

### Route custom types, `Url.Parser`, and encoded URL construction

### Navigation keys, internal/external links, history, and invalid routes

### Route-owned state: retaining drafts and resetting obsolete page work

### Query parameters, fragments, deep links, and navigation-sensitive UI state

## JSON and HTTP boundaries

**Importance:** Prevents malformed or ambiguously interpreted external data from
spreading through the Elm model.

**Position:** Precedes observation and mutation handling because those depend on
correctly decoded responses.

**Overlap:** Owns representation and transport classification, not
operation-state transitions or browser-port lifecycle.

**Grounding:** Pinned
[`Json.Decode`](https://github.com/elm/json/blob/1.1.3/src/Json/Decode.elm) and
[`Http`](https://github.com/elm/http/blob/2.0.0/src/Http.elm) support
implementation guidance; wire meanings must reference
[[packages/durable/api/SPEC.md]] rather than be invented here.

### Decode external values once; keep `Json.Decode.Value` at the boundary

### Composing record, tagged-union, and recursive decoders

### Distinguishing missing, null, malformed, and unknown data

### Explicit encoders, omitted fields, and wire/domain representation choices

### Typed HTTP requests, encoded parameters, and opaque pagination cursors

### Success bodies, problem responses, transport failures, and decode failures

## Observations and asynchronous operation state

**Importance:** Keeps connection health, observed execution, and mutation
acknowledgement distinct.

**Position:** Follows boundary decoding and precedes editable drafts, whose
behavior depends on these distinctions.

**Overlap:** Owns Elm modeling of observation and operation lifecycles, leaving
general concurrency mechanics to updates, commands, and subscriptions.

**Grounding:** Generic Elm guidance is insufficient: this section needs
[[packages/durable/api/SPEC.md]], the pinned upstream semantics it cites, and
tests, with Elm sources supporting the implementation mechanisms rather than
defining the protocol.

### Connection state versus observed execution state

### Replacing observations without discarding local presentation state

### Observation ownership, reconnects, terminal events, and obsolete callbacks

### Paginated history: ordering, deduplication, query identity, and refresh

### Pending, acknowledged, rejected, and uncertain mutation outcomes

### Correlating acknowledgements without assuming observation arrival order

## Forms, drafts, and files

**Importance:** Protects user edits while submissions, saves, file reads, and
restoration complete asynchronously.

**Position:** Follows operation-state modeling and precedes rendering the
corresponding controls.

**Overlap:** Owns draft and form transitions; view composition owns input events
and accessibility, while browser interoperability owns storage and browser
adapters.

**Grounding:** [Forms](https://guide.elm-lang.org/architecture/forms), pinned
[`elm/file`](https://github.com/elm/file/tree/1.0.5), and existing
[autosave regression tests](../app/serve/elm/tests/AutosaveTest.elm) provide
evidence, but autosave policy is not an Elm language guarantee.

### Raw editable fields versus parsed submission values

### Controlled inputs, field errors, dependent choices, and unavailable values

### Capturing submitted drafts without overwriting subsequent edits

### Single-flight autosave, acknowledged baselines, and guarded navigation

### Draft restoration, storage failures, and non-restorable file handles

### `File.Select`, `File.decoder`, file-reading tasks, previews, and downloads

## View composition and interaction

**Importance:** Keeps views ordinary functions while making event handling and
accessible behavior explicit.

**Position:** Follows state and workflow sections because views should consume
those models rather than dictate them.

**Overlap:** Owns semantic rendering and event intent; browser interoperability
owns imperative DOM effects, and virtual DOM performance owns measured rendering
optimizations.

**Grounding:**
[Reusable views](https://sporto.github.io/elm-patterns/architecture/reusable-views.html)
and pinned
[`Html.Events`](https://github.com/elm/html/blob/1.0.0/src/Html/Events.elm)
ground the Elm guidance; accessibility and IME details still require browser
standards and real-browser tests.

### Plain `Html msg` functions with caller-supplied messages

### Narrow view arguments and configuration records, not whole application models

### Unwrapping state at view boundaries and composing conditional content

### Semantic HTML, labels, ARIA state, and accessible loading/error feedback

### Event decoders, default prevention, propagation, and keyboard scope

### IME composition, caret offsets, Unicode, and completion selection

### Focus, dialogs, disclosures, and native DOM state versus Elm-owned state

## Rendering transcripts and structured content

**Importance:** Covers the transformation from conversation records into safe,
navigable text, code, and trees.

**Position:** Follows general view composition as its application-specific
extension.

**Overlap:** Applies rather than repeats domain modeling’s recursive-type
guidance, boundary decoding rules, and performance advice.

**Grounding:** Existing [transcript](../app/serve/elm/src/Transcript.elm) and
[syntax](../app/serve/elm/src/Syntax.elm) code establish requirements, but
Markdown semantics and URL safety need additional authoritative sources rather
than treating the old implementation as exemplary.

### Pure projections from records into messages, tools, and contextual groups

### Recursive tree views, filtering, search, and selection by stable identity

### Markdown and incomplete streamed text without raw HTML injection

### Safe link/image construction and file references with line anchors

### Syntax-token rendering, source preservation, and plain-text fallback

## Browser interoperability

**Importance:** Defines the narrow escape hatch for capabilities Elm packages do
not expose.

**Position:** Follows Elm-owned behavior so interop is introduced as an
exception rather than the default architecture.

**Overlap:** Centralizes port protocols, DOM ownership, and adapter cleanup;
other sections describe their needs and refer here.

**Grounding:** The official
[interop documentation](https://guide.elm-lang.org/interop/) supports the
boundary, but rendering timing, EventSource behavior, and page restoration still
require pinned runtime sources, browser standards, and tests.

### Prefer Elm package APIs; reserve ports for missing browser capabilities

### Startup flags, explicit decoding, and recoverable initialization failures

### Narrow port protocols with typed Elm messages and explicit failures

### Asynchronous port replies, correlation, and startup subscription timing

### Custom elements, attributes/properties, and exclusive DOM ownership

### Focus, measurement, selection, and scroll effects after DOM updates

### Resource cleanup on navigation, disconnect, and browser page restoration

## Virtual DOM performance

**Importance:** Explains how to keep a growing, frequently updated transcript
responsive without speculative optimization.

**Position:** Follows views and DOM ownership because optimizing either requires
understanding both.

**Overlap:** Owns measured optimization decisions; domain modeling explains
collection semantics and structured-content rendering defines behavior.

**Grounding:** [Lazy rendering](https://guide.elm-lang.org/optimization/lazy),
[keyed rendering](https://guide.elm-lang.org/optimization/keyed), and pinned
virtual-DOM sources ground mechanisms, but performance claims about this
application require measurements.

### Profiling Elm updates, projections, and rendering before optimizing

### `Html.Keyed`: stable sibling keys, node identity, and retained browser state

### `Html.Lazy`: stable functions, reference equality, and narrow dependencies

### Avoiding repeated traversal, quadratic list building, and unbounded UI caches

## Elm testing and development feedback

**Importance:** Establishes how to verify typed boundaries, state transitions,
rendered messages, and effects the compiler cannot prove correct.

**Position:** Comes near the end as the verification counterpart to the
preceding conventions.

**Overlap:** Explains which testing boundary verifies each kind of behavior
rather than restating every section’s invariants.

**Grounding:** Pinned
[`elm-explorations/test`](https://github.com/elm-explorations/test/tree/2.2.1),
compiler behavior, and existing tests support the mechanics, while test-boundary
and export policies are explicit project conventions.

### Testing public Elm interfaces without exposing internals solely for tests

### Deterministic transition sequences and asynchronous race regressions

### Decoder/encoder and route contracts, malformed inputs, and fuzz properties

### `Test.Html.Query` and `Test.Html.Event` for view structure and messages

### Opaque `Cmd`/`Sub` boundaries and browser tests for actual effects

### Elm compiler feedback, `elm-test`, and formatting validation

### Dependency compatibility and optimized builds without `Debug` calls

## Elm references and applicability

**Importance:** Records which sources support the guide and where example code
differs from this project’s dependency versions.

**Position:** Comes last as a compact reference index, with citations also
placed beside the actual guidance.

**Overlap:** Contains provenance and applicability caveats rather than repeating
recommendations from earlier sections.

**Grounding:** This section can be entirely factual by identifying inspected
revisions and manifests, including both examples’ use of Elm 0.19.1 and
`elm/http` 1.0.0 rather than the existing frontend’s versions.

### Official Elm documentation and Elm Guide

[Official documentation](https://elm-lang.org/docs) and the
[Elm Guide](https://guide.elm-lang.org/) provide language and TEA guidance.

### Package design guidelines

[Package design guidelines](https://package.elm-lang.org/help/design-guidelines)
inform module APIs; distinguish library compatibility advice from application
requirements.

### Elm Patterns and Elm patterns skill

[Elm Patterns](https://github.com/sporto/elm-patterns/tree/f0d5c20ec73c45bee85fa10d06be9973f9142f40)
and the
[Elm patterns skill](https://github.com/ricardocasares/skills/tree/2bfd68aac4d844d47c3e6ab226a14de945b0c7ea/skills/elm/elm-patterns)
are pattern catalogs, not requirements to adopt every pattern.

### elm/package.elm-lang.org

Inspected
[revision afe1a128](https://github.com/elm/package.elm-lang.org/tree/afe1a128b4bbf5ec0ebc21886d32b0b473794a9e)
for page composition, shared views, and keyed/lazy rendering.

### rtfeldman/elm-spa-example

Inspected
[revision cb32acd7](https://github.com/rtfeldman/elm-spa-example/tree/cb32acd73c3d346d0064e7923049867d8ce67193)
for typed routes, opaque domain values, and form states.

### Example-project version caveats and pinned Elm package APIs

Both example manifests
([package website](https://github.com/elm/package.elm-lang.org/blob/afe1a128b4bbf5ec0ebc21886d32b0b473794a9e/elm.json),
[SPA example](https://github.com/rtfeldman/elm-spa-example/blob/cb32acd73c3d346d0064e7923049867d8ce67193/elm.json))
declare Elm 0.19.1 and `elm/http` 1.0.0; the
[existing frontend manifest](../app/serve/elm/elm.json) declares Elm 0.19.2 and
`elm/http` 2.0.0, while [www’s manifest](elm.json) does not yet include HTTP.

Citations make guidance auditable, not infallible: distinguish documented Elm
behavior from project conventions, verify API details against pinned sources,
and test application-specific claims.

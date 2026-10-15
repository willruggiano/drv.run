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

- These are project conventions, not a catalog of every possible Elm pattern.
- Examples are focused fragments; domain names illustrate boundaries, not a
  prescribed module tree or wire schema.

### Choosing `Browser.application`, `Browser.document`, or `Browser.element`

- Use `Browser.application` for the routed www application: it supplies the
  current URL, navigation key, and link/history messages.[^browser]
- Use `Browser.document` for a standalone document without client routing; use
  `Browser.element` only for an embedded Elm-owned subtree.

### Modules around pages and domain types, not Model/Update/View layers

```text
Main                application wiring and active page
Page.Conversation   Model, Msg, init, update, view, subscriptions
Draft               draft type and operations, when extraction earns its keep
```

- Keep a page’s TEA functions together; do not create global `Model.elm`,
  `Update.elm`, or `View.elm` layers.[^structure]

### Local helpers before shared modules; reuse without component frameworks

- Start with `viewComposer`, not a composer object with its own lifecycle.
- Extract genuinely identical logic with multiple consumers; similar-looking
  screens may need different types and behavior.[^structure]
- Do not introduce generic effect interpreters, global action buses, phantom
  state machines, or configurable widget builders without demonstrated need.

### Page-level TEA composition with `Html.map`, `Cmd.map`, and `Sub.map`

```elm
updateConversation msg model =
    let
        ( page, command ) =
            Conversation.update msg model.conversation
    in
    ( { model | conversation = page }, Cmd.map ConversationMsg command )


viewConversation model =
    Html.map ConversationMsg (Conversation.view model.conversation)


conversationSubscriptions model =
    Sub.map ConversationMsg (Conversation.subscriptions model.conversation)
```

- Delegate only to the active page; map its subscriptions as well as commands.
- Use nested TEA for substantial page behavior, not every visual
  region.[^patterns]

### Parent-owned shared state and explicit child outcomes

- Keep cross-page state at its owner; pass children only what they need.
- Pass message constructors to reusable views; if a child update must notify its
  parent, return a small domain-specific outcome rather than issuing a fake
  task.

```elm
type Outcome
    = NoOutcome
    | OpenConversation ConversationId



-- Only when the child actually needs to communicate an outcome:
-- update : Msg -> Model -> ( Model, Cmd Msg, Outcome )
```

### Separating server observations, editable drafts, and transient UI state

```text
server observations   conversation, entries, execution, configuration
editable state        draft text/files, settings edits, submitted revision
presentation state    selection, disclosures, search, connection indicator
```

- Elm requests operations and renders observations; it does not implement
  Durable transactions, scheduling, replication, or speculative execution.[^api]
- A received snapshot must not replace an unrelated draft or selection.

### Deriving values instead of maintaining redundant model fields

```elm
attachmentCount draft =
    List.length draft.attachments
```

- Derive counts, selected labels, and visible rows; do not store synchronized
  copies unless profiling justifies a cache with explicit invalidation.
- Pending request captures are historical facts, not redundant copies of edits.

## Domain modeling with Elm types

### Records for product types; custom types for alternatives and state machines

```elm
type alias Draft =
    { text : String, attachments : List Attachment }


type Delivery
    = RejectWhenBusy
    | Steer
    | FollowUp
```

- Use records when fields coexist; use variants when alternatives exclude one
  another, rather than flags or magic strings.[^types]

### Loading, empty, available, stale, and failed states without boolean puzzles

```elm
type Remote error value
    = NotAsked
    | Loading
    | Ready value
    | Refreshing value
    | Failed error (Maybe value)
```

- Introduce only the states the screen needs; `Ready []` is loaded-and-empty,
  not loading, and `Failed error (Just previous)` explicitly retains stale data.
- Do not reuse this read-state type for uncertain mutation outcomes.

### Distinct identifiers and validated values; wrap early and unwrap late

```elm
type ConversationId
    = ConversationId Int


type SubmissionId
    = SubmissionId Int
```

- A `type alias ConversationId = Int` does not prevent mixing IDs.
- Wrap at decoding/parsing boundaries; unwrap for encoding or dictionary keys,
  not throughout application logic; hide constructors that protect validation.

### `Maybe` for absence, `Result` for failure, and deliberate defaulting

- `Maybe Entry` means no entry; `Result Decode.Error Entry` means decoding may
  fail; neither means “construct an empty entry on failure.”[^types]
- Use `map` for transformation, `andThen` for fallible dependent steps, and
  `case` when branches have distinct behavior.
- Defaults must have domain meaning; never turn a malformed ID into `0`.

### `List`, `Array`, `Dict`, and `Set`: ordering, identity, and comparable keys

- `List`: ordered traversal; `Array`: indexed access; `Dict`: keyed lookup;
  `Set`: membership; choose for actual operations, not JavaScript habit.[^core]
- Custom types are not `comparable` dictionary/set keys; unwrap keys inside the
  owning module, retaining distinct ID types in its public API.
- `Dict.values` is key-ordered, not insertion-ordered; retain explicit order
  when the server’s sequence differs, and check duplicates before `fromList`.

### Recursive types for content and trees; explicit missing-reference handling

```elm
type Tree a
    = Node a (List (Tree a))
```

- Use custom types for recursion and `Decode.lazy` for recursive decoders.
- For parent-ID graphs, establish complete ancestry or represent incomplete
  pagination; reject cycles/duplicates rather than recursing indefinitely.
- Do not silently drop missing parents and present an invented complete tree.

### Numeric limits, units, `Time.Posix`, time zones, and display formatting

```elm
safeIdDecoder : Decoder Int
safeIdDecoder =
    Decode.int
        |> Decode.andThen
            (\value ->
                if value >= 0 && value <= 9007199254740991 then
                    Decode.succeed value

                else
                    Decode.fail "Expected a nonnegative safe-integer ID"
            )
```

- Wrap the validated value in its domain ID constructor; `Decode.int` alone does
  not enforce the API’s nonnegative safe-integer range.[^api][^json]
- Elm only guarantees ordinary `Int` arithmetic in the signed 32-bit range;
  never use `//`, bitwise operations, or arithmetic to manipulate IDs.[^core]
- Store instants as `Time.Posix` and format with an explicit `Time.Zone`;
  distinguish milliseconds, seconds, durations, and currency at
  boundaries.[^time]
- Keep numeric values until rendering; a localized timestamp is not model data.

## Elm style and module interfaces

### `elm-format`, type annotations, and declaration layout

- Let `elm-format` determine layout; annotate every top-level production value.
- Keep TEA declarations and related helpers together, with short Elm comment
  separators where useful; split complex functions before inventing modules.
- Examples omit some imports/annotations for focus; production code does not.

### Descriptive names, qualified imports, and explicit exposing lists

```elm
import Draft
import Html exposing (Html, button, text)
import Html.Attributes as Attr
import Json.Decode as Decode exposing (Decoder)
```

- Prefer `Draft.submit`, not `Draft.submitDraft`; expose names deliberately,
  never `exposing (..)` for an entire module.[^design]
- Use descriptive domain names and standard short names such as `Model`, `Msg`,
  `init`, `update`, and `view`; avoid unexplained abbreviations.

### Data-last arguments, named configuration records, and readable pipelines

```elm
remove : String -> Dict String draft -> Dict String draft
remove key drafts =
    Dict.remove key drafts


isSameRevision : { sent : Int, current : Int } -> Bool
isSameRevision revisions =
    revisions.sent == revisions.current
```

- Put the transformed data last; use a named record when same-typed positional
  arguments are easy to swap, not a long sequence of boolean flags.[^design]

### Small pure helpers, pattern matching, and `Maybe`/`Result` composition

```elm
selectedEntry selected entries =
    selected |> Maybe.andThen (\key -> Dict.get key entries)
```

- Extract a named helper when it clarifies a decision; do not build a custom
  pipeline abstraction merely to avoid a `let` or `case`.
- Prefer explicit arguments to dense point-free expressions with hidden intent.

### Opaque types, intentional constructor exposure, and minimal public APIs

```elm
module Draft exposing (Draft, edit, empty, text)

-- Only this module constructs or updates the representation.


type Draft
    = Draft { text : String, revision : Int }
```

- Hide representation when operations must preserve invariants; expose variants
  when consumers intentionally exhaustively match them.[^design]
- Transparent records remain appropriate for plain data/configuration; do not
  wrap every record or add accessors solely for ceremony.

### Elm documentation comments, invariants, and call-site examples

```elm
{-| Remove the draft with this key; an absent key leaves the map unchanged.

    remove "conversation-1" Dict.empty == Dict.empty

-}


remove : String -> Dict String draft -> Dict String draft
remove =
    Dict.remove
```

- Document non-obvious invariants, units, and failure behavior at the API; use
  `{-| ... -}` comments and examples rather than restating types.[^doc-format]

## Updates, commands, and subscriptions

### Messages describing user actions and external outcomes

```elm
type Msg
    = DraftEdited String
    | SubmitClicked
    | EntriesReceived RequestKey (Result ApiError (List Entry))
```

- Describe events, not arbitrary setters such as `SetModel (Model -> Model)`.
- Capture request context in the response constructor when starting the request.

### Exhaustive transitions, pure update helpers, and deliberate ignored messages

- Match every meaningful variant; avoid catch-all branches that hide new cases.
- Ignore stale messages intentionally with `( model, Cmd.none )`; surface
  malformed current messages as boundary failures, not silent `NoOp`s.
- Call shared transition helpers rather than recursively calling `update` to
  simulate a sequence of user actions.

### Independent `Cmd.batch` effects versus message- and `Task`-based sequencing

```elm
focusAfterMeasure elementId =
    Browser.Dom.getElement elementId
        |> Task.andThen (\_ -> Browser.Dom.focus elementId)
        |> Task.attempt FocusFinished
```

- `Cmd.batch` has no result-order guarantee; use it only for independent
  effects.
- Chain tasks with `Task.andThen`, or issue the next command when the previous
  response arrives; batching “save” and “navigate” does not sequence them.[^cmd]

### Model-driven subscriptions and ownership of ongoing work

```elm
subscriptions model =
    if model.needsClock then
        Time.every 1000 Tick

    else
        Sub.none
```

- Describe current interest from the model; map only active child subscriptions.
- Removing a subscription does not cancel unrelated commands or JavaScript
  resources; explicitly stop adapter-owned work.[^cmd][^ports-runtime]

### Request identities and stale results, including same-page revisits

```elm
receive request result model =
    if Just request /= model.pendingRead then
        ( model, Cmd.none )

    else
        applyReadResult result model
```

- Match owner, route generation, and request identity, not just URL or page
  type; leaving A, visiting B, then returning to A must invalidate A’s old read.
- A mutation acknowledgement may still belong to a retained off-screen draft;
  route it to that owner instead of discarding all off-screen
  responses.[^draft-tests]

### Debouncing, polling, and cancellation without timing-dependent correctness

- Increment a revision on edits/dismissal; delayed messages carry that revision
  and do nothing if it is no longer current.
- Start the next poll after the prior result, only while the model needs it; do
  not accumulate overlapping requests from an unconditional timer.
- `Http.cancel tracker` saves work but does not prove a mutation failed to
  commit; retain identity checks even when cancellation is
  requested.[^http][^api]

## Typed routing and navigation

### Route custom types, `Url.Parser`, and encoded URL construction

```elm
type Route
    = Home
    | Conversation String Int


routeParser =
    Url.Parser.oneOf
        [ Url.Parser.map Home Url.Parser.top
        , Url.Parser.map Conversation
            (s "sessions" </> string </> s "conversations" </> int)
        ]
```

- Use `Url.Parser exposing ((</>), int, s, string)` here; production routes use
  validated ID parsers rather than accepting every `int`.[^url]
- Centralize parse/build functions; use `Url.Builder` for encoded path segments
  and queries, never concatenate user input into a URL.

### Navigation keys, internal/external links, history, and invalid routes

- Keep the `Nav.Key` supplied by `Browser.application`; do not fabricate it or
  make it optional just to construct production models in tests.[^browser]
- Use `Nav.pushUrl` for navigation, `replaceUrl` for replacement, `Nav.load` for
  leaving the app; handle both initial URLs and `onUrlChange` consistently.
- Render real links with `href`; preserve modified-click behavior and represent
  unknown routes explicitly rather than guessing a conversation from strings.

### Route-owned state: retaining drafts and resetting obsolete page work

```text
owner changes  -> retain keyed drafts; stop old watch; invalidate reads
pane changes  -> retain conversation/draft; replace pane-specific work
fragment only -> retain data; resolve the anchor when its node exists
```

- Give each retained state a stable owner; clear completions/composition when
  their input disappears, and prune disposable caches when owners change.

### Query parameters, fragments, deep links, and navigation-sensitive UI state

- Parse route-significant query/fragment values into types; shareable selection
  belongs in the URL only when back/forward and direct loading should restore
  it.
- Guard app-initiated navigation for unsaved work; browser history traversal
  reports an already changed URL and cannot be treated as a vetoable link click.
- Retain drafts independently of page lifetime; never rely on unload saving.

## JSON and HTTP boundaries

### Decode external values once; keep `Json.Decode.Value` at the boundary

```elm
decodeIncoming raw =
    Decode.decodeValue eventDecoder raw
        |> Result.mapError Decode.errorToString
```

- Convert flags, responses, and port payloads into Elm types before update
  logic; avoid repeated field extraction in views.[^json]
- Retain raw values only for intentionally opaque API content, with a named
  boundary that owns later decoding or safe display.

### Composing record, tagged-union, and recursive decoders

```elm
treeDecoder : Decoder (Tree String)
treeDecoder =
    Decode.map2 Node
        (Decode.field "label" Decode.string)
        (Decode.field "children" (Decode.list (Decode.lazy (\_ -> treeDecoder))))
```

- Use `mapN` for independent fields; decode a tag then `andThen` to select its
  payload decoder; use explicit record lambdas when positional fields are easy
  to swap, and do not invent a generic codec framework.[^json]

### Distinguishing missing, null, malformed, and unknown data

```elm
optionalField : String -> Decoder a -> Decoder (Maybe a)
optionalField name decoder =
    Decode.keyValuePairs Decode.value
        |> Decode.andThen
            (\fields ->
                if List.any (\( key, _ ) -> key == name) fields then
                    Decode.map Just (Decode.field name decoder)

                else
                    Decode.succeed Nothing
            )
```

- `Decode.maybe` swallows malformed values as well as absence; do not use it
  when an optional-but-present field must validate.[^json]
- `Decode.nullable` accepts explicit null; compose it with presence handling
  only when absent and null both exist in the contract, preserving their
  distinction.
- Ignore permitted extra fields; reject unknown closed-union tags, or retain an
  explicit unknown variant only where the API permits extensible values.

### Explicit encoders, omitted fields, and wire/domain representation choices

```elm
type Change a
    = Keep
    | Clear
    | SetTo a


encodeChange name encode change =
    case change of
        Keep ->
            []

        Clear ->
            [ ( name, Encode.null ) ]

        SetTo value ->
            [ ( name, encode value ) ]
```

- Build objects with `Encode.object`; omit unchanged fields instead of sending
  null, and preserve the API’s numeric/string representations.[^api]
- Keep wire decoding distinct from display projections without duplicating every
  record into an identical second hierarchy.

### Typed HTTP requests, encoded parameters, and opaque pagination cursors

```elm
entriesUrl session conversation cursor =
    Url.Builder.absolute
        [ "api", "s", session, "c", String.fromInt conversation, "entries" ]
        (Url.Builder.int "limit" 100
            :: (case cursor of
                    Nothing ->
                        []

                    Just next ->
                        [ Url.Builder.string "cursor" next ]
               )
        )
```

- Keep request construction and response decoders together at the boundary; pass
  opaque cursors unchanged and encode them once as query values.[^api][^url]

### Success bodies, problem responses, transport failures, and decode failures

- `Http.expectJson` loses non-2xx bodies; use `expectStringResponse` when the
  API supplies structured problems, preserving these separate cases:[^http]

```elm
type ResponseError problem
    = BadAddress String
    | TimedOut
    | NetworkFailure
    | HttpFailure Int (Result Decode.Error problem)
    | InvalidBody Decode.Error


classifyResponse : Decoder value -> Decoder problem -> Http.Response String -> Result (ResponseError problem) value
classifyResponse decodeSuccess decodeProblem response =
    case response of
        Http.BadUrl_ url ->
            Err (BadAddress url)

        Http.Timeout_ ->
            Err TimedOut

        Http.NetworkError_ ->
            Err NetworkFailure

        Http.BadStatus_ metadata body ->
            Err (HttpFailure metadata.statusCode (Decode.decodeString decodeProblem body))

        Http.GoodStatus_ _ body ->
            Decode.decodeString decodeSuccess body |> Result.mapError InvalidBody


expectApi toMsg decodeSuccess decodeProblem =
    Http.expectStringResponse toMsg (classifyResponse decodeSuccess decodeProblem)
```

- Retain status even if the problem body is malformed; validate its declared
  status against HTTP before using the problem details.
- Keep decoder diagnostics distinct from user-facing text; never parse error
  messages for control flow or equate network failure with rejected admission.

## Observations and asynchronous operation state

### Connection state versus observed execution state

```elm
type Connection
    = Connecting
    | Receiving
    | Reconnecting
    | Ended
```

- Connection health says whether observations are fresh, not whether execution
  is busy, stopped, or failed; retain the last observation as explicitly stale.

### Replacing observations without discarding local presentation state

```elm
replaceObservation snapshot model =
    { model | observation = Just snapshot }
```

- The initial API delivers replacement snapshots; do not merge them as deltas or
  retain records omitted from a replacement.[^api]
- Preserve drafts/disclosures separately; validate selected IDs against the new
  view and distinguish paginated history from the watch’s observation window.

### Observation ownership, reconnects, terminal events, and obsolete callbacks

- Bind each stream to an owner and generation; callbacks must capture that
  generation, not read a mutable “current generation” when they fire.
- On replacement/disposal, close the old source; on the API’s terminal event,
  close it to suppress automatic reconnection; reconnect acquires fresh state.
- Disconnect ends observation, not execution; do not attach an abort mutation to
  cleanup or invent sequence numbers/replay state absent from the
  contract.[^api][^sse]

### Paginated history: ordering, deduplication, query identity, and refresh

- Associate each response with owner, filters, ordering, generation, and cursor;
  invalidate the chain when any query-defining input changes.
- Preserve API order, reconcile overlapping IDs explicitly, and stop on absent
  `next`; never infer completeness from a short or empty page alone.[^api]
- Do not claim a multi-request scan is an atomic snapshot without an API
  guarantee.

### Pending, acknowledged, rejected, and uncertain mutation outcomes

```elm
type SubmissionState
    = Idle
    | Pending CapturedSubmission
    | Acknowledged SubmissionId
    | Rejected CapturedSubmission ApiError
    | Uncertain CapturedSubmission
```

- Classify certainty from the operation contract, not merely “HTTP error”; a
  missing response, invalid acknowledgement, or server failure can be uncertain.
- Preserve the original request ID and captured input for receipt recovery;
  absence at lookup time does not prove the original request failed.[^api]

### Correlating acknowledgements without assuming observation arrival order

- Match acknowledgement to owner/request ID before changing pending state.
- Admission is not execution completion; observation may arrive before the
  acknowledgement, and neither ordering licenses clearing newer edits.[^api]
- Do not synthesize authoritative transcript entries or automatically replay
  mutations just because the watch has not caught up.

## Forms, drafts, and files

### Raw editable fields versus parsed submission values

```elm
parseLimit : String -> Result String Int
parseLimit raw =
    case String.toInt raw of
        Just value ->
            if value > 0 then
                Ok value

            else
                Err "Enter a positive number."

        Nothing ->
            Err "Enter a whole number."
```

- Keep raw input editable; parse when needed into a valid submission value,
  retaining the original input and field error on failure.[^patterns]

### Controlled inputs, field errors, dependent choices, and unavailable values

```elm
viewName name edited =
    Html.input [ Attr.value name, Html.Events.onInput edited ] []
```

- Use `value`/`checked` plus corresponding messages; do not rewrite input text
  on every keystroke to force validation or normalization.[^forms]
- Update dependent selections together; preserve an unavailable stored choice
  visibly instead of silently choosing a different model/target.

### Capturing submitted drafts without overwriting subsequent edits

```text
edit          -> advance revision; preserve existing captured submission
submit        -> capture owner, request ID, revision, text, attachment identities
unmatched ack -> ignore
matching ack  -> clear pending; clear draft only if its revision is unchanged
```

- Compare identity and revision, not just text equality; edits can return to the
  same text while changing attachments or submission intent.[^draft-tests]

### Single-flight autosave, acknowledged baselines, and guarded navigation

```text
current != acknowledged, no pending -> capture current; start save
edit while pending                 -> update current only
success                            -> acknowledge captured value; save newer edits
failure                            -> retain current; expose explicit retry
leave                              -> only when no pending and no unsaved changes
```

- A load/save response must not overwrite newer edits; an uncertain save may
  invalidate the baseline even if the user reverted the field.[^autosave]
- Keep workflow-specific save policies explicit; do not create a client
  transaction engine to hide uncertainty.

### Draft restoration, storage failures, and non-restorable file handles

- Decode restored drafts as untrusted input; reject incompatible schemas rather
  than guessing, retaining recoverable text where a deliberate policy allows it.
- Storage is optional: on failure keep in-memory edits and report loss of
  persistence without implying they were saved elsewhere.[^draft-tests]
- Files are not JSON-restorable handles; record that attachments are missing,
  retain uncertain request identity, and require reselection/discard as
  appropriate.

### `File.Select`, `File.decoder`, file-reading tasks, previews, and downloads

```elm
pickFiles =
    File.Select.files [] FilesChosen


preview attachmentId file =
    File.toUrl file |> Task.perform (PreviewReady attachmentId)


exportJson name value =
    File.Download.string name "application/json" (Encode.encode 2 value)
```

- Prefer Elm’s file APIs; decode paste/drop files with `File.decoder` and reject
  preview replies for removed attachments.[^file]
- `File.toUrl` returns a data URL, not a revocable Blob URL; revoke Blob URLs
  only when an adapter actually created them, after their final consumer is
  done.
- Restrict image previews to supported passive formats; metadata is not proof of
  safe content, and previews must not change the submission’s wire encoding.

## View composition and interaction

### Plain `Html msg` functions with caller-supplied messages

```elm
viewRemove : msg -> Html msg
viewRemove onRemove =
    button [ Attr.type_ "button", Html.Events.onClick onRemove ] [ text "Remove" ]
```

- Let the caller own state and supply messages; a view does not need its own
  `Model`, `Msg`, and `update` just to be reusable.[^patterns]

### Narrow view arguments and configuration records, not whole application models

```elm
viewEditor : { text : String, edit : String -> msg, disabled : Bool } -> Html msg
viewEditor config =
    Html.textarea
        [ Attr.value config.text
        , Html.Events.onInput config.edit
        , Attr.disabled config.disabled
        ]
        []
```

- Pass only consumed values; keep configuration explicit rather than providing
  dozens of optional behaviors for hypothetical consumers.

### Unwrapping state at view boundaries and composing conditional content

```elm
viewSelection selected =
    case selected of
        Nothing ->
            text "Select an entry."

        Just entry ->
            viewEntry entry
```

- Unwrap once; children accept an `Entry`, not repeated `Maybe Entry` arguments.
- Use `text ""` for one absent node or `[]` for absent siblings; consider node
  identity before switching between omitted and hidden content.[^patterns]

### Semantic HTML, labels, ARIA state, and accessible loading/error feedback

- Use `button` for actions, `a` for navigation, `form`/`onSubmit` for
  submission, and associated labels for inputs; set button types
  explicitly.[^events]
- Derive `disabled`, `aria-expanded`, and `aria-selected` from the same state as
  their behavior; use `role="alert"` for actionable errors, not every streamed
  token.
- For a listbox-style combobox, keep focus in the input; connect it to the popup
  with `aria-controls`, `aria-expanded`, and `aria-activedescendant` pointing to
  the active option. Arrow keys move selection, Enter accepts, and Escape closes
  without changing input; preserve ordinary text-editing keys.[^combobox]

### Event decoders, default prevention, propagation, and keyboard scope

```elm
escape dismiss =
    Html.Events.preventDefaultOn "keydown"
        (Decode.map2 Tuple.pair
            (Decode.field "key" Decode.string)
            (Decode.field "isComposing" Decode.bool)
            |> Decode.andThen
                (\( key, isComposing ) ->
                    if key == "Escape" && not isComposing then
                        Decode.succeed ( dismiss, True )

                    else
                        Decode.fail "Not handled"
                )
        )
```

- Attach handlers to the narrowest owner; only prevent defaults for handled
  events, and use `Html.Events.custom` when propagation must also stop.[^events]
- Apply composition/modifier/target guards before shortcut dispatch; do not
  intercept ordinary editing keys globally or register competing handlers.

### IME composition, caret offsets, Unicode, and completion selection

- Track composition events and `KeyboardEvent.isComposing`; do not submit,
  choose completions, or dismiss an IME session through application shortcuts.
- Test actual composition sequences; key events are not a complete IME state
  machine, and composition completion can coincide with Enter.[^input-events]
- Browser selection offsets and pinned Elm `String.length`/`slice` use UTF-16
  code units; do not substitute `List.length (String.toList text)` or confuse
  code units with grapheme clusters.[^selection][^string-runtime]
- Apply completion ranges only to their captured text revision; test emoji,
  combining marks, multiline text, and restoring selection after insertion.

### Focus, dialogs, disclosures, and native DOM state versus Elm-owned state

- Choose one owner: either native disclosure state, or Elm-controlled state
  synchronized from `toggle`; do not let both mutate it independently.
- Use real dialogs with `showModal`/`close` through narrow interop when modal;
  setting `open` alone does not establish modality.[^interactive]
- Synchronize close/cancel outcomes into Elm and restore focus appropriately; do
  not steal focus or selection on each observation update.

## Rendering transcripts and structured content

### Pure projections from records into messages, tools, and contextual groups

```elm
viewTranscript records =
    records |> projectRows |> List.map viewRow |> Html.div []
```

- Separate pure record interpretation from rendering and transport; retain
  stable entry/tool identities and distinguish live from completed content.
- Derive labels and groups in Elm; do not require a server-owned display model
  or infer execution state from rendered strings.[^api][^transcript]

### Recursive tree views, filtering, search, and selection by stable identity

- Build validated ancestry from records, then derive visible rows and search
  matches; preserve necessary ancestors when filtering.
- Store selected ID, not list index; recompute its visible position after data
  changes and define the fallback when it disappears.[^transcript]
- Keep DOM reading order meaningful; CSS reordering is not a substitute for an
  accessible tree or transcript order.

### Markdown and incomplete streamed text without raw HTML injection

- Parse only the supported Markdown syntax; render an AST using `Html.text` and
  constructed nodes, never an `innerHTML` property.[^transcript]
- Keep source text authoritative; incomplete fences/links must remain readable
  during streaming and become structured only when parsable.
- Do not claim CommonMark compatibility for a regex subset; use a vetted parser
  when that syntax is required instead of growing ad hoc replacements.

### Safe link/image construction and file references with line anchors

- Distinguish allowed external HTTP(S) URLs from file references; reject active
  schemes and unsupported image formats, including executable SVG/HTML previews.
- Encode file paths as query values; parse line anchors separately, preserve
  filenames containing reserved characters, and avoid double
  encoding.[^transcript]
- Use `rel="noopener noreferrer"` with external new-tab links; render rejected
  references as text rather than fetching them speculatively.

### Syntax-token rendering, source preservation, and plain-text fallback

```elm
validTokens source tokens =
    String.concat (List.map .text tokens) == source
```

- Render token text through `Html.text` and allowlisted token classes;
  tokenization must not alter source bytes or supply arbitrary HTML.[^syntax]
- Correlate results by source/request identity; ignore obsolete replies and keep
  plain text on unsupported languages or tokenization failure.

## Browser interoperability

### Prefer Elm package APIs; reserve ports for missing browser capabilities

- Use `Http`, `Browser.Dom`, `File`, `Time`, and `Url` before writing adapters.
- Reserve interop for capabilities such as EventSource, browser storage, caret
  selection, and tokenization libraries; keep application decisions in
  Elm.[^interop]
- Do not inspect compiler-generated objects or add kernel code as an FFI.

### Startup flags, explicit decoding, and recoverable initialization failures

```elm
init flags =
    case Decode.decodeValue flagsDecoder flags of
        Ok configuration ->
            start configuration

        Err problem ->
            ( StartupFailed (Decode.errorToString problem), Cmd.none )
```

- Use `Program Decode.Value Model Msg` when malformed startup data needs an Elm
  error screen; typed flags can fail before `init` runs.[^interop]
- Decode required configuration strictly; apply defaults only to genuinely
  optional preferences, never request identities or required addresses.

### Narrow port protocols with typed Elm messages and explicit failures

```elm
port requestHighlight : { requestId : Int, source : String } -> Cmd msg


port highlightResult : (Decode.Value -> msg) -> Sub msg
```

- Use capability-specific payloads or a closed tagged protocol; decode incoming
  values into custom types and represent success/failure explicitly.[^interop]
- Keep JS exceptions at the boundary and report failure to Elm; do not replace
  broken interop with an invented successful empty result.

### Asynchronous port replies, correlation, and startup subscription timing

```javascript
const app = Elm.Main.init({ flags });
app.ports.requestHighlight.subscribe(handleHighlight); // Attach immediately.
```

- Ports are messages, not synchronous function calls or return values; include
  request identity and captured ownership in every asynchronous reply.
- Incoming ports deliver only to current subscriptions; install handlers before
  enabling producers, and use an explicit readiness handshake if setup must
  await a dynamic import instead of relying on elapsed time.[^ports-runtime]

### Custom elements, attributes/properties, and exclusive DOM ownership

```elm
viewPreview source =
    Html.node "code-preview" [ Attr.attribute "source" source ] []
```

- Elm owns the element’s placement and declared inputs; the element owns its
  internal DOM; never let both render the same children.[^interop]
- Attributes are strings; use `Attr.property` only for a documented property
  contract, and make setters/lifecycle callbacks safe before or after
  connection.
- Reconnection must not duplicate listeners or assume the element is
  new.[^custom-elements]

### Focus, measurement, selection, and scroll effects after DOM updates

```elm
focusPrompt =
    Browser.Dom.focus "prompt" |> Task.attempt PromptFocused
```

- Handle `Browser.Dom.NotFound` according to context; do not use arbitrary
  sleeps as proof that a node exists, and ignore effects for obsolete
  owners.[^browser-runtime]
- A port command does not acknowledge a DOM paint; adapter measurements must
  explicitly coordinate with rendering and recheck identity after scheduling.
- Auto-follow only while the user remains pinned; preserve manual scroll and
  selected text, and separate layout reads from writes to avoid feedback loops.

### Resource cleanup on navigation, disconnect, and browser page restoration

```text
replace/stop -> close EventSource; cancel timers; invalidate outstanding replies
unmount     -> detach listeners; disconnect observers; release owned Blob URLs
restore     -> reacquire observation under a new generation; preserve drafts
```

- Make cleanup idempotent; unsubscribe port callbacks with the original function
  reference and keep retries owned by exactly one
  lifecycle.[^ports-runtime][^sse]
- `pagehide` may precede back-forward-cache restoration rather than destruction;
  handle `pageshow.persisted` without assuming Elm initialized
  again.[^page-lifecycle]

## Virtual DOM performance

### Profiling Elm updates, projections, and rendering before optimizing

- Measure representative history sizes and streaming/typing interactions in an
  optimized build; separate decoding, projection, virtual-DOM, and layout costs.
- Record before/after measurements; add laziness/caches only for observed work,
  not because the transcript might eventually be large.[^lazy]

### `Html.Keyed`: stable sibling keys, node identity, and retained browser state

```elm
viewRows entries =
    Html.Keyed.node "div"
        []
        (List.map (\entry -> ( Entry.key entry, viewEntry entry )) entries)
```

- Keys must be unique and stable among siblings, not array positions or fresh
  render counters; preserve keys when inserting, removing, or
  reordering.[^keyed]
- Keys do not preserve nodes moved to another parent or changed to another tag;
  test retained focus, selection, and disclosure state in the browser.

### `Html.Lazy`: stable functions, reference equality, and narrow dependencies

```elm
viewHistory entries =
    Html.Lazy.lazy renderEntries entries
```

- Use stable top-level functions and narrow unchanged arguments; fresh lambdas,
  rebuilt records, or `List.map` results defeat reference reuse.[^lazy]
- Freshly decoded equal records are not reference-equal; keyed nodes and lazy
  nodes solve different problems, and neither replaces profiling.

### Avoiding repeated traversal, quadratic list building, and unbounded UI caches

```elm
collect items =
    List.foldl (\item acc -> transform item :: acc) [] items |> List.reverse
```

- Avoid `acc ++ [ item ]` in loops and repeated whole-history scans per row;
  build needed indexes once per projection, not separately in every view helper.
- Scope syntax/search caches to current sources and owners; do not retain every
  historical snapshot or introduce generic memoization without evidence.

## Elm testing and development feedback

### Testing public Elm interfaces without exposing internals solely for tests

- Test production-facing domain operations and rendered behavior; do not export
  private `Main` transitions or weaken opaque types solely to make tests easy.
- A page API may legitimately expose `update` to its parent; test that public
  contract without adding test-only constructors or navigation-key substitutes.

### Deterministic transition sequences and asynchronous race regressions

```text
edit A -> submit A -> edit B -> acknowledge A     => B survives
read A -> navigate B -> return A -> old A result => old result ignored
edit -> request completion -> dismiss -> result => popup stays closed
save A -> edit B -> save succeeds               => B remains dirty until saved
```

- Drive public state operations with explicit messages/results, not sleeps;
  assert observable state and ordering, including failure and stale
  events.[^draft-tests]

### Decoder/encoder and route contracts, malformed inputs, and fuzz properties

```elm
roundTripTest =
    Test.fuzz validIdFuzzer "ID codec preserves valid values" <|
        \id ->
            Id.encode id
                |> Decode.decodeValue Id.decoder
                |> Expect.equal (Ok id)
```

- Pair round trips with independent wire fixtures so matching encoder/decoder
  mistakes cannot pass; cover missing/null/wrong-type and numeric boundaries.
- Fuzz domain invariants and route round trips; retain regression seeds and
  assert decoded values rather than serialized output or source text.[^test]

### `Test.Html.Query` and `Test.Html.Event` for view structure and messages

```elm
removeButtonTest =
    Test.test "remove button emits its caller message" <|
        \_ ->
            viewRemove RemoveClicked
                |> Test.Html.Query.fromHtml
                |> Test.Html.Event.simulate Test.Html.Event.click
                |> Test.Html.Event.expect RemoveClicked
```

- Query semantic elements/attributes and assert emitted messages, disabled
  state, and prevention behavior, not serialized HTML snapshots.[^test]

### Opaque `Cmd`/`Sub` boundaries and browser tests for actual effects

- Do not inspect command internals or compare `Cmd` values for equality; test
  pure decisions at public boundaries and actual effects through integration.
- `Test.Html.Event` simulates decoding, not browser layout/default actions; use
  browser tests for focus, selection, IME, ports, files, and DOM identity.
- Do not introduce an alternate effect runtime solely to inspect commands.

### Elm compiler feedback, `elm-test`, and formatting validation

- Use compiler exhaustiveness/type errors to drive refactoring; run focused Elm
  tests and format validation while changing behavior.[^checks]
- Once www has its test dependencies and tests, run from the repository root:

```sh
(cd packages/www && elm-format src tests --validate)
(cd packages/www && elm-test --seed 1)
(cd packages/www && elm make src/Main.elm --optimize --output=/dev/null)
```

- These are target checks, not claims that the current scaffold has tests; today
  its Nix check phase validates formatting only.[^www-build]

### Dependency compatibility and optimized builds without `Debug` calls

- Use project-pinned compiler/packages; keep `elm.json`, dependency hashes, and
  registry data consistent when dependencies change.[^www-build]
- Remove `Debug.log`, `Debug.toString`, and `Debug.todo` from production; verify
  `elm make --optimize`, not just a development build.[^checks]
- Add dependencies for actual consumers; do not adopt an SPA, UI, codec, or
  effects framework merely because an example application uses one.

## Elm references and applicability

### Official Elm documentation and Elm Guide

- The official documentation index and guide establish TEA, modules, effects,
  interop, and optimization; use pinned package sources for exact APIs.[^guide]
- Apply the concrete conventions above; citations provide evidence and deeper
  explanations, not additional mandatory architecture.

### Package design guidelines

- Apply data-last arguments, readable qualified names, concrete use cases, and
  intentional opacity; do not impose published-library compatibility machinery
  on internal application records.[^design][^doc-format]

### Elm Patterns and Elm patterns skill

- Use the inspected catalogs for custom types, explicit outcomes, and reusable
  views; their optional advanced patterns are not project
  requirements.[^patterns]

### elm/package.elm-lang.org

- At `afe1a128`, `Main` dispatches page messages, `Skeleton` composes shared
  views, and `Page.Search` combines keyed rows with lazy rendering; borrow those
  mechanisms, not its broad exposing lists or old HTTP syntax.[^package-example]

### rtfeldman/elm-spa-example

- At `cb32acd7`, `Route`, `Username`, and `Page.Article.Editor` demonstrate
  typed routing, opaque values, and explicit editing states; do not copy
  fragment routing, authentication policy, or stale-response handling
  uncritically.[^spa-example]

### Example-project version caveats and pinned Elm package APIs

- Both examples declare Elm 0.19.1 and `elm/http` 1.0.0; the existing frontend
  uses Elm 0.19.2 and `elm/http` 2.0.0, where requests return `Cmd msg` rather
  than the old `Http.Request`/`Http.send`
  interface.[^package-example][^spa-example][^http]
- www currently declares only core, HTML, JSON, and virtual DOM; browser, HTTP,
  file, URL, time, and testing APIs above require explicit dependencies when
  used.
- Match APIs to the manifests and pinned sources; citations do not prove a
  project-specific invariant or replace tests and measurements.[^manifests]

[^browser]:
    [elm/browser 1.0.2: program types](https://github.com/elm/browser/blob/1.0.2/src/Browser.elm)
    and
    [navigation](https://github.com/elm/browser/blob/1.0.2/src/Browser/Navigation.elm).

[^structure]:
    Elm Guide: [modules](https://guide.elm-lang.org/webapps/modules) and
    [application structure](https://guide.elm-lang.org/webapps/structure).

[^patterns]:
    [Elm Patterns, f0d5c20e](https://github.com/sporto/elm-patterns/tree/f0d5c20ec73c45bee85fa10d06be9973f9142f40/src)
    and
    [Elm patterns skill, 2bfd68aa](https://github.com/ricardocasares/skills/tree/2bfd68aac4d844d47c3e6ab226a14de945b0c7ea/skills/elm/elm-patterns).

[^api]:
    [[packages/www/SPEC.md]] and [[packages/durable/api/SPEC.md]] define client
    ownership and the planned API contract; they are not evidence of a completed
    implementation.

[^types]:
    Elm Guide: [custom types](https://guide.elm-lang.org/types/custom_types) and
    [error handling](https://guide.elm-lang.org/error_handling/).

[^core]:
    [elm/core 1.0.5: types, arithmetic, and comparability](https://github.com/elm/core/blob/1.0.5/src/Basics.elm)
    and
    [collection implementations](https://github.com/elm/core/tree/1.0.5/src).

[^time]:
    [elm/time 1.0.0: instants, zones, and display](https://github.com/elm/time/blob/1.0.0/README.md).

[^design]:
    [Elm package design guidelines](https://package.elm-lang.org/help/design-guidelines).

[^doc-format]:
    [Elm documentation format](https://package.elm-lang.org/help/documentation-format).

[^cmd]:
    [elm/core 1.0.5: Cmd semantics](https://github.com/elm/core/blob/1.0.5/src/Platform/Cmd.elm),
    [Sub](https://github.com/elm/core/blob/1.0.5/src/Platform/Sub.elm), and
    [Task sequencing](https://github.com/elm/core/blob/1.0.5/src/Task.elm).

[^draft-tests]:
    Existing regression evidence:
    [draft/state tests](../app/serve/elm/tests/StateTest.elm) and
    [browser behavior](../app/serve/elm/tests/frontend.chromium.ts); preserve
    outcomes, not obsolete protocol assumptions.

[^http]:
    [elm/http 2.0.0: requests, expectations, errors, and cancellation](https://github.com/elm/http/blob/2.0.0/src/Http.elm).

[^url]:
    [elm/url 1.0.0: Parser](https://github.com/elm/url/blob/1.0.0/src/Url/Parser.elm)
    and [Builder](https://github.com/elm/url/blob/1.0.0/src/Url/Builder.elm).

[^json]:
    [elm/json 1.1.3: Decode](https://github.com/elm/json/blob/1.1.3/src/Json/Decode.elm)
    and
    [numeric decoding implementation](https://github.com/elm/json/blob/1.1.3/src/Elm/Kernel/Json.js).

[^sse]:
    HTML Standard:
    [EventSource processing and close semantics](https://html.spec.whatwg.org/multipage/server-sent-events.html).

[^forms]:
    Elm Guide:
    [forms and raw editable state](https://guide.elm-lang.org/architecture/forms).

[^autosave]:
    Existing [autosave implementation](../app/serve/elm/src/Autosave.elm) and
    [state transition tests](../app/serve/elm/tests/AutosaveTest.elm).

[^file]:
    [elm/file 1.0.5: file representation and reading](https://github.com/elm/file/blob/1.0.5/src/File.elm),
    [selection](https://github.com/elm/file/blob/1.0.5/src/File/Select.elm), and
    [downloads](https://github.com/elm/file/blob/1.0.5/src/File/Download.elm).

[^events]:
    [elm/html 1.0.0: event decoding and prevention](https://github.com/elm/html/blob/1.0.0/src/Html/Events.elm)
    and
    [attributes/properties](https://github.com/elm/html/blob/1.0.0/src/Html/Attributes.elm).

[^combobox]:
    WAI-ARIA Authoring Practices:
    [combobox keyboard and accessibility behavior](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/).

[^input-events]:
    UI Events:
    [composition events and keyboard interaction](https://www.w3.org/TR/uievents/#events-compositionevents).

[^selection]:
    HTML Standard:
    [text-control selection offsets](https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#textFieldSelection).

[^string-runtime]:
    [elm/core 1.0.5: String implementation](https://github.com/elm/core/blob/1.0.5/src/Elm/Kernel/String.js).

[^interactive]:
    HTML Standard:
    [details and dialog behavior](https://html.spec.whatwg.org/multipage/interactive-elements.html).

[^transcript]:
    Existing behavior:
    [transcript rendering](../app/serve/elm/src/Transcript.elm),
    [reference safety tests](../app/serve/elm/tests/TranscriptTest.elm), and
    [tree interaction](../app/serve/tree-view.ts); these are requirements
    evidence, not architectural templates.

[^syntax]:
    Existing [syntax boundary](../app/serve/elm/src/Syntax.elm) and
    [source preservation tests](../app/serve/elm/tests/SyntaxTest.elm).

[^interop]:
    Elm Guide: [flags](https://guide.elm-lang.org/interop/flags),
    [ports](https://guide.elm-lang.org/interop/ports),
    [custom elements](https://guide.elm-lang.org/interop/custom_elements), and
    [interop limits](https://guide.elm-lang.org/interop/limits).

[^ports-runtime]:
    [elm/core 1.0.5: incoming/outgoing port setup and subscriptions](https://github.com/elm/core/blob/1.0.5/src/Elm/Kernel/Platform.js).

[^custom-elements]:
    HTML Standard:
    [custom element lifecycle and DOM ownership constraints](https://html.spec.whatwg.org/multipage/custom-elements.html).

[^browser-runtime]:
    [elm/browser 1.0.2: DOM tasks](https://github.com/elm/browser/blob/1.0.2/src/Browser/Dom.elm)
    and
    [animation/DOM scheduling](https://github.com/elm/browser/blob/1.0.2/src/Elm/Kernel/Browser.js).

[^page-lifecycle]:
    HTML Standard:
    [PageTransitionEvent and persisted restoration](https://html.spec.whatwg.org/multipage/nav-history-apis.html#the-pagetransitionevent-interface).

[^lazy]:
    Elm Guide:
    [Html.Lazy and reference identity](https://guide.elm-lang.org/optimization/lazy).

[^keyed]:
    Elm Guide: [Html.Keyed](https://guide.elm-lang.org/optimization/keyed);
    pinned
    [elm/virtual-dom 1.0.3 implementation](https://github.com/elm/virtual-dom/blob/1.0.3/src/Elm/Kernel/VirtualDom.js).

[^test]:
    [elm-explorations/test 2.2.1: tests and fuzzing](https://github.com/elm-explorations/test/blob/2.2.1/src/Test.elm),
    [HTML queries](https://github.com/elm-explorations/test/blob/2.2.1/src/Test/Html/Query.elm),
    and
    [event simulation](https://github.com/elm-explorations/test/blob/2.2.1/src/Test/Html/Event.elm).

[^checks]:
    Existing [Elm check/test commands](../app/serve/package.json) and
    [Elm optimization guidance](https://guide.elm-lang.org/optimization/asset_size).

[^www-build]:
    [www derivation](default.nix), [dependency hashes](deps.json), and
    [registry cache](registry.dat).

[^guide]:
    [Official Elm documentation](https://elm-lang.org/docs) and
    [Elm Guide](https://guide.elm-lang.org/).

[^package-example]:
    [Package website at afe1a128](https://github.com/elm/package.elm-lang.org/tree/afe1a128b4bbf5ec0ebc21886d32b0b473794a9e):
    inspect `src/frontend/Main.elm`, `Skeleton.elm`, `Page/Search.elm`, and
    `elm.json`.

[^spa-example]:
    [SPA example at cb32acd7](https://github.com/rtfeldman/elm-spa-example/tree/cb32acd73c3d346d0064e7923049867d8ce67193):
    inspect `src/Route.elm`, `Username.elm`, `Page/Article/Editor.elm`, and
    `elm.json`.

[^manifests]:
    [www manifest](elm.json) and
    [existing frontend manifest](../app/serve/elm/elm.json).

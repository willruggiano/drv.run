# www

## Scope and authority

`www` is an Elm application for browsing drv.run instances and persisted
sessions, working in conversations, and managing application settings and linked
accounts. It uses `elm-graphql` for queries and commands, and the existing HTTP
SSE endpoint for live conversation state:

```text
Elm frontend
  GraphQL -> instance inventory, application settings, accounts, push
          -> Durable reads, commands, documents --+
  HTTP SSE -> live conversation state ------------+-> shared Harness owner
```

For Durable resources, both transports address the same persisted sessions and
conversations under the same access policy. Opening a page, reconnecting, or
refreshing a read never creates a session, submits input, or resumes execution.
Leaving a page stops observation, not admitted work.

The [GraphQL schema](../durable/api/graphql/schema.graphql) owns implemented
field contracts; [[packages/durable/api/graphql/SPEC.md]] defines Durable
semantics and the application-service boundary. The watch contract in
[[packages/durable/api/SPEC.md]] owns SSE observations. No other application or
Durable REST endpoint is a dependency. OAuth authorization redirects and
callbacks are provider-protocol exchanges, not alternative application APIs.

This document specifies the target features and UX, not module layout, build
steps, or a claim that every feature is implemented.
[[packages/www/FEATURE_GAPS.md]] records only parity gaps remaining after this
specification is implemented. Specified features are implementation work, not
feature gaps. Unavailable features do not gain local substitutes or fallback
REST calls. The existing SSE API stays unchanged except for bug fixes; new
document and application views use GraphQL reads where that stream has no
coverage. Elm conventions belong to [[packages/www/CONTRIBUTING.md]]. The
reviewed elm-graphql source is identified in [^elm-graphql]; it is not yet a
pinned project dependency.

## Instance inventory

List accessible drv.run instances through GraphQL. Each row shows the instance
identity, flake reference when available, and the observed systemd
`ActiveState`, `SubState`, and `Result`. Preserve the distinction between
starting, running, stopping, inactive, and failed states; a successful previous
result does not mean the instance is currently running. Unavailable status is
not an inactive instance.

An instance identifies a host's `drv.run@%i.service`, not a Durable session or
conversation. Do not infer a session link from matching identifiers. Retained
stopped instances remain visible; an instance still starting must not disappear
merely because it has not yet written its retained metadata. Missing metadata
stays unavailable rather than being fabricated.

Show loading, empty, partial, failed, and stale reads distinctly. Refresh is
read-only and keeps useful prior rows visible during failure. Listing never
starts or connects to a guest. There are no instance lifecycle controls in this
iteration.

Sources: [host inventory](../../nixosModules/host/command.sh),
[host control](../../nixosModules/host/cli.sh), and
[[packages/durable/api/graphql/SPEC.md#Application services]].

## Sessions and navigation

The home page lists accessible persisted sessions. Each row identifies the
session by its service-provided session key and opens its conversation list.
Loading, an empty catalog, a failed read, and explicitly denied access have
distinct states. Refresh retries the read without creating anything.

The current catalog has no session name, creation time, or designated root. Do
not label the first conversation “Main,” sort sessions by invented activity, or
redirect a session link to a guessed root. Conversation labels use their native
identities unless a supported contract supplies a name. An empty session shows
“No conversations,” not a creation form.

| Address                                                | User-visible destination                 |
| ------------------------------------------------------ | ---------------------------------------- |
| `/`                                                    | Session catalog                          |
| `/instances`                                           | Instance inventory                       |
| `/settings`                                            | Application settings, accounts, and push |
| `/sessions/{sessionId}`                                | Conversations in that session            |
| `/sessions/{sessionId}/conversations/{conversationId}` | Conversation transcript and composer     |

Deep links, reload, and browser Back/Forward reach the same addressed resource.
Invalid or unavailable addresses show a scoped error and a home link; they do
not open another conversation. GraphQL global identities and native conversation
identities are not interchangeable. Session keys are not assumed to be UUIDs.

On a conversation, `?q={text}` initializes search and `#entry-{entryId}` selects
an entry. An unloaded anchor is distinguished from an absent entry. Settings,
context, navigation, reset, and compaction panels do not replace the
conversation or discard its composer. Normal external links retain browser
navigation, modifier-click, and new-tab behavior.

Catalog and conversation-list reads use GraphQL. Listings offer loading,
refresh, and retry; paginated lists expose whether more results remain. A failed
page leaves existing results visible and marked incomplete. Listings do not
claim a transactionally consistent view while the service changes.

Sources:
[GraphQL catalog and record contracts](../durable/api/graphql/schema.graphql),
existing [site](../app/serve/elm/src/Site.elm) and
[conversation navigation](../app/serve/elm/src/Main.elm).

## Live conversation

The conversation page contains a transcript, compact execution/usage status,
queued submissions, and a composer. Configuration and inspection are secondary
panels. Preserve the existing stacked layout and compact tool/code treatment.

SSE supplies the active conversation, active entries, and built-in documents.
GraphQL supplies history and explicit reads; a history response must not replace
live progress. Active context is not complete history. [^watch]

Connection health and execution state are independent:

- Before the first valid snapshot, show that live state is loading. A connection
  opening alone is not evidence of current state.
- During interruption, retain useful content marked stale. Do not turn a lost
  connection into “Idle,” “Completed,” or “Aborted.”
- Reconnection shows a fresh snapshot, not replay of every missed event. Refresh
  history and relevant read panels without duplicating entries or tool output.
- A terminal stream event ends observation and offers explicit reconnect.
  Invalid or mismatched data leaves the last valid view stale and shows an
  error.
- A stream-open failure may expose only a connection error. Do not fabricate an
  HTTP status or diagnostic that EventSource did not provide.
- Updates from an old page or connection cannot alter the current page.
  Returning after browser suspension refreshes observations before declaring
  them current.

Show streamed text and thinking, tool progress, retry/deferred-provider notices,
compaction, and queued input when reported. Missing information stays unknown;
absence of a rendered tool result is not proof that a tool succeeded.

The usage bar distinguishes this conversation's recorded spend, last-response
usage, and model context capacity. Use reported token/cache/cost values; do not
count inherited transcript entries again as this conversation's spend. Catalog
prices are not accumulated cost. Missing capacity, usage, or effective policy is
shown as unavailable, not zero. [^observations]

## Composer and attachments

The composer preserves whitespace and supports multiline editing. Empty or
whitespace-only input without attachments cannot be sent. Enter inserts a
newline; Ctrl/Meta+Enter sends using the selected delivery mode. Alt+Enter uses
the alternate steering/follow-up mode. IME confirmation never sends input or
invokes a command.

Offer follow-up and steering delivery with their upstream meanings, plus reject
when busy. Explain that steering is admitted for a boundary, not an immediate
interruption. A server-side busy race produces a visible rejection, not a
silently changed delivery mode. The initial delivery choice follows the `www`
application setting, defaulting to follow-up. The visible page-local selection
controls subsequent sends; changing it does not silently save an application
setting or alter the Harness's queue policy.

Local file selection, paste, and drag/drop share one attachment list:

- Show filename, size, read progress, preview, removal, and file-specific
  errors.
- Accept PNG, JPEG, GIF, WebP, and valid UTF-8 text without unsupported control
  characters. Unsupported binary files remain rejected rather than misdecoded.
- Preserve text-file contents as text input headed by
  `File: <JSON-quoted filename>`. Images become image input blocks; both can
  accompany text in one submission.
- Preserve attachment order. Removing one attachment does not alter the others.
  Unfinished or failed reads prevent sending an incomplete capture.
- Body-limit failures explain that the submission was too large. Do not invent a
  universal file-size limit or assume the original file size equals encoded
  size.

These are browser-selected files, not guest-file uploads or remote file
references. A filename or `@path` in text does not fetch a file. Application
entry metadata is not automatically model input. [^input]

### Admission and uncertain delivery

Sending captures the current text, attachments, delivery choice, and request
identity. Prevent duplicate sends of that capture while allowing newer editing.
Show pending acknowledgement separately from queued, placed, answered, and
unanswered states. An acknowledged submission is not a completed answer.

Clear the composer only after admission is established and only if it still
contains the captured revision. Acknowledgement or receipt recovery must never
clear newer edits, even when they happen to reproduce the original text.

If acknowledgement is lost, show “Delivery uncertain” and offer a receipt check.
A matching receipt establishes admission; a missing receipt is inconclusive.
Offer bounded check-again and explicit retry, not automatic resend. Retry uses
the original capture and request identity. Sending different input while an
older delivery remains uncertain requires a warning and a separate identity.
[^admission]

Unsubmitted text and attachments remain local to the active page. Navigation to
another page, reload, document exit, and back-forward-cache restoration discard
them; ordinary visibility changes, entry selection, and local panels do not.
There is no offline send queue or draft restoration. Leaving also ends local
receipt recovery, without undoing admitted work. This is an intentional UX
choice, not an API limitation.

### Commands

Buttons remain available without command syntax. Slash commands invoke the same
supported actions, confirmations, and errors:

| Commands              | Action                                                                               |
| --------------------- | ------------------------------------------------------------------------------------ |
| `/sessions`           | Open the session catalog                                                             |
| `/settings`, `/model` | Open conversation configuration                                                      |
| `/search`             | Search history                                                                       |
| `/fork`, `/tree`      | Browse existing conversation branches or transcript ancestry; neither creates a fork |
| `/reset`, `/compact`  | Open the corresponding confirmation                                                  |
| `/stop`, `/resume`    | Stop ordinary owned work or resume Harness scheduling                                |

Command-name completion is local. Arrow Down/Ctrl+J select the next item; Arrow
Up/Ctrl+K select the previous item. Enter/Tab accept, and Escape dismisses;
acceptance preserves surrounding text and restores the caret. Unknown or
unavailable commands show an explanation rather than becoming model input.
Commands never silently consume attachments. Remote path completion and
validated `/cd` behavior are gaps, not implied by a literal cwd editor.

Sources: existing [commands](../app/serve/completions.ts),
[composer](../app/serve/elm/src/Main.elm), and
[input encoding](../app/serve/forms.ts).

## Queue and execution controls

Queue rows show observed submission identity, content, and delivery mode.
Passive writes remain distinguishable from input; they are not displayed as
unanswered user prompts. Disappearing from the queue alone does not establish
successful placement or completion.

Withdrawal acts on the selected submission. Distinguish aborted, already placed,
settled, and not found. A failed withdrawal never silently becomes Stop.

Stop uses the conversation's ordinary abort scope: it can withdraw queued inputs
and stop owned foreground work; it is not a promise to cancel every background
task or queued passive write. Connection loss and navigation do not invoke Stop.

Inspection shows Harness scheduling and interrupted/blocked tasks with available
diagnostics. Persisted task failure is data, distinct from a failed read. Resume
is explicitly Harness-scoped and enables scheduling; it does not resend input or
prove that work completed.

Reset and Compact each require confirmation with optional handoff or
instructions. Opening a dialog has no effect. Pending confirmation disables
duplicate requests. Keep admission, ongoing work, failure, and resulting context
changes distinct. Compaction's returned task identity means admitted work, not a
finished summary. Show duration only from recorded task timing and established
summary placement; request latency is not compaction duration. Reset and
compaction preserve access to earlier transcript history.

Sources: [GraphQL operation semantics](../durable/api/graphql/graphql.ts),
[[packages/durable/api/graphql/SPEC.md]], and existing
[compaction timing](../app/serve/presentation.ts).

## Application settings

Present two application settings panels:

- `www`: code wrapping, bottom alignment, thinking visibility, image visibility,
  and the default follow-up/steering delivery choice.
- Harness: model-provider transport, steering/follow-up batching, retry enabled,
  retry count/delays, automatic compaction, reserved/recent-context tokens, and
  background-compaction threshold.

Read these through `settings(app: web)` and `settings(app: harness)`, selecting
fields from the `WebSettings` or `HarnessSettings` union member. `web` names the
`www` application. Save through the separate `saveWwwSettings` and
`saveHarnessSettings` mutations. The exact fields, enum choices, defaults, and
validation are declared in
[[packages/durable/api/graphql/SPEC.md#Settings schema]] and
[[packages/durable/api/graphql/SPEC.md#Fields and defaults]]. Use checkboxes,
choice controls, and integer fields rather than a generic key/value editor.

Each application owns one configuration file. `www` uses the user's
`$XDG_CONFIG_HOME/www/settings.json`; Harness uses
`$XDG_CONFIG_HOME/harness/settings.json`. There is no XDG configuration
inheritance or device/global/server hierarchy. Notification and OAuth2 account
configuration remain separate. Durable conversation settings live only in
Durable documents and are not application-file fields.

Label Harness values as configuration for subsequent Harness opens, not live
policy inspection. Saving does not hot-reconfigure already-open Harnesses;
reopening uses current Harness configuration without rewriting conversation
documents. `www` saves apply to the current page from the returned settings;
other pages observe them on refresh. Merely visiting a settings page has no
write effect.

Each save submits the complete typed settings object and the revision from its
last read or successful save. A revision conflict preserves edits and offers
reread/reconciliation; do not retry with a new revision without user review.
Autosave distinguishes unsaved, saving, saved, rejected, and uncertain outcomes.
Preserve newer edits when a save completes. Failed saves remain visible and
editable. Application settings are not a browser-local persistence layer;
different browsers accessing the same application's configuration see the same
saved values after refresh. No live settings feed is implied.

Source: [[packages/durable/api/graphql/SPEC.md#Application configuration]].

## Conversation configuration

The conversation configuration panel reads persisted settings and uses the typed
GraphQL `configure` mutation for model, thinking level, and literal working
directory in `pi.agent`. Editing one field preserves the others; this is not
whole-document replacement. It does not save either application's configuration
file. Available models come from the GraphQL catalog; show provider/name,
supported thinking levels, and relevant modality/capacity metadata. An empty
catalog differs from a failed catalog read. Availability does not promise that
generation will succeed.

Keep an existing unavailable model visible rather than replacing it silently.
New selections use available catalog entries and compatible thinking levels.
Refreshing choices must not overwrite newer user edits.

Distinguish stored document values from resolved values read through GraphQL
`agent`. Values used to initialize a conversation do not create a live link to
application defaults. Clearing a field follows Durable's own resolution rules;
it does not reload application configuration. Merely opening the panel does not
rewrite the document. The resolved instructions remain readable, not editable in
this panel.

The cwd field is a literal value in the service-selected environment. Saving it
does not verify directory existence, expand `~`, select a target, or reproduce
the old validated `/cd` command. Explain this beside the field.

Autosave shows dirty, saving, saved, rejected, and uncertain states. Only one
save is pending for the configuration at a time. An acknowledgement advances the
sent baseline without replacing newer edits. Failure preserves editable values;
ambiguous outcomes offer reread/reconciliation and explicit retry, not automatic
replay. A read alone cannot rule out a still-pending write.

Leaving with dirty, pending, or uncertain configuration offers Stay, Save/Retry
where valid, or Discard. Browser history obeys the same guard. External document
exit warns when the browser permits it, without promising recovery. Document
writes do not imply multi-client conflict detection beyond their declared
contract.

Other accessible application documents can be inspected and edited according to
their write permissions and validation. Distinguish an absent document from an
empty object or a failed read. Invalid edits preserve the draft and show the
failure. Changes to documents outside the existing SSE mount require a GraphQL
reread to show current state.

Document access does not add `/review`, `/endreview`, validated `/cd`, or
execution-environment workflow operations. Reading or editing review/environment
data does not promise conversation creation, report transfer, directory
validation, or a successful connection to an execution target.

Sources: [[packages/durable/api/graphql/SPEC.md#Durable documents]],
[existing Agent contracts](../durable/api/graphql/schema.graphql), [^watch], and
existing [autosave behavior](../app/serve/elm/src/Autosave.elm).

## Linked OAuth2 accounts

The accounts view lists configured providers and linked accounts. OpenAI and
GitHub are not a closed provider list: adding another supported OAuth2 provider
must not require a new hard-coded page or provider-specific command vocabulary.
Show account identity when the provider supplies it, granted permissions when
known, and authorization state independently from model availability.

Users can begin authorization, follow the provider's authorization URL or
device-code instructions as appropriate, check progress, reauthorize, and
disconnect an account. Distinguish pending, usable, expired/reauthorization
required, denied, cancelled, and failed outcomes. Leaving a pending flow must
not display success. An unsupported grant or missing client registration is an
explicit configuration problem, not a broken login button.

GraphQL supplies status and commands; provider redirects/callbacks complete the
OAuth exchange. Refresh status after returning from authorization and offer
check-again while a device flow is pending. No OAuth status stream is required.
Disconnect removes local use of the credentials; claim provider-side revocation
only if it was supported and confirmed. Linking a provider account does not
establish login to drv.run itself.

Access tokens, refresh tokens, and client secrets never appear in page state,
GraphQL results, URLs generated by the application, or browser persistence.

Sources: [[packages/durable/api/graphql/SPEC.md#Linked accounts]], and the
existing [provider adapter](../app/serve/auth.ts).

## Push notifications

Users can enable or disable notifications for the current browser, register its
subscription, and reconcile subscription changes through GraphQL. Distinguish
unsupported browser, permission denied, unavailable service, pending
registration, and enabled states. Permission alone is not a registered
subscription. Disabling delivery and browser permission are separate actions.

Notifications can open the addressed conversation. Handle unavailable or
inaccessible destinations without opening a different conversation. Delivery is
best effort: it can be missed or duplicated and is not evidence of execution
success or failure. Do not promise delivery, replay, or recovery of missed
notifications after service restart. Push failures do not affect agent
execution, and delivery does not require an open SSE connection.

Sources: [[packages/durable/api/graphql/SPEC.md#Push subscriptions]], existing
[push integration](../app/serve/pwa.ts), and
[notification service](../app/serve/notifications.ts).

## Transcript, history, and inspection

### Rendering

Keep user, assistant, thinking, tool, reset, and compaction content visually
distinct. A partial answer is replaced by its committed entry exactly once. Tool
calls/results are associated by identity, including nested progress, failures,
truncation notices, patches/diffs, and successful write content. Unmatched
results remain readable instead of disappearing.

Group turns, tools, thinking, and archived context behind disclosures. Streaming
must not collapse user-opened groups, replace completed selections, move
keyboard focus, or reset scrollback. Timestamps respect browser locale and
timezone.

Render paragraphs, line breaks, headings, emphasis, inline code, fenced code,
and safe links. Incomplete Markdown remains readable while streaming. Code
preserves source text; unsupported languages or failed highlighting fall back to
plain text. Unknown application entry kinds remain inspectable without treating
their arbitrary JSON payloads as executable content. [^rendering]

### History and search

History loads incrementally through GraphQL with More, Refresh, progress, and
retry controls. Retain already loaded history across live snapshot replacement;
a reset must not make it disappear from history browsing. Deduplicate inherited
entries by identity and do not infer complete history from the highest observed
entry ID.

Search covers loaded transcript text, including folded groups and tool output.
Show when results are partial and offer further history loading. Selecting a
result reveals its context and stops automatic following. Entry anchors can load
more history before reporting that the entry was not found.

Provide Top, Last user message, and Latest controls. New output scrolls only
while following Latest. Reading earlier content or selecting a search result
keeps the viewport stable until the user explicitly resumes following.

### Context and existing branches

Read-only panels expose current model context and existing conversation
ancestry. Context shows the effective ordered messages separately from raw
history, with entry contributions and context boundaries. A selected historical
entry can scope the context read. Missing or synthesized source relationships
stay explicit; context estimates are not billed usage or a known host compaction
threshold.

Branch navigation shows persisted parent/fork-point and owner relationships,
highlights the current conversation, and opens existing conversations. A
transcript tree shows entry ancestry and the selected conversation's path. It
does not create conversations or forks. Paginated or failed reads remain visibly
incomplete, not a claim that no other branches exist.

These panels are refreshable GraphQL reads, not a Harness-wide event stream. The
active conversation's SSE does not guarantee discovery of changes in other
conversations. Application-specific review relationships come from their
documents, not ordinary ancestry. Current application configuration does not
establish the effective policy of an already-open Harness.

Sources:
[history/context/ancestry fields](../durable/api/graphql/schema.graphql),
existing [trees](../app/serve/trees.ts), [branches](../app/serve/branches.ts),
[context inspection](../app/serve/inspection.ts), and [^rendering].

## Interface behavior

`www` presentation settings include code wrapping, bottom alignment, thinking
visibility, and image visibility. Defaults retain unwrapped code and bottom
alignment. These are application settings, not a separate device-settings
hierarchy. Unsaved presentation changes may remain visible in the current page,
but a failed configuration write must not show “Saved.” These controls affect
presentation, not provider execution.

Preserve the current typography, colors, icons, compact usage bar, and code/tool
treatment. Desktop and narrow/mobile layouts keep navigation, transcript,
panels, and composer usable without page-wide overflow. Mobile keyboard and
viewport changes must not hide the composer or reset following. Long code,
paths, and errors remain selectable and readable.

Use labeled fields, links for navigation, buttons for actions, visible focus,
and meaningful reading order. Disabled, pending, stale, and error states are not
color-only. Dialogs support Escape and predictable focus return; completion
selection is keyboard-accessible. Announce operation and connection outcomes,
not every streamed token. Ordinary editing, copy, and modifier navigation remain
available. Unicode text and caret movement must not corrupt characters.

Sources: existing [styles](../app/serve/styles.css) and
[interaction regressions](../app/serve/elm/tests/frontend.chromium.ts).

## Failure and privacy behavior

A GraphQL result can contain usable data and errors. Keep valid content where
possible and identify the failed area; do not turn partial data into complete
success. Missing objects, empty lists, explicit access denials, malformed
responses, transport failures, and persisted execution failures remain distinct.
When the service deliberately hides an inaccessible resource as absent, do not
claim to know which case occurred. Read retry never implicitly repeats a
mutation. A session failure or disconnected response does not prove that a write
failed to commit. [^admission]

Treat messages, tool output, filenames, metadata, and diagnostics as untrusted
text. No raw HTML execution, active URL schemes, SVG execution, or automatic
remote Markdown-image fetches. Valid embedded raster images and local previews
remain supported. Guest paths/citations stay readable but do not open a remote
file viewer. Safe external links open with isolation from the application page.

No offline mutations, private-response cache, browser credential storage, or
persisted composer captures. Application display settings do not contain
conversation data. No content-bearing analytics or debug logs. Provider
credentials never enter browser settings. UI visibility is not access
enforcement.

Large histories and rapid streaming must leave editing, Stop, navigation,
selection, and scrolling responsive. Failure of optional highlighting or a
settings save must not prevent ordinary conversation use. Neither SSE nor an
open browser page promises background notification delivery.

[^elm-graphql]:
    Reviewed clone at commit
    [`7b7bdc21bcd5e6021e8fd6223f640f97792087c2`](https://github.com/dillonkearns/elm-graphql/tree/7b7bdc21bcd5e6021e8fd6223f640f97792087c2),
    whose Elm manifest declares 5.0.12:
    [selections](https://github.com/dillonkearns/elm-graphql/blob/7b7bdc21bcd5e6021e8fd6223f640f97792087c2/src/Graphql/SelectionSet.elm),
    [HTTP and partial errors](https://github.com/dillonkearns/elm-graphql/blob/7b7bdc21bcd5e6021e8fd6223f640f97792087c2/src/Graphql/Http.elm),
    [omission versus null](https://github.com/dillonkearns/elm-graphql/blob/7b7bdc21bcd5e6021e8fd6223f640f97792087c2/src/Graphql/OptionalArgument.elm),
    and
    [custom scalar codecs](https://github.com/dillonkearns/elm-graphql/blob/7b7bdc21bcd5e6021e8fd6223f640f97792087c2/src/Graphql/Codec.elm).
    Its subscription helpers do not provide this API's non-GraphQL SSE stream.

[^watch]:
    [HTTP SSE implementation](../durable/api/src/stream.ts),
    [[packages/durable/api/SPEC.md]], and pinned Durable 1.4.0
    [ConversationView](/nix/store/57n99acvmwvfw5qjn7ryqzh8gxg5gcj9-app-node-modules-0.1.0/node_modules/@earendil-works/pi-durable/dist/harness/view.d.ts).
    The current protocol sends full replacement snapshots, without deltas, event
    IDs, or replay cursors.

[^observations]:
    Pinned Durable 1.4.0
    [live state](/nix/store/57n99acvmwvfw5qjn7ryqzh8gxg5gcj9-app-node-modules-0.1.0/node_modules/@earendil-works/pi-durable/dist/harness/live.d.ts),
    [usage ledger](/nix/store/57n99acvmwvfw5qjn7ryqzh8gxg5gcj9-app-node-modules-0.1.0/node_modules/@earendil-works/pi-durable/dist/harness/usage.d.ts),
    and existing [presentation](../app/serve/elm/stream.ts).

[^input]:
    [GraphQL submission inputs](../durable/api/graphql/schema.graphql),
    [[packages/durable/api/graphql/SPEC.md#Application data and input content]],
    and existing [file encoding](../app/serve/forms.ts).

[^admission]:
    [[packages/durable/api/graphql/SPEC.md#Execution and observations]],
    [[packages/durable/api/graphql/SPEC.md#Validation and errors]], and
    [submission/receipt resolvers](../durable/api/graphql/graphql.ts).

[^rendering]:
    Existing [transcript](../app/serve/elm/src/Transcript.elm),
    [presentation](../app/serve/elm/stream.ts),
    [syntax behavior](../app/serve/elm/src/Syntax.elm), and
    [rendering regressions](../app/serve/elm/tests/views.chromium.ts).

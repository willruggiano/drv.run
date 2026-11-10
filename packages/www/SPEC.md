# www

## Scope and authority

`www` is an Elm frontend for browsing existing sessions and working in their
conversations. It uses `elm-graphql` for queries, listings, and mutations, and
HTTP SSE for live conversation state. These are two views of the same service,
not separate execution environments:

```text
Elm frontend
  GraphQL -> queries, listings, mutations --+
  HTTP SSE -> live conversation state -----+-> shared Harness owner
```

Both transports address the same persisted sessions and conversations under the
same access policy. Opening a page, reconnecting, or refreshing a read never
creates a session, submits input, or resumes execution. Leaving a page stops
observation, not admitted work.

The [GraphQL schema](../durable/api/graphql/schema.graphql) owns field
contracts; [[packages/durable/api/graphql/SPEC.md]] owns their semantics. The
watch contract in [[packages/durable/api/SPEC.md]] owns SSE observations. No
other REST endpoint, including the old application's endpoints, is a dependency
of this frontend.

This document specifies features and their UX, not module layout, build steps,
or backend changes. [[packages/www/FEATURE_GAPS.md]] records unsupported
existing features and current service-readiness limits. Unavailable features do
not gain local substitutes or fallback REST calls. Elm conventions belong to
[[packages/www/CONTRIBUTING.md]]. The reviewed elm-graphql source is identified
in [^elm-graphql]; it is not yet a pinned project dependency.

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

| Address                                                | User-visible destination             |
| ------------------------------------------------------ | ------------------------------------ |
| `/`                                                    | Session catalog                      |
| `/settings`                                            | Device display preferences           |
| `/sessions/{sessionId}`                                | Conversations in that session        |
| `/sessions/{sessionId}/conversations/{conversationId}` | Conversation transcript and composer |

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
silently changed delivery mode. Without shared defaults, the primary mode is
follow-up; the visible page-local selection controls subsequent sends.

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

## Conversation configuration

The configuration panel edits model, thinking level, and literal working
directory through GraphQL. Available models come from the GraphQL catalog; show
provider/name, supported thinking levels, and relevant modality/capacity
metadata. An empty catalog differs from a failed catalog read. Availability does
not promise that generation will succeed.

Keep an existing unavailable model visible rather than replacing it silently.
New selections use available catalog entries and compatible thinking levels.
Refreshing choices must not overwrite newer user edits.

Distinguish stored overrides, visible through SSE, from resolved values read
through GraphQL `agent`. “Inherit” clears an override; it does not choose a
hard-coded default. Merely opening the panel does not save effective values back
as overrides. The resolved instructions are readable, not editable here.

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
exit warns when the browser permits it, without promising recovery. No
multi-client conflict detection is claimed.

Sources:
[Agent and AgentChange contracts](../durable/api/graphql/schema.graphql),
[^watch], and existing [autosave behavior](../app/serve/elm/src/Autosave.elm).

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
conversations. Application-specific review relationships and effective host
policy are not inferred from ordinary ancestry or stored overrides.

Sources:
[history/context/ancestry fields](../durable/api/graphql/schema.graphql),
existing [trees](../app/serve/trees.ts), [branches](../app/serve/branches.ts),
[context inspection](../app/serve/inspection.ts), and [^rendering].

## Device preferences and interface behavior

Device preferences include code wrapping and bottom alignment, with defaults of
unwrapped code and bottom alignment. They persist only on this device; storage
failure keeps the in-memory choice and reports “Not persisted.” Local thinking
and image visibility controls affect presentation, not provider execution or
shared server settings. No global-save confirmation is shown for a local choice.

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

Sources: existing [browser preferences](../app/serve/elm/client.ts),
[styles](../app/serve/styles.css), and
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

No offline mutations, private-response cache, credential storage, or persisted
composer captures. Device display preferences do not contain conversation data.
No content-bearing analytics or debug logs. Provider credentials never enter
browser settings. UI visibility is not access enforcement.

Large histories and rapid streaming must leave editing, Stop, navigation,
selection, and scrolling responsive. Failure of optional highlighting or device
storage must not prevent ordinary conversation use. Neither SSE nor an open
browser page promises background notification delivery.

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

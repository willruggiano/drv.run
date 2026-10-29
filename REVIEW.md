# Working-copy review

Verdict: **needs attention**.

## Findings

### [P1] Preserve review restrictions when creating child conversations

Location: `packages/app/harness/conversations.ts:269-278`.

With Codemode enabled in a review conversation, `conversation_fork` creates a
child without its parent's review state: `Review` uses `fork: "initial"`
(`packages/app/harness/review.ts:20-30`). The child consequently loses the review
instructions, guidelines and `write`/`edit` path restriction, which all depend on
`Review.original` (`review.ts:39-41,65-80`). It still shares the parent's filesystem.
Delegating review work can therefore modify project files through tools that the
parent cannot use for those paths. A focused runtime probe confirmed the missing
state and instruction section. Preserve the restriction for tool-created children,
or reject forks from review conversations until that behavior is supported.

### [P2] Keep sandbox ownership inside the harness integration

Location: `packages/app/harness/index.ts:24-27`.

The new option makes callers construct the sandbox, opt into the feature and
close the sandbox after the harness. No production caller supplies this option;
only the new tests do. There is no demonstrated production need for sharing or
substituting sandboxes, so the integration exports resource-management obligations
instead of owning its implementation dependency. Create and close the sandbox
inside the harness integration, including cleanup when opening the harness fails.

### [P2] Avoid creating a supervisor for scripts that create no children

Location: `packages/app/harness/conversations.ts:181-187`.

Every Codemode invocation creates a durable scope and guard, even `return 1` or a
script that only calls existing coding tools. Its cleanup then closes the scope,
inspects the whole harness and aborts and joins the guard. This makes unrelated
Codemode execution pay for conversation supervision. If invocation-scoped children
remain a requirement, create their guard only when the first fork needs it; do not
attach that task lifecycle to every script.

### [P2] Check the requested conversation's owner instead of listing every child

Location: `packages/app/harness/conversations.ts:119-125`.

Every operation targeting a child calls `children()`, fetching and allocating the
entire sibling list just to check one ID. Submitting to, waiting for and reading
N children therefore each incurs O(N²) conversation-record reads, with additional
serialized transactions once the list exceeds 256 records. The existing
`Tx.conversation(id)` lookup already returns the record and its `owner.taskId`;
compare that owner directly with `scope.guard`. This removes unnecessary work and
simplifies authorization without adding a cache or another abstraction. The
pinned interface is
`packages/app/node_modules/@earendil-works/pi-durable/dist/types.d.ts:831-837`.

### [P2] Expose the minimal result contracts to Codemode

Location: `packages/app/harness/conversations.ts:141-150`.

The shared wrapper declares every result as `Type.Unknown()`, so Codemode's
catalog and `describeTool()` advertise `Promise<unknown>` even for the context
and history readers. Their descriptions do not explain the result fields either.
The model must guess the `entries`, `items`, entry `id`/`kind`, and `messages`
structures that the hand-written test scripts already know before it can select
a fork point or collect results. Declare the minimal usable output shapes rather
than exposing an undocumented copy of each upstream return value. Codemode derives
these declarations directly from `structuredOutputSchema` in the pinned
`packages/app/node_modules/@earendil-works/pi-durable/dist/codemode/describe.js:28-38`.

## Scope-reduction opportunities

These are additional product choices, not all correctness defects. Remove them
unless the intended conversation-tool contract requires them.

- **Agent administration:** `configure` and fork-time overrides expose model,
  thinking level, instructions and cwd changes, including configuration of the
  calling conversation (`conversations.ts:36-48,267,282-292`).
- **Context administration:** `reset` can discard the caller's active context;
  `compact` starts manual child compaction (`conversations.ts:313-336`).
- **A submission protocol:** input supports images, text signatures, request IDs
  and steer/follow-up/reject behavior, rather than just a text prompt
  (`conversations.ts:49-61,294-310`).
- **Historical navigation:** arbitrary visible fork points, historical context,
  raw entry pagination, range filters and both sort orders are exposed
  (`conversations.ts:213-279`). Keep these if historical traversal is the actual
  use case; they are distinct from simple delegation.
- **Recursive delegation:** children retain conversation tools and can start
  descendants. The recursive tests explicitly exercise this
  (`packages/app/harness/tests/conversations.test.ts:279-376`).
- **A new lifetime contract:** children are usable only within one Codemode call;
  returning or throwing cancels their work, even across background boundaries.
  Implementing this adds a durable scope document, a daily-waking guard task,
  admission checks and a Codemode wrapper (`conversations.ts:22-30,78-130,177-208`).
  Upstream already settles nested tool calls in
  `packages/app/node_modules/@earendil-works/pi-durable/dist/harness/tool.js:510-531`;
  its ordinary ownership cancellation excludes background tasks. Do not remove
  the custom supervisor while still promising its stronger cleanup behavior.

The largest reduction comes from selecting the lifetime and operation contract
first, not replacing these helpers with different abstractions. A one-shot
fork-and-answer operation is a possible smaller contract, but would deliberately
remove interactive child management; it is not an equivalent implementation.

## Verification

- Conversation tests: all 11 passed.
- Harness TypeScript check: passed.
- Focused review-fork state probe: reproduced finding 1.
- Full repository checks were not run.

## Human Reviewer Callouts (Non-Blocking)

- **This change modifies auth/permission behavior:** Codemode scripts gain
  conversation-management capabilities restricted to themselves and children
  owned by the current invocation.

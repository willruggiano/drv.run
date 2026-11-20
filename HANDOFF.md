# drv.run: handoff from Wayfinder to specification

## Next session

The user requested a fresh session to follow `to-spec` after completing
Wayfinder. Work in `/workspace/drv.run`. Produce the implementation
specification for the whole independent-components effort, not an
implementation. The current session only prepared this handoff.

## Source of truth

Project links below are relative to `/workspace/drv.run`.

- Start with [[TASKS.md]], especially Destination, Decisions so far, Handoff,
  and Wayfinding operations. The map and all eleven decision tickets are closed.
- Follow the map's links and read the tickets' **Resolution** sections. They
  hold the accepted contracts; do not substitute earlier proposals or prototype
  behavior from Evidence. Do not repeat the completed requirements interview.
- [[tasks/060-retirement-gates.md]] supplies the verification and acceptance
  boundaries for the specification's testing decisions.
- [[tasks/070-pds-http-contract.md]] governs the requested adaptation of
  [[packages/durable/api/SPEC.md]] into [[packages/pds/SPEC.md]]. Neither
  product specification has been adapted yet. Read the ticket before extracting
  from the old specification; copying it wholesale would contradict accepted
  decisions.
- [[tasks/080-accounts-enrollment.md]] contains the final accepted enrollment
  decisions. No answers remain solely in the conversation.

Keep decisions in their existing artifacts. This handoff intentionally does not
repeat their contents or create a parallel glossary/ADR.

## Suggested skills

Call the Skill tool for **to-spec** if available. Otherwise read and follow:

`/workspace/skills/.agents/skills/to-spec/SKILL.md`

Supporting skills, only when needed:

- **domain-modeling**: terminology discipline. Read its installed `SKILL.md`,
  but retain this project's existing decision/terminology locations; do not
  create parallel glossaries or ADRs.
- **wayfinder**: reference for the completed map and its handoff boundary, not
  an instruction to restart planning.

The installed skill root is `/workspace/skills/.agents/skills`; installation is
project-local to `/workspace/skills`, not global to the drv.run checkout. Do not
assume slash-command discovery in a new session. The installation manifest is
`/workspace/skills/skills-lock.json`.

**to-tickets** is installed for a later, separately approved phase.
**implement-spec** is not installed and is not the next task. Do not generate
implementation tickets or execute code changes as part of this handoff.

## Follow to-spec

1. Read the repository instructions and `justfile`. Inspect the current working
   copy and relevant source before relying on earlier observations.
2. Synthesize the closed decisions rather than conducting another requirements
   interview. Raise a new question only for a concrete contradiction or missing
   consequential decision.
3. Present the proposed high-level test seams for user confirmation, as
   `to-spec` explicitly requires. Use the existing retirement-gate decisions as
   constraints.
4. Write the specification using the installed skill's template. Keep
   publication local, as the project tracker requires; do not create remote
   issues. The exact location of a new overarching specification has not been
   selected. The PDS specification target is already explicit in the
   HTTP-contract ticket.
5. Apply the skill's `ready-for-agent` classification to the new specification,
   not to the closed Wayfinder decision tickets. Classification is not
   permission to begin implementation.

## Working-copy checkpoint

- At handoff: working change `poqyolqq`, commit `f4bbadfc`, no description;
  parent `9e36cb6f`. These are checkpoints, not assumptions about the next
  session's tree. Inspect `jj status`, `jj log -r '@ | @-'`, and
  `jj diff --stat` again.
- The map and decision tickets are additions in that working change. Preserve
  them. `packages/mitm-proxy/package.json` is an unrelated pre-existing
  addition; do not remove or attribute it to this planning work.
- Source-version caveats and remaining verification obligations are recorded in
  [[TASKS.md]]. Do not update, rebase, or discard the working copy merely to
  match a remote revision.
- No product implementation, deployment, migration, code deletion, or disposal
  of live state was performed or authorized by completing the map.

## Verification

The latest tracker check passed for all twelve Markdown files:

```sh
markdownlint-cli2 --no-globs TASKS.md 'tasks/**/*.md'
```

This is documentation validation, not runtime acceptance. No live OAuth,
installed-iPhone push, or deployment acceptance was performed. Follow the
project instructions and retirement ticket for later checks; do not run the
prohibited `nixos-host-basic` check.

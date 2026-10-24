---
name: guest-redeploy
description:
  Import committed work from a drv.run guest, preserve local fixes, verify, and
  redeploy rock5b. Use for "new commits, deploy again".
---

# Guest -> local -> rock5b

Both local and remote must have clean working copies. If either are not clean,
inform the user and ask how to proceed.

## SSH to the guest

Discover the running instance through rock5b:

```sh
ssh -T -F examples/rock5b/.ssh/config rock5b 'drv.run list -u me'
```

Replace `drv.run.ID` below with the selected instance name. If several instances
could apply, ask which one to use. Connect through rock5b as its `me` user, then
inspect only the selected checkout (default: `/workspace/drv.run`):

```sh
ssh -T -F examples/rock5b/.ssh/config rock5b \
  "su --login me --command 'exec ssh -T drv.run.ID bash -s'" <<'GUEST'
cd /workspace/drv.run || exit 1
pwd
jj --ignore-working-copy workspace list
jj --ignore-working-copy status
jj --ignore-working-copy log -n 15
GUEST
```

The quoted heredoc keeps guest commands out of the local and host shells.
`--ignore-working-copy` avoids snapshotting guest edits. Do not switch to
another workspace unless the user requests it.

## Fetch

```sh
jj status
jj log -n 15
jj bookmark list
.agents/skills/guest-redeploy/scripts/guest-fetch.py
```

The helper discovers the only running guest through rock5b and fetches the
committed parent (`@-`) of **`/workspace/drv.run`**, not another workspace's Git
`HEAD`. It supports Git checkouts too (default `HEAD`). Override only when
requested:

```sh
.agents/skills/guest-redeploy/scripts/guest-fetch.py --instance drv.run.ID --workspace /workspace/drv.run
.agents/skills/guest-redeploy/scripts/guest-fetch.py --source BOOKMARK --base KNOWN_IMPORTED_COMMIT
```

It refuses ambiguous sources, pins the source immediately before export, creates
and cleans up a unique guest ref, strips login chatter, verifies the bundle, and
fetches into a unique local `instance-recovery/*` ref. Linked Jujutsu workspaces
are supported. Neither checkout nor destination bookmarks are moved. The bundle
and a JSON receipt (tip, export base, recovery ref) are saved under `.scratch/`.

The default export-base hint is local `@-`. If it is not a guest ancestor, the
helper transfers full history instead. **An export base is not necessarily the
last imported commit after cherry-picks or rewrites:** inspect both histories
before integrating. Do not duplicate previously imported work. If multiple
guests, parents, or possible destinations exist, ask rather than guess.

## Integrate

Use the current local checkout unless the user names a destination. Identify its
unambiguous branch/bookmark; never assume it matches the guest source. A
detached checkout needs no new bookmark. Preserve existing uncommitted work
before moving an empty working-copy commit.

For an empty working copy whose parent is an ancestor of the fetched tip:

```sh
jj rebase -r @ -d TIP
```

Otherwise, identify the already-imported guest base from both histories and copy
only new commits, preserving local fixes:

```sh
jj duplicate 'GUEST_BASE..TIP' --insert-before @
```

For rewritten history, inspect `git range-diff` and preserve a backup ref first.
Resolve conflicts without dropping local fixes; squash resolutions into the
imported commit. Keep existing messages; use Conventional Commits for new fixes.

## Verify and deploy

1. Run `just check`, Node tests, and the Nix-free tests listed in `justfile`,
   including `python3 -B -m unittest discover -s scripts -p '*_test.py'` and
   `just chromium`. Fix regressions; tolerate failures only when explicitly
   authorized. Formatting can change files even on failure: inspect, commit, and
   rerun.
2. Recheck destination bookmarks before moving the selected one to the verified
   tip; do not undo concurrent user renames or deletions. Remove the recovery
   ref with the expected tip (the helper prints the command). Verify a clean,
   conflict-free working copy.
3. Run `rockctl deploy` with a 24-hour timeout (`86400` seconds). Require exit
   code zero and confirmed activation. Report the tip, checks, and
   `.scratch/rock5b-deploy.log`.

Nix is unavailable in jail: explicitly defer `nix flake check` to the operator;
deployment success does not replace full validation. Do not hide unavailable
checks or bypass them with fake executables.

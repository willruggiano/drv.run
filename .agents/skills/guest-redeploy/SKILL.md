---
name: guest-redeploy
description:
  Import committed work from a drv.run guest, preserve local fixes, verify, and
  redeploy rock5b. Use for "new commits, deploy again".
---

# Guest -> local -> rock5b

Run local commands from the repository root. Import committed work only; never
reset local changes, modify guest uncommitted work, or clean/recreate the
instance.

Use the guest branch, bookmark, commit, or workspace the user names. Otherwise,
use `HEAD` in the selected guest checkout (default: `/workspace/drv.run`). In a
Jujutsu workspace, use `@-` as the default committed tip, not the working-copy
commit `@` or another workspace's Git `HEAD`. Ask if the source is ambiguous,
including multiple working-copy parents.

Unless the user names a local destination, import into the current local
checkout. Use its unambiguous branch/bookmark; ask if several could apply. A
detached checkout needs no new branch unless requested. Never assume the local
destination has the same name as the guest source.

1. Inspect `jj status`, local history, and destination bookmarks. Discover the
   guest: `ssh -T -F examples/rock5b/.ssh/config rock5b 'drv.run list -u me'`.
   Through that host, run
   `su --login me --command 'exec ssh -T drv.run.ID <guest-command>'`. Quote
   each shell layer. Inspect `/workspace/drv.run` and `jj workspace list`, then
   inspect status and history in the selected guest checkout. Resolve the source
   to a full commit ID and identify the already-imported base from both
   histories; do not assume the previous instance, hashes, or ancestry still
   match.
2. Pin the source by re-resolving it and testing equality with `<tip>`
   immediately before export: use `git rev-parse <source>` for Git or
   `jj log -r <source> --no-graph -T commit_id` in the selected Jujutsu
   workspace. For a default Jujutsu source, `<source>` is `@-`. Run Git export
   commands in the workspace's backing Git repository; a linked Jujutsu
   workspace need not have a `.git` directory. Create a uniquely named temporary
   ref at `<tip>` with `git update-ref <export-ref> <tip> <all-zero-old-oid>`
   and install an EXIT trap to delete only that ref, checking its expected
   value. Export with
   `git bundle create - <export-ref> ^<already-imported-base>`; omit the
   exclusion if there is no shared base. Use a ref even for a bare commit ID:
   Git can refuse a hash-only bundle as empty. Never move a guest
   branch/bookmark for export. Guest shell hooks print to stdout: emit a unique
   newline-delimited marker before the bundle, capture bytes, strip the prefix,
   and validate the bundle header. Run `git bundle verify`; fetch the exported
   ref into a unique local `refs/heads/instance-recovery/<id>` ref.
3. With an empty working-copy commit, fast-forward via `jj rebase -r @ -d <tip>`
   when ancestry matches. Otherwise cherry-pick only new commits using
   `jj duplicate '<guest-base>..<tip>' --insert-before @`. For rewritten
   history, inspect `git range-diff` and preserve a backup ref. Resolve
   conflicts without dropping local fixes; squash resolutions into the imported
   commit. Never duplicate previously imported work.
4. Run `just check`, Node tests, and the Nix-free tests listed in `justfile`.
   Fix regressions; tolerate failures only when explicitly authorized.
   Formatting can modify files even when checks fail: inspect, commit, and
   rerun.
5. Move the selected local branch/bookmark, if any, to the verified tip, remove
   the temporary recovery ref, and verify a clean, conflict-free working copy.
   Recheck bookmarks before moving them; do not undo concurrent user renames or
   deletions. Preserve existing commit messages; use Conventional Commits for
   new fixes.
6. Run `rockctl deploy` with a 24-hour timeout (`86400` seconds). Require exit
   code zero and confirmed activation. Report the tip, checks, and
   `.scratch/rock5b-deploy.log`. Nix is unavailable in jail: explicitly defer
   `nix flake check` to the operator; deployment success does not replace full
   validation.

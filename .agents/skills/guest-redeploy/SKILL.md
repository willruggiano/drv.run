---
name: guest-redeploy
description:
  Import committed pi-pwa work from a drv.run guest, preserve local fixes,
  verify, and redeploy rock5b. Use for "new commits, deploy again".
---

# Guest → local → rock5b

Run commands from the repository root. Import committed work only; never reset
local changes, modify guest uncommitted work, or clean/recreate the instance.

1. Inspect `jj status` and local `pi-pwa` history. Discover the guest:
   `ssh -T -F examples/rock5b/.ssh/config rock5b 'drv.run list -u me'`. Through
   that host, run
   `su --login me --command 'exec ssh -T drv.run.ID <guest-command>'`. Quote
   each shell layer. Inspect `/workspace/drv.run` status and history; do not
   assume the previous instance, hashes, or ancestry still match.
2. Pin the guest tip with `test "$(git rev-parse pi-pwa)" = <tip>`, then export
   `git bundle create - pi-pwa ^<last-imported-guest-tip>`. Guest shell hooks
   print to stdout: emit a unique newline-delimited marker before the bundle,
   capture bytes, strip the prefix, and validate the bundle header. Run
   `git bundle verify`; fetch into `instance-recovery/pi-pwa`.
3. With an empty working-copy commit, fast-forward via `jj rebase -r @ -d <tip>`
   when ancestry matches. Otherwise cherry-pick only new commits using
   `jj duplicate '<guest-base>..<tip>' --insert-before @`. For rewritten
   history, inspect `git range-diff` and preserve a backup ref. Resolve
   conflicts without dropping local fixes; squash resolutions into the imported
   commit. Never duplicate previously imported work.
4. Run `just check`, Node tests, and the Nix-free tests listed in `justfile`.
   Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="$(command -v chromium)"`. Missing
   fonts can cause browser crashes and broken cursor positions: set
   `FONTCONFIG_FILE` to temporary fontconfig XML containing a `<dir>` for an
   available DejaVu font directory and a writable `<cachedir>`. Fix regressions;
   tolerate failures only when explicitly authorized. Formatting can modify
   files even when checks fail: inspect, commit, and rerun.
5. Move `pi-pwa` to the verified tip, remove the temporary recovery ref, and
   verify a clean, conflict-free working copy. Preserve existing commit
   messages; use Conventional Commits for new fixes.
6. Run `rockctl deploy` with a 24-hour timeout (`86400` seconds; codemode
   `timeout_ms: 86400000`). Require exit code zero and confirmed activation.
   Report the tip, checks, and `.scratch/rock5b-deploy.log`. Nix is unavailable
   in jail: explicitly defer `nix flake check` to the operator; deployment
   success does not replace full validation.

#!/usr/bin/env bash
set -euo pipefail

old_head=$(git rev-parse HEAD)
cd "$(dirname "${BASH_SOURCE[0]}")/.."

nix-update pi-ask --commit --flake
nix-update pi-autoresearch --commit --flake
nix-update pi-parallel-web --commit --flake '--version-regex=^pi-extension-v([0-9]+\.[0-9]+\.[0-9]+)$'

new_head=$(git rev-parse HEAD)
if [[ $new_head != "$old_head" ]]; then
  revisions="$old_head..$new_head"
  updates=$(jj log -r "$revisions" --count)
  jj new "$new_head" -m "chore(deps): bump the nix group with $updates updates"
  jj squash --from "$revisions" --into @ --config 'ui.editor="true"'
  jj new
fi

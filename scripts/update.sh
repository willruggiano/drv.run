#!/usr/bin/env bash
set -euo pipefail

if [[ $(jj log -r @ --no-graph -T empty) != true ]]; then
  echo 'error: working copy is dirty' >&2
  exit 1
fi

old_head=$(jj log -r @- --no-graph -T commit_id)

nix-update cloud-hypervisor --commit --flake
nix-update subtrace --commit --flake

new_head=$(jj log -r @- --no-graph -T commit_id)
if [[ $new_head != "$old_head" ]]; then
  revisions="$old_head..$new_head & ~empty()"
  updates=$(jj log -r "$revisions" --count)
  jj new "$new_head" -m "chore(deps): bump the nix group with $updates updates"
  jj squash --from "$revisions" --into @ --config 'ui.editor="true"'
  jj new
fi

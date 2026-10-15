# shellcheck shell=bash
set -euo pipefail

image=/nix/.environment
profile=/nix/var/nix/profiles/project
export NIX_REMOTE=local
rm -f /run/drv-run-environment/ready

timing_directory=/run/drv-run-environment
cat /run/drv-run-image-mount-{start,ready}.json >"$timing_directory/timings.jsonl"
@timing@

phase mounts-ready
findmnt --noheadings --evaluate --source LABEL=drv-run-env --types erofs \
  --options ro --mountpoint "$image" >/dev/null
findmnt --noheadings --mountpoint /nix/store >/dev/null
findmnt --noheadings --mountpoint /nix/.ro-store >/dev/null
cmp "$image/environment" /run/drv-run-seed/environment
IFS= read -r environment <"$image/environment"
if [[ $environment != /nix/store/*-env || $environment == *[[:space:]]* ]]; then
  echo 'Error: invalid prepared environment in image' >&2
  exit 1
fi
# Check that base registration succeeded before extending the database.
nix-store --check-validity /run/current-system
if [[ -e $profile || -L $profile ]]; then
  test "$(readlink -e "$profile")" = "$environment"
fi

phase registration-start
# Query metadata only, including existing private-store paths on restart.
nix path-info --all --json --json-format 1 >/run/drv-run-environment/registered.json
jq --exit-status --slurpfile registered /run/drv-run-environment/registered.json \
  --from-file @check-metadata@ "$image/path-info.json" >/dev/null
jq --exit-status --arg environment "$environment" 'has($environment)' "$image/path-info.json" >/dev/null
jq --raw-output 'keys[]' "$image/path-info.json" >/run/drv-run-environment/paths
while IFS= read -r path; do
  # Catch missing entries and overlay whiteouts without reading file contents.
  test -e "$path" || test -L "$path"
done </run/drv-run-environment/paths
nix-store --load-db <"$image/registration"
nix-store --check-validity --stdin </run/drv-run-environment/paths
phase registration-end

phase profile-start
# Bypass daemon activation and auto-GC until the persistent profile is rooted.
nix print-dev-env --offline --option min-free 0 --json --profile "$profile" -- "$environment" >/dev/null
test "$(readlink -e "$profile")" = "$environment"
phase profile-ready
rm /run/drv-run-environment/{registered.json,paths}
cp "$image/environment" /run/drv-run-environment/ready

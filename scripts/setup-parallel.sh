#!/usr/bin/env bash
# Create the SOPS secret used by the Parallel web tools.
set +x
set -euo pipefail
umask 077

if (($# != 0)); then
  printf 'Usage: ./scripts/setup-parallel.sh (no arguments)\n' >&2
  exit 1
fi

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
secret=examples/rock5b/secrets/parallel-api-key
reference=examples/rock5b/secrets/tailscale-auth-key
tmp=
parallel_key=
cleanup() {
  unset parallel_key
  if [[ -n "$tmp" ]]; then rm -f -- "$tmp"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Fall back to Nix when the tools are not installed locally.
sops_cmd=(sops)
jq_cmd=(jq)
for tool in sops jq; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    if ! command -v nix >/dev/null 2>&1; then
      printf 'Install %s or Nix before running this script.\n' "$tool" >&2
      exit 1
    fi
    if [[ "$tool" == sops ]]; then
      sops_cmd=(nix run nixpkgs#sops --)
    else
      jq_cmd=(nix run nixpkgs#jq --)
    fi
  fi
done

recipient=$("${jq_cmd[@]}" -er '
  [.sops.age[].recipient | select(type == "string" and startswith("age1"))]
  | if length > 0 then join(",") else error("No host age recipient found") end
' "$reference")

# Resolve any Nix downloads before requesting the credential.
"${sops_cmd[@]}" --version >/dev/null

if [[ -e "$secret" ]]; then
  printf 'This will replace the existing encrypted Parallel API key.\n' >&2
fi
printf 'Parallel API key: ' >&2
if ! IFS= read -r -s parallel_key && [[ -z "$parallel_key" ]]; then
  printf '\nNo API key received; nothing changed.\n' >&2
  exit 1
fi
printf '\n' >&2
if [[ ! "$parallel_key" =~ [^[:space:]] ]]; then
  printf 'API key must not be empty; nothing changed.\n' >&2
  exit 1
fi

# Only ciphertext touches disk; preserve the old file if encryption fails.
tmp=$(mktemp "${secret}.tmp.XXXXXX")
printf '%s' "$parallel_key" |
  "${sops_cmd[@]}" --encrypt --age "$recipient" \
    --input-type binary --output-type json /dev/stdin >"$tmp"
unset parallel_key
mv -f -- "$tmp" "$secret"
tmp=

# Make the new file visible to flake evaluation in this Jujutsu repository.
if [[ -d .jj ]] && command -v jj >/dev/null 2>&1; then
  jj file track "$secret"
else
  printf 'Ensure %s is tracked by version control before deploying.\n' "$secret"
fi
printf 'Encrypted key saved to %s\nNext: rockctl deploy\n' "$secret"

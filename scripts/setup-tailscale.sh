#!/usr/bin/env bash
# Replace the SOPS-encrypted Tailscale auth key, preserving its age recipients.
set +x
set -euo pipefail
umask 077

if (($# != 0)); then
  printf 'Usage: ./scripts/setup-tailscale.sh (no arguments)\n' >&2
  exit 1
fi

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
secret=examples/rock5b/secrets/tailscale-auth-key
tmp=
auth_key=
cleanup() {
  unset auth_key
  if [[ -n "$tmp" ]]; then rm -f -- "$tmp"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Read public recipient metadata, not the existing plaintext credential.
if [[ ! -f "$secret" || -L "$secret" ]]; then
  printf 'Expected an existing regular file at %s; nothing changed.\n' "$secret" >&2
  exit 1
fi

sops_cmd=(sops)
jq_cmd=(jq)
for tool in sops jq; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    if ! command -v nix >/dev/null 2>&1; then
      printf 'Install %s or Nix before running this script.\n' "$tool" >&2
      exit 1
    fi
    case "$tool" in
    sops) sops_cmd=(nix run --inputs-from . nixpkgs#sops --) ;;
    jq) jq_cmd=(nix run --inputs-from . nixpkgs#jq --) ;;
    esac
  fi
done

recipient=$("${jq_cmd[@]}" -er '
  [.sops.age[].recipient | select(type == "string" and startswith("age1"))]
  | if length > 0 then join(",") else error("No host age recipient found") end
' "$secret")

# Resolve any Nix downloads before requesting the credential.
"${sops_cmd[@]}" --version >/dev/null
printf 'Create an auth key at https://login.tailscale.com/admin/settings/keys (not an API access token).\n' >&2
printf 'This will replace the existing encrypted Tailscale auth key.\n' >&2
printf 'Tailscale auth key: ' >&2
if ! IFS= read -r -s auth_key && [[ -z "$auth_key" ]]; then
  printf '\nNo auth key received; nothing changed.\n' >&2
  exit 1
fi
printf '\n' >&2
if [[ "$auth_key" != tskey-auth-?* || "$auth_key" =~ [[:space:]] ]]; then
  printf 'Expected a nonempty tskey-auth- key without whitespace; nothing changed.\n' >&2
  exit 1
fi

# Only ciphertext touches disk; preserve the old file if encryption fails.
tmp=$(mktemp "${secret}.tmp.XXXXXX")
printf '%s' "$auth_key" |
  "${sops_cmd[@]}" --encrypt --age "$recipient" \
    --input-type binary --output-type json /dev/stdin >"$tmp"
unset auth_key
mv -fT -- "$tmp" "$secret"
tmp=

if [[ -d .jj ]] && command -v jj >/dev/null 2>&1; then
  jj file track "$secret"
else
  printf 'Ensure %s is tracked by version control before deploying.\n' "$secret"
fi
printf 'Encrypted auth key saved to %s\nNext: nix run ./examples/rock5b#deploy\n' "$secret"

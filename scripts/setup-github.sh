#!/usr/bin/env bash
# Create the SOPS secret used by the host-side GitHub Git credential proxy.
set +x
set -euo pipefail
umask 077

if (($# != 0)); then
  printf 'Usage: ./scripts/setup-github.sh (no arguments)\n' >&2
  exit 1
fi

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
secret=examples/rock5b/secrets/github-token
reference=examples/rock5b/secrets/tailscale-auth-key
tmp=
github_token=
cleanup() {
  unset github_token
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
  printf 'This will replace the existing encrypted GitHub token.\n' >&2
fi
printf 'GitHub token: ' >&2
if ! IFS= read -r -s github_token && [[ -z "$github_token" ]]; then
  printf '\nNo token received; nothing changed.\n' >&2
  exit 1
fi
printf '\n' >&2
# Match the proxy credential loader; reject empty tokens and whitespace.
if [[ ! "$github_token" =~ ^[a-zA-Z0-9_]+$ ]]; then
  printf 'Token must contain only ASCII letters, digits, and underscores; nothing changed.\n' >&2
  exit 1
fi

# Only ciphertext touches disk; preserve the old file if encryption fails.
tmp=$(mktemp "${secret}.tmp.XXXXXX")
printf '%s' "$github_token" |
  "${sops_cmd[@]}" --encrypt --age "$recipient" \
    --input-type binary --output-type json /dev/stdin >"$tmp"
unset github_token
mv -f -- "$tmp" "$secret"
tmp=

# Make the new file visible to flake evaluation in this Jujutsu repository.
if [[ -d .jj ]] && command -v jj >/dev/null 2>&1; then
  jj file track "$secret"
else
  printf 'Ensure %s is tracked by version control before deploying.\n' "$secret"
fi
printf 'Encrypted token saved to %s\nNext: rockctl deploy\n' "$secret"

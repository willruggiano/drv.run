#!/usr/bin/env bash
# Create the SOPS-encrypted VAPID private JWK used by Web Push.
set +x
set -euo pipefail
umask 077

if (($# != 0)); then
  printf 'Usage: ./scripts/setup-notifications.sh (no arguments)\n' >&2
  exit 1
fi

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
secret=examples/rock5b/secrets/notifications-vapid
reference=examples/rock5b/secrets/tailscale-auth-key
tmp=
cleanup() {
  if [[ -n "$tmp" ]]; then rm -f -- "$tmp"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Rotating VAPID keys requires devices to subscribe again.
if [[ -e "$secret" || -L "$secret" ]]; then
  printf 'VAPID key already exists; refusing to replace it.\n' >&2
  exit 1
fi

sops_cmd=(sops)
jq_cmd=(jq)
node_cmd=(node)
for tool in sops jq node; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    if ! command -v nix >/dev/null 2>&1; then
      printf 'Install %s or Nix before running this script.\n' "$tool" >&2
      exit 1
    fi
    case "$tool" in
    sops) sops_cmd=(nix run --inputs-from . nixpkgs#sops --) ;;
    jq) jq_cmd=(nix run --inputs-from . nixpkgs#jq --) ;;
    node) node_cmd=(nix run --inputs-from . nixpkgs#nodejs --) ;;
    esac
  fi
done

recipient=$("${jq_cmd[@]}" -er '
  [.sops.age[].recipient | select(type == "string" and startswith("age1"))]
  | if length > 0 then join(",") else error("No host age recipient found") end
' "$reference")

# Resolve tools before generating any private key material.
"${sops_cmd[@]}" --version >/dev/null
"${node_cmd[@]}" --version >/dev/null

tmp=$(mktemp "${secret}.tmp.XXXXXX")
"${node_cmd[@]}" --input-type=module -e '
  import { generateKeyPairSync } from "node:crypto";
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  process.stdout.write(JSON.stringify(privateKey.export({ format: "jwk" })));
' | "${sops_cmd[@]}" --encrypt --age "$recipient" \
  --input-type binary --output-type json /dev/stdin >"$tmp"

# Publish atomically without overwriting a file created while encryption ran.
ln -T -- "$tmp" "$secret"
rm -- "$tmp"
tmp=

if [[ -d .jj ]] && command -v jj >/dev/null 2>&1; then
  jj file track "$secret"
else
  printf 'Ensure %s is tracked by version control before deploying.\n' "$secret"
fi
printf 'Encrypted VAPID key saved to %s\nConfigure the SOPS secret and Web Push options, then deploy. Keep this key stable across deployments.\n' "$secret"

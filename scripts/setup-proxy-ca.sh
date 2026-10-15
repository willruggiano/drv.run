#!/usr/bin/env bash
# Generate the proxy CA, encrypt its private key, and write its public Nix module.
# FIXME: This is stupid. It writes to a file that I do not want. It's 2026 for
# fucks sake! Let's be smart and use `nix eval` to edit the nix code in place :D
set +x
set -euo pipefail
umask 077

if (($# != 0)); then
  printf 'Usage: ./scripts/setup-proxy-ca.sh (no arguments)\n' >&2
  exit 1
fi

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
secret=examples/rock5b/secrets/mitm-proxy-ca-key
module=examples/rock5b/mitm-proxy-ca.nix
reference=examples/rock5b/secrets/tailscale-auth-key
secret_tmp=
module_tmp=
ca_key=
cleanup() {
  unset ca_key
  if [[ -n "$secret_tmp" ]]; then rm -f -- "$secret_tmp"; fi
  if [[ -n "$module_tmp" ]]; then rm -f -- "$module_tmp"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# CA rotation needs a coordinated host and guest deployment, not an overwrite.
if [[ -e "$secret" || -e "$module" ]]; then
  printf 'CA configuration already exists; refusing to replace it.\n' >&2
  exit 1
fi

sops_cmd=(sops)
jq_cmd=(jq)
openssl_cmd=(openssl)
for tool in sops jq openssl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    if ! command -v nix >/dev/null 2>&1; then
      printf 'Install %s or Nix before running this script.\n' "$tool" >&2
      exit 1
    fi
    case "$tool" in
    sops) sops_cmd=(nix run nixpkgs#sops --) ;;
    jq) jq_cmd=(nix run nixpkgs#jq --) ;;
    openssl) openssl_cmd=(nix run nixpkgs#openssl --) ;;
    esac
  fi
done

recipient=$("${jq_cmd[@]}" -er '
  [.sops.age[].recipient | select(type == "string" and startswith("age1"))]
  | if length > 0 then join(",") else error("No host age recipient found") end
' "$reference")
"${sops_cmd[@]}" --version >/dev/null
"${openssl_cmd[@]}" version >/dev/null

# Private key bytes remain in shell memory and pipes, never a plaintext file.
ca_key=$("${openssl_cmd[@]}" genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072)
ca_certificate=$(printf '%s\n' "$ca_key" |
  "${openssl_cmd[@]}" req -new -x509 -key /dev/stdin -sha256 -days 3650 \
    -subj '/CN=drv.run credential proxy CA' \
    -addext 'basicConstraints=critical,CA:TRUE' \
    -addext 'keyUsage=critical,keyCertSign,cRLSign' \
    -addext 'subjectKeyIdentifier=hash')

secret_tmp=$(mktemp "${secret}.tmp.XXXXXX")
printf '%s\n' "$ca_key" |
  "${sops_cmd[@]}" --encrypt --age "$recipient" \
    --input-type binary --output-type json /dev/stdin >"$secret_tmp"
unset ca_key

module_tmp=$(mktemp "${module}.tmp.XXXXXX")
cat >"$module_tmp" <<EOF
{config, ...}: {
  assertions = [
    {
      assertion = !config.sops.useSystemdActivation;
      message = "Proxy CA provisioning requires SOPS activation before guest seed publication.";
    }
  ];
  sops.secrets.mitm-proxy-ca-key = {
    sopsFile = ./secrets/mitm-proxy-ca-key;
    format = "binary";
    mode = "0400";
    restartUnits = ["mitm-proxy.service"];
  };
  system.activationScripts.mitm-proxy.deps = ["setupSecrets"];
  services.drv-run.mitm-proxy = {
    caPrivateKeyFile = config.sops.secrets.mitm-proxy-ca-key.path;
    caCertificate = ''
$(printf '%s\n' "$ca_certificate" | sed 's/^/      /')
    '';
  };
}
EOF

mv -- "$secret_tmp" "$secret"
secret_tmp=
mv -- "$module_tmp" "$module"
module_tmp=

if [[ -d .jj ]] && command -v jj >/dev/null 2>&1; then
  jj file track "$secret" "$module"
else
  printf 'Ensure %s and %s are tracked by version control before deploying.\n' "$secret" "$module"
fi
printf 'Encrypted key: %s\nPublic CA module: %s\nReview both files, then deploy the host and recreate guests to install the new trust root.\n' "$secret" "$module"

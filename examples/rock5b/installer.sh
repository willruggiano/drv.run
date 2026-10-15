#!/usr/bin/env bash
set -euo pipefail

preflight() {
  test -b /dev/nvme0n1
  findmnt --noheadings --source "$INSTALLER_ROOT_DEVICE" --mountpoint / >/dev/null
  findmnt --noheadings --source "$INSTALLER_ESP_DEVICE" --mountpoint "$BOOT" >/dev/null
  # Refuse mounted filesystems and active swap anywhere on the target disk.
  lsblk --json --output MOUNTPOINTS /dev/nvme0n1 |
    jq --exit-status '[.. | objects | .mountpoints? // [] | .[] | select(. != null)] | length == 0' >/dev/null
  if findmnt --mountpoint "$INSTALL_ROOT" >/dev/null; then
    echo "The installation mountpoint is already in use." >&2
    return 1
  fi

  test -s "$BOOT/ssh_host_ed25519_key"
  umask 077
  ssh-to-age -private-key -i "$BOOT/ssh_host_ed25519_key" >"$RUNTIME_DIRECTORY/age-key"
  for secret in "$SECRETS"/*; do
    env -i PATH="$PATH" HOME="$RUNTIME_DIRECTORY" \
      SOPS_AGE_KEY_FILE="$RUNTIME_DIRECTORY/age-key" \
      sops decrypt --input-type json --output-type binary "$secret" >/dev/null
  done
  rm "$RUNTIME_DIRECTORY/age-key"
}

provision() {
  "$DISKO/bin/disko-destroy-format-mount" --yes-wipe-all-disks
}

install_host() {
  install -d -m 0755 "$INSTALL_ROOT/etc/ssh" "$INSTALL_ROOT/nix/store"
  install -m 0600 "$BOOT/ssh_host_ed25519_key" "$INSTALL_ROOT/etc/ssh/ssh_host_ed25519_key"
  ssh-keygen -y -f "$INSTALL_ROOT/etc/ssh/ssh_host_ed25519_key" >"$INSTALL_ROOT/etc/ssh/ssh_host_ed25519_key.pub"
  chmod 0644 "$INSTALL_ROOT/etc/ssh/ssh_host_ed25519_key.pub"

  # Copy and register the embedded closure: installation needs no network or evaluation.
  while IFS= read -r path; do
    cp -a "$path" "$INSTALL_ROOT/nix/store/"
  done <"$CLOSURE/store-paths"
  NIX_STATE_DIR="$INSTALL_ROOT/nix/var/nix" nix-store --load-db <"$CLOSURE/registration"
  "$NIXOS_INSTALL/bin/nixos-install" \
    --root "$INSTALL_ROOT" --system "$HOST_SYSTEM" \
    --no-channel-copy --no-root-password --option substituters ""
}

handoff() {
  test -s "$INSTALL_ROOT/boot/EFI/BOOT/BOOTAA64.EFI"
  sync -f "$INSTALL_ROOT"
  sync -f "$INSTALL_ROOT/boot"
  # Publish the NVMe chainloader before removing the MMC's installer boot entries.
  install -m 0644 "$HANDOFF_SCRIPT" "$BOOT/boot.scr.new"
  sync -f "$BOOT/boot.scr.new"
  mv "$BOOT/boot.scr.new" "$BOOT/boot.scr"
  sync -f "$BOOT"
  rm -rf "$BOOT/EFI" "$BOOT/loader"
  rm "$BOOT/ssh_host_ed25519_key"
  sync -f "$BOOT"
}

reboot_host() {
  systemctl reboot --no-block
}

run_install() {
  # A failed or interrupted attempt must never cause another automatic wipe.
  if [[ -e "$STATE_DIRECTORY/started" ]]; then
    test -e "$STATE_DIRECTORY/completed"
    return
  fi
  preflight
  mkdir "$STATE_DIRECTORY/started"
  sync -f "$STATE_DIRECTORY"
  provision
  install_host
  handoff
  touch "$STATE_DIRECTORY/completed"
  sync -f "$STATE_DIRECTORY"
  reboot_host
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  run_install
fi

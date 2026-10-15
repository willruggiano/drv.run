#!/usr/bin/env bash
set -euo pipefail

exec nix-fast-build \
  --flake './examples/rock5b#' \
  --select 'flake: {
    host  = flake.nixosConfigurations.rock5b.config.system.build.toplevel;
    guest = flake.deploy.nodes.rock5b.profiles.system.path;
    shell = flake.inputs.drv-run.devShells.aarch64-linux.default;
  }' \
  --systems aarch64-linux \
  --cachix-cache "${1:-drv-run}" \
  --push-build-closure

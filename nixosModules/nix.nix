{
  lib,
  pkgs,
  ...
}: {
  # Keep the daemon and all drv.run clients on the same pinned implementation.
  nix.package = lib.mkDefault pkgs.nixVersions.nix_2_35;
  nix.settings = {
    # Already the upstream default; essential for repeated immutable flakes.
    eval-cache = true;
    substituters = [
      "https://drv-run.cachix.org"
    ];
    trusted-public-keys = [
      "drv-run.cachix.org-1:WPTiRxMwsLWdwH7RqpbLzjXy/282xH6G4Qq/+igHVx0="
    ];
  };
}

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
      "https://microvm.cachix.org"
      "https://willruggiano.cachix.org"
    ];
    trusted-public-keys = [
      "microvm.cachix.org-1:oXnBc6hRE3eX5rSYdRyMYXnfzcCxC7yKPTbZXALsqys="
      "willruggiano.cachix.org-1:rz00ME8/uQfWe+tN3njwK5vc7P8GLWu9qbAjjJbLoSw="
    ];
  };
}

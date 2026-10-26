{pkgs, ...}: {
  app = pkgs.callPackage ./app {};
  bench = pkgs.callPackage ./bench {};
  # cloud-hypervisor = pkgs.callPackage ./cloud-hypervisor {}; # remove after: https://github.com/NixOS/nixpkgs/pull/574147
  mitm-proxy = pkgs.callPackage ./mitm-proxy {};
  subtrace = pkgs.callPackage ./subtrace.nix {};
  treefmt-wrapped = pkgs.callPackage ./formatter.nix {};
}

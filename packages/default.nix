{
  pkgs,
  inputs,
  ...
}: {
  app = pkgs.callPackage ./app {};
  bench = pkgs.callPackage ./bench {};
  # cloud-hypervisor = pkgs.callPackage ./cloud-hypervisor {}; # remove after: https://github.com/NixOS/nixpkgs/pull/574147
  mitm-proxy = pkgs.callPackage ./mitm-proxy {};
  ssh-exposure = pkgs.callPackage ./ssh-exposure {};
  subtrace = pkgs.callPackage ./subtrace.nix {};
  systemd = let
    # The unoverlaid package avoids recursion through our systemd overlay.
    upstream = inputs.nixpkgs.legacyPackages.${pkgs.stdenv.hostPlatform.system};
    kernel = upstream.linuxPackages.kernel;
    vmlinuxHeader =
      upstream.runCommand "nsresourced-vmlinux.h-${kernel.version}" {
        nativeBuildInputs = [upstream.bpftools];
      } ''
        mkdir -p "$out"
        bpftool btf dump file ${kernel.dev}/vmlinux format c > "$out/vmlinux.h"
        test -s "$out/vmlinux.h"
      '';
  in
    (upstream.systemd.override {
      withLibBPF = true;
      vmlinux-btf = vmlinuxHeader;
    }).overrideAttrs (old: {
      # Match config_get_stats_by_path's resolved paths, or udev continually
      # reloads rules reached through NixOS's /etc symlinks.
      postPatch =
        old.postPatch
        + ''
          substituteInPlace src/udev/udev-rules.c \
            --replace-fail 'hashmap_put_stats_by_path(&rules->stats_by_path, c->original_path, &c->st)' \
                           'hashmap_put_stats_by_path(&rules->stats_by_path, c->result, &c->st)'
        '';
    });
  treefmt-wrapped = pkgs.callPackage ./formatter.nix {};
}

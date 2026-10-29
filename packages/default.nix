{pkgs, ...}: {
  app = pkgs.callPackage ./app {};
  bench = pkgs.callPackage ./bench {};
  # cloud-hypervisor = pkgs.callPackage ./cloud-hypervisor {}; # remove after: https://github.com/NixOS/nixpkgs/pull/574147
  mitm-proxy = pkgs.callPackage ./mitm-proxy {};
  sshx = pkgs.callPackage ./sshx {};
  subtrace = pkgs.callPackage ./subtrace.nix {};
  systemd-with-vmlinux-btf = pkgs.linuxPackages.systemd.overrideAttrs (old: {
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
  tap = pkgs.callPackage ./tap {};
  treefmt-wrapped = pkgs.callPackage ./formatter.nix {};
}

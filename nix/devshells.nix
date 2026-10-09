pkgs: let
  tools = map pkgs.lib.getBin (with pkgs; [
    ast-grep
    bash
    coreutils
    curl
    diffutils
    fd
    file
    findutils
    gawk
    git
    gnugrep
    gnused
    gnutar
    gzip
    hunk
    jq
    jujutsu
    just
    less
    libnotify
    man
    markdownlint-cli2
    nix-update
    nodejs
    nq
    oxlint
    patch
    pkg-config
    procps
    python3
    ripgrep
    scc
    sd
    stdenv.cc
    tree
    treefmt-wrapped
    tsgolint
    typescript # tsgo
    unzip
    vtsls
    wget
    which
    zmx
  ]);
in {
  default = pkgs.mkShell {
    nativeBuildInputs = [pkgs.importNpmLock.hooks.linkNodeModulesHook pkgs.systemd.dev];
    npmDeps = pkgs.pi-node-modules;
    packages = tools ++ [pkgs.pi-with-store-paths];
  };
  jail = pkgs.mkShell {
    nativeBuildInputs = [pkgs.importNpmLock.hooks.linkNodeModulesHook pkgs.systemd.dev];
    npmDeps = pkgs.pi-node-modules;
    packages = tools ++ [pkgs.pi-jailed pkgs.subtrace];
  };
}

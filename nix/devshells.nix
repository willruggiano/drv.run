pkgs: let
  tools = map pkgs.lib.getBin (with pkgs; [
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
    procps
    python3
    ripgrep
    scc
    sd
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
    nativeBuildInputs = [pkgs.importNpmLock.hooks.linkNodeModulesHook];
    npmDeps = pkgs.pi-node-modules;
    packages = tools ++ [pkgs.pi-with-store-paths];
  };
  jail = pkgs.mkShell {
    nativeBuildInputs = [pkgs.importNpmLock.hooks.linkNodeModulesHook];
    npmDeps = pkgs.pi-node-modules;
    packages = tools ++ [pkgs.pi-jailed];
  };
}

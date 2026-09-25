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
    oxlint
    patch
    procps
    python3
    ripgrep
    sd
    tree
    treefmt-wrapped
    unzip
    wget
    which
    vtsls
    scc
    tsgolint
    typescript # tsgo
  ]);
in {
  default = pkgs.mkShell {
    nativeBuildInputs = [pkgs.importNpmLock.hooks.linkNodeModulesHook];
    npmDeps = pkgs.pi-unwrapped.dev;
    packages = tools ++ [pkgs.pi-with-store-paths];
  };
  jail = pkgs.mkShell {
    nativeBuildInputs = [pkgs.importNpmLock.hooks.linkNodeModulesHook];
    npmDeps = pkgs.pi-unwrapped.dev;
    packages = tools ++ [pkgs.pi-jailed];
  };
}

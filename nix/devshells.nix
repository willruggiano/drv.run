pkgs: let
  tools = map pkgs.lib.getBin (with pkgs; [
    ast-grep
    bash
    basedpyright
    coreutils
    chromium
    curl
    diffutils
    esbuild
    fd
    file
    findutils
    gawk
    gh
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
    openssh
    oxlint
    patch
    pkg-config
    procps
    python3
    ripgrep
    ruff
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
    npmDeps = pkgs.pi-development-node-modules;
    packages = tools ++ [pkgs.pi-with-store-paths];
    XDG_CONFIG_DIRS = "${pkgs.llm-context}/etc/xdg:/etc/xdg";
  };
  jail = pkgs.mkShell {
    nativeBuildInputs = [pkgs.importNpmLock.hooks.linkNodeModulesHook pkgs.systemd.dev];
    npmDeps = pkgs.pi-development-node-modules;
    packages = tools ++ [pkgs.pi-jailed pkgs.subtrace];
    XDG_CONFIG_DIRS = "${pkgs.llm-context}/etc/xdg:/etc/xdg";
  };
}

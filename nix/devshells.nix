pkgs: let
  tools = map pkgs.lib.getBin (with pkgs; [
    ast-grep
    bash
    basedpyright
    coreutils
    chromium
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
  nodeModules = pkgs.buildEnv {
    name = "drv-run-development-node-modules";
    pathsToLink = ["/node_modules"];
    paths = [pkgs.pi-serve.nodeModules (pkgs.lib.hiPrio pkgs.pi-drv-run.nodeModules)];
  };
in {
  default = pkgs.mkShell {
    nativeBuildInputs = [pkgs.importNpmLock.hooks.linkNodeModulesHook pkgs.systemd.dev];
    npmDeps = nodeModules;
    packages = tools ++ [pkgs.pi-with-store-paths];
  };
  jail = pkgs.mkShell {
    nativeBuildInputs = [pkgs.importNpmLock.hooks.linkNodeModulesHook pkgs.systemd.dev];
    npmDeps = nodeModules;
    packages = tools ++ [pkgs.pi-jailed pkgs.subtrace];
  };
}

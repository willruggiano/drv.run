{
  buildEnv,
  importNpmLock,
  lib,
  nodejs,
  pi-workspace,
}: let
  dependencies = importNpmLock.buildNodeModules {
    inherit nodejs;
    npmRoot = ../serve;
    derivationArgs = {
      pname = "pi-development-npm-deps";
      npmFlags = ["--legacy-peer-deps"];
      npmRebuildFlags = ["--ignore-scripts"];
    };
  };
in
  buildEnv {
    name = "pi-development-node-modules";
    pathsToLink = ["/node_modules"];
    # Local development types take precedence over upstream transitive types.
    paths = [pi-workspace (lib.hiPrio dependencies)];
    # Tool executables come from nativeBuildInputs, not transitive npm bins.
    postBuild = ''rm -rf "$out/node_modules/.bin"'';
  }

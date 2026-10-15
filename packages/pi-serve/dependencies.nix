{
  importNpmLock,
  nodejs,
}:
importNpmLock.buildNodeModules {
  inherit nodejs;
  npmRoot = ./.;
  derivationArgs = {
    pname = "pi-serve-npm-deps";
    npmFlags = ["--legacy-peer-deps"];
    npmRebuildFlags = ["--ignore-scripts"];
  };
}

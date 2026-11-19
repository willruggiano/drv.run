{
  lib,
  writeShellApplication,
  python3,
  erofs-utils,
  nodejs,
}: let
  source = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [./main.py ./tests];
  };
in
  writeShellApplication {
    name = "drv-run-guest-files";
    runtimeInputs = [python3 erofs-utils];
    text = ''
      exec python3 -B ${./main.py} "$@"
    '';
    derivationArgs = {
      doCheck = true;
      nativeCheckInputs = [python3 erofs-utils nodejs];
      postCheck = ''
        node --test "${source}/tests/*.test.ts"
      '';
    };
    meta.description = "Assemble private guest filesystem snapshots from producer trees";
  }

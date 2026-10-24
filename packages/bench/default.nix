{
  bash,
  coreutils,
  hyperfine,
  lib,
  nix,
  python3,
  runCommand,
  systemd,
  writeShellApplication,
  ...
}:
writeShellApplication {
  name = "bench";
  runtimeInputs = [
    coreutils
    hyperfine
    nix
    python3
    systemd
  ];
  text = ''
    if [[ ''${1:-} == recover ]]; then
      shift
      exec python3 ${./main.py} recover "$@"
    fi
    exec python3 ${./main.py} run \
      --launcher /run/current-system/sw/bin/drv.run \
      --bash ${lib.getExe bash} "$@"
  '';
  meta.description = "drv.run benchmark runner";
  # TODO: currently broken. Fix if you get the chance but keep the definition here!
  # passthru.tests =
  #   runCommand "bench-tests" {
  #     src = lib.fileset.toSource {
  #       root = ./.;
  #       fileset = lib.fileset.unions [
  #         ./main.py
  #         ./tests
  #       ];
  #     };
  #     nativeBuildInputs = [python3];
  #   } ''
  #     cd $src
  #     python3 -m unittest discover -s .tests -p '*_test.py'
  #     touch $out
  #   '';
}

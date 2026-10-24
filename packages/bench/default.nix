{
  bash,
  coreutils,
  hyperfine,
  lib,
  nix,
  python3,
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
  derivationArgs.postCheck = ''
    PYTHONPATH=${lib.fileset.toSource {
      root = ../.;
      fileset = lib.fileset.unions [./main.py ./tests];
    }} ${lib.getExe python3} -B -m unittest discover -s bench.tests -p '*_test.py'
  '';
}

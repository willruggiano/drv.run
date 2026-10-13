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
      exec python3 ${./benchmark.py} recover "$@"
    fi
    exec python3 ${./benchmark.py} run \
      --launcher /run/current-system/sw/bin/drv.run \
      --bash ${lib.getExe bash} "$@"
  '';
  meta.description = ''
    The drv.run benchmark runner.
  '';
}

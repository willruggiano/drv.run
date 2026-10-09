{
  writeShellApplication,
  python3,
  bash,
  hyperfine,
  coreutils,
  systemd,
  nix,
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
      --bash ${bash}/bin/bash "$@"
  '';
  meta.description = ''
    The drv.run benchmark runner.
  '';
}

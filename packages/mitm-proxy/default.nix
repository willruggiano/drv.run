{
  lib,
  git,
  gh,
  python3,
  runCommand,
  writeShellApplication,
}: let
  python = python3.withPackages (ps: [ps.mitmproxy]);
in
  writeShellApplication {
    name = "mitm-proxy";
    runtimeInputs = [python];
    text = ''
      exec python3 ${./main.py} "$@"
    '';
    derivationArgs.passthru.tests.unit =
      runCommand "mitm-proxy-unit" {
        nativeBuildInputs = [python git gh];
      } ''
        export PYTHONDONTWRITEBYTECODE=1
        export PYTHONPATH=${./.}
        python3 -m unittest discover -s ${./.}/tests -t ${./.} -p '*_test.py'
        touch "$out"
      '';
    meta.description = "Host-side credential substitution for drv.run";
    meta.license = lib.licenses.mit;
  }

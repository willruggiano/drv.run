{
  lib,
  git,
  gh,
  python3,
  writeShellApplication,
  testers,
}: let
  python = python3.withPackages (ps: [ps.mitmproxy ps.tornado]);
in
  writeShellApplication {
    name = "mitm-proxy";
    runtimeInputs = [python];

    text = ''
      exec python3 ${./.}/main.py "$@"
    '';

    derivationArgs = {
      doCheck = true;
      nativeCheckInputs = [python git gh];

      checkPhase = ''
        runHook preCheck
        export PYTHONDONTWRITEBYTECODE=1
        export PYTHONPATH=${./.}
        python3 -m unittest discover -s ${./.}/tests -t ${./.} -p '*_test.py'
        runHook postCheck
      '';
    };

    passthru.tests.service = testers.runNixOSTest (import ../../tests/nixos/mitm-proxy.nix);

    meta = {
      description = "Host-side credential substitution for drv.run";
      license = lib.licenses.mit;
    };
  }

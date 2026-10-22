{
  lib,
  git,
  gh,
  python3,
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

    meta = {
      description = "Host-side credential substitution for drv.run";
      license = lib.licenses.mit;
    };
  }

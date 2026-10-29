{
  lib,
  stdenv,
  systemd,
  openssh,
  git,
  python3,
  nss_wrapper,
}:
stdenv.mkDerivation {
  pname = "drv.run.sshx";
  version = "0.1.0";
  src = ./.;
  env.NIX_CFLAGS_COMPILE = toString [
    "-std=c17"
    "-Wall"
    "-Wextra"
    "-Werror"
    ''-DPROXY="${systemd}/lib/systemd/systemd-ssh-proxy"''
  ];
  nativeCheckInputs = [openssh git python3];
  buildPhase = ''
    runHook preBuild
    cc connect.c -o drv-run-connect
    runHook postBuild
  '';
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    cc tests/connect.c -o connect.test
    timeout 30 ./connect.test
    cp ${../../nixosModules/host/command.sh} tests/launcher.sh
    cp ${../../nixosModules/guest/shell.sh} tests/shell.sh
    export NSS_WRAPPER_LIBRARY=${nss_wrapper}/lib/libnss_wrapper.so
    export SFTP_SERVER=${openssh}/libexec/sftp-server
    timeout 120 python3 -m unittest discover -s tests -p '*_test.py' -v
    runHook postCheck
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 drv-run-connect "$out/bin/drv-run-connect"
    runHook postInstall
  '';
  meta = {
    description = "Owner-scoped stdio transport to drv.run guest SSH";
    mainProgram = "drv-run-connect";
    platforms = lib.platforms.linux;
  };
}

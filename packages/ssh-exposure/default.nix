{
  lib,
  stdenv,
  libcap,
  systemd,
  writeText,
  testers,
  owners ? [],
}: let
  policy = writeText "drv-run-ssh-policy.h" ''
    static const struct owner owners[] = {
      ${lib.concatMapStringsSep "\n" (owner: "{${toString owner.uid}, ${builtins.toJSON owner.prefix}},") owners}
      {0, NULL},
    };
  '';
in
  stdenv.mkDerivation {
    pname = "drv-run-ssh-exposure";
    version = "1";
    src = ./.;
    buildInputs = [libcap];
    buildPhase = ''
      runHook preBuild
      cp ${policy} policy.h
      flags=(-std=c17 -Wall -Wextra -Werror)
      ccflags=(-DACTIVATE='"${systemd}/bin/systemd-socket-activate"' -DRELAY='"'"$out"'/bin/drv-run-ssh-relay"' -DPROXY='"${systemd}/lib/systemd/systemd-ssh-proxy"')
      $CC "''${flags[@]}" "''${ccflags[@]}" bind.c -lcap -o drv-run-ssh-bind
      $CC "''${flags[@]}" "''${ccflags[@]}" relay.c -o drv-run-ssh-relay
      runHook postBuild
    '';
    doCheck = true;
    checkPhase = ''
      runHook preCheck
      $CC "''${flags[@]}" "''${ccflags[@]}" tests/bind.c -lcap -o test-bind
      $CC "''${flags[@]}" "''${ccflags[@]}" tests/relay.c -o test-relay
      ./test-bind
      timeout 30 ./test-relay
      runHook postCheck
    '';
    installPhase = ''
      runHook preInstall
      install -Dm755 drv-run-ssh-bind "$out/bin/drv-run-ssh-bind"
      install -Dm755 drv-run-ssh-relay "$out/bin/drv-run-ssh-relay"
      runHook postInstall
    '';
    passthru.tests = testers.runNixOSTest (import ../../nix/nixosTests/ssh-exposure.nix);
  }

{
  lib,
  stdenv,
  libcap,
  systemd,
  writeText,
  testers,
  owners ? [],
}: let
  main = "sshx.bind";
in
  stdenv.mkDerivation (finalAttrs: {
    pname = "drv.run.sshx";
    version = "0.1.0";
    src = ./.;
    env.NIX_CFLAGS_COMPILE = toString [
      "-std=c17"
      "-Wall"
      "-Wextra"
      "-Werror"
      ''-DACTIVATE="${lib.getExe' systemd "systemd-socket-activate"}"''
      ''-DPROXY="${systemd}/lib/systemd/systemd-ssh-proxy"''
    ];
    buildInputs = [libcap];
    buildPhase = ''
      runHook preBuild
      cp ${finalAttrs.passthru.policy} policy.h
      mkdir -p $out/bin/
      cc -DRELAY="\"$out/bin/sshx.relay\"" bind.c -lcap -o $out/bin/${main}
      cc relay.c -o $out/bin/sshx.relay
      runHook postBuild
    '';
    doCheck = true;
    checkPhase = ''
      runHook preCheck
      cc -DRELAY="\"$out/bin/sshx.relay\"" tests/bind.c -lcap -o bind.test
      cc tests/relay.c -o relay.test
      ./bind.test && timeout 30 ./relay.test
      runHook postCheck
    '';
    passthru = {
      policy = writeText "policy.h" ''
        static const struct owner owners[] = {
          ${lib.concatMapStringsSep "\n" (owner: "{${toString owner.uid}, ${builtins.toJSON owner.prefix}},") owners}
          {0, NULL},
        };
      '';
      tests = testers.runNixOSTest (import ../../nix/nixosTests/ssh-exposure.nix);
    };
    meta = {
      description = "TODO: fill me in please!";
      mainProgram = main;
    };
  })

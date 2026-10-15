{
  buildEnv,
  lib,
  stdenv,
  nodejs,
  typescript,
  openssh,
  systemd,
  pi-runtime,
  pi-env,
}: let
  nodeModules = buildEnv {
    name = "pi-drv-run-node-modules";
    pathsToLink = ["/node_modules"];
    paths = [pi-runtime.nodeModules (lib.hiPrio pi-env)];
    derivationArgs.nativeBuildInputs = [nodejs];
    postBuild = ''
      rm -rf "$out/node_modules/.bin"
      cd "$out"
      node --input-type=module -e '
        import assert from "node:assert/strict";
        import { realpathSync } from "node:fs";
        import { localDaemon } from "@earendil-works/pi-env";
        assert.equal(realpathSync(localDaemon()), realpathSync("${pi-env}/bin/pi-env"));
      '
    '';
  };
in
  stdenv.mkDerivation {
    pname = "pi-drv-run";
    version = (lib.importJSON ./package.json).version;
    src = lib.fileset.toSource {
      root = ../..;
      fileset = lib.fileset.unions [./index.ts ./package.json ./tsconfig.json ./tests ../../pi-runtime];
    };
    nativeBuildInputs = [nodejs typescript];
    configurePhase = ''
      runHook preConfigure
      ln -s ${nodeModules}/node_modules node_modules
      runHook postConfigure
    '';
    buildPhase = ''
      runHook preBuild
      tsc -p pi-extensions/drv-run/tsconfig.json --noEmit false --rewriteRelativeImportExtensions --rootDir . --outDir dist
      runHook postBuild
    '';
    doCheck = true;
    checkPhase = ''
      runHook preCheck
      node --test pi-extensions/drv-run/tests/*.test.ts
      runHook postCheck
    '';
    installPhase = ''
      runHook preInstall
      target="$out/lib/pi-extensions/drv-run"
      mkdir -p "$target"
      cp dist/pi-extensions/drv-run/index.js pi-extensions/drv-run/package.json "$target/"
      ln -s ${nodeModules}/node_modules "$target/node_modules"
      ln -s ${pi-runtime}/lib/pi-runtime "$out/lib/pi-runtime"
      substituteInPlace "$target/index.js" \
        --replace-fail '?? "systemctl"' '?? "${systemd}/bin/systemctl"' \
        --replace-fail '?? "ssh"' '?? "${openssh}/bin/ssh"'
      runHook postInstall
    '';
    passthru = {inherit nodeModules;};
    meta = {
      description = "Optional drv.run execution integration for pi-durable applications";
      platforms = ["x86_64-linux" "aarch64-linux"];
      license = lib.licenses.mit;
    };
  }

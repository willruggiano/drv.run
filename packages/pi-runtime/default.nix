{
  buildEnv,
  lib,
  stdenv,
  nodejs,
  typescript,
  pi-node-modules,
  pi-durable,
}: let
  nodeModules = buildEnv {
    name = "pi-runtime-node-modules";
    pathsToLink = ["/node_modules"];
    paths = [pi-node-modules pi-durable];
    postBuild = ''rm -rf "$out/node_modules/.bin"'';
  };
in
  stdenv.mkDerivation {
    pname = "pi-runtime";
    version = (lib.importJSON ./package.json).version;
    src = lib.fileset.toSource {
      root = ./.;
      fileset = lib.fileset.unions [./index.ts ./testing.ts ./runtime.test.ts ./package.json ./tsconfig.json];
    };
    nativeBuildInputs = [nodejs typescript];
    configurePhase = ''
      runHook preConfigure
      ln -s ${nodeModules}/node_modules node_modules
      runHook postConfigure
    '';
    buildPhase = ''
      runHook preBuild
      tsc -p tsconfig.json --noEmit false --rewriteRelativeImportExtensions --outDir dist
      runHook postBuild
    '';
    doCheck = true;
    checkPhase = ''
      runHook preCheck
      node --test runtime.test.ts
      runHook postCheck
    '';
    installPhase = ''
      runHook preInstall
      mkdir -p "$out/lib/pi-runtime"
      cp dist/index.js package.json "$out/lib/pi-runtime/"
      ln -s ${nodeModules}/node_modules "$out/lib/pi-runtime/node_modules"
      runHook postInstall
    '';
    passthru = {inherit nodeModules;};
    meta = {
      description = "Frontend-independent pi-durable session runtime";
      platforms = ["x86_64-linux" "aarch64-linux"];
      license = lib.licenses.mit;
    };
  }

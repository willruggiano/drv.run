{
  importNpmLock,
  lib,
  nodejs,
  stdenvNoCC,
  typescript,
}: let
  pkg = lib.importJSON ./package.json;
in
  stdenvNoCC.mkDerivation {
    pname = pkg.name;
    inherit (pkg) version;
    src = lib.fileset.toSource {
      root = ./.;
      fileset = lib.fileset.unions [./package.json ./package-lock.json ./tsconfig.json ./index.ts ./tests];
    };
    npmDeps = importNpmLock {npmRoot = ./.;};
    npmRebuildFlags = ["--ignore-scripts"];
    nativeBuildInputs = [nodejs typescript importNpmLock.npmConfigHook];
    buildPhase = ''
      runHook preBuild
      npm run build
      runHook postBuild
    '';
    doCheck = true;
    checkPhase = ''
      runHook preCheck
      npm run check
      npm test
      runHook postCheck
    '';
    installPhase = ''
      runHook preInstall
      mkdir -p "$out/lib/${pkg.name}/dist"
      cp package.json "$out/lib/${pkg.name}/"
      cp dist/index.js dist/index.d.ts "$out/lib/${pkg.name}/dist/"
      runHook postInstall
    '';
  }

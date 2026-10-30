{
  importNpmLock,
  lib,
  nodejs,
  stdenvNoCC,
  typescript,
}: let
  manifest = lib.importJSON ./package.json;
in
  stdenvNoCC.mkDerivation {
    pname = manifest.name;
    inherit (manifest) version;
    src = lib.fileset.toSource {
      root = ./.;
      fileset = lib.fileset.unions [./package.json ./package-lock.json ./tsconfig.json ./src];
    };
    npmDeps = importNpmLock {npmRoot = ./.;};
    npmRebuildFlags = ["--ignore-scripts"];
    nativeBuildInputs = [nodejs typescript importNpmLock.npmConfigHook];
    preBuild = ''
      patch --batch --forward --fuzz=0 \
        -d node_modules/@earendil-works/pi-durable -p1 \
        < ${../pi-durable-conversation-context.patch}
    '';
    buildPhase = ''
      runHook preBuild
      npm run build
      runHook postBuild
    '';
    doCheck = true;
    checkPhase = ''
      runHook preCheck
      npm run check
      runHook postCheck
    '';
    installPhase = ''
      runHook preInstall
      mkdir -p "$out/lib/${manifest.name}"
      cp -R package.json dist node_modules "$out/lib/${manifest.name}/"
      runHook postInstall
    '';
  }

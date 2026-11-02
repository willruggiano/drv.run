{
  importNpmLock,
  lib,
  nodejs,
  stdenvNoCC,
}: let
  manifest = lib.importJSON ./package.json;
in
  stdenvNoCC.mkDerivation {
    pname = manifest.name;
    inherit (manifest) version;
    src = lib.fileset.toSource {
      root = ./.;
      fileset = lib.fileset.unions [
        ./package.json
        ./package-lock.json
        ./tsconfig.json
        ./tsconfig.build.json
        ./knip.json
        ./src
        ./tests
      ];
    };
    npmDeps = importNpmLock {npmRoot = ./.;};
    npmRebuildFlags = ["--ignore-scripts"];
    nativeBuildInputs = [nodejs importNpmLock.npmConfigHook];
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
      npm test
      runHook postCheck
    '';
    installPhase = ''
      runHook preInstall
      npm prune --omit=dev --ignore-scripts --offline
      mkdir -p "$out/lib/${manifest.name}"
      cp -R package.json dist node_modules "$out/lib/${manifest.name}/"
      mkdir -p "$out/share/${manifest.name}"
      rm -r coverage/tmp
      cp -R coverage "$out/share/${manifest.name}/"
      runHook postInstall
    '';
  }

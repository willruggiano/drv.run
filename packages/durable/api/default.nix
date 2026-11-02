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
      fileset = lib.fileset.unions [
        ./package.json
        ./package-lock.json
        ./tsconfig.json
        ./tsconfig.build.json
        ./src
        ./tests
      ];
    };
    npmDeps = importNpmLock {npmRoot = ./.;};
    npmRebuildFlags = ["--ignore-scripts"];
    nativeBuildInputs = [
      importNpmLock.npmConfigHook
      nodejs
      typescript
    ];
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
      mkdir -p "$out/lib/${pkg.name}"
      cp -R package.json dist node_modules "$out/lib/${pkg.name}/"
      mkdir -p "$out/share/${pkg.name}"
      rm -r coverage/tmp
      cp -R coverage "$out/share/${pkg.name}/"
      runHook postInstall
    '';
  }

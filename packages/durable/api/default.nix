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
        ./.gitignore
        ./.npmrc
        ./package.json
        ./package-lock.json
        ./tsconfig.json
        ./tsconfig.build.json
        ./graphql/tsconfig.grats.json
        ./graphql/src
        ./graphql/tests
        ./src
        ./tests
        ./watch
        ./serve
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
    preInstall = ''
      npm prune --omit=dev --omit=peer --ignore-scripts --offline
    '';
    installPhase = ''
      runHook preInstall
      mkdir -p "$out/lib/${pkg.name}"
      cp -R package.json dist node_modules "$out/lib/${pkg.name}/"
      install -Dm644 graphql/schema.graphql "$out/lib/${pkg.name}/graphql/schema.graphql"
      runHook postInstall
    '';
  }

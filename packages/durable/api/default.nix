{
  importNpmLock,
  durable-harness,
  lib,
  makeWrapper,
  nodejs,
  openssh,
  push-policy,
  stdenvNoCC,
  systemd,
  typescript,
  www,
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
    npmDeps = importNpmLock {
      npmRoot = ./.;
      packageSourceOverrides."node_modules/push-policy" = "${push-policy}/lib/push-policy";
      packageSourceOverrides."node_modules/durable-harness" = "${durable-harness}/lib/durable-harness";
    };
    npmRebuildFlags = ["--ignore-scripts"];
    nativeBuildInputs = [
      importNpmLock.npmConfigHook
      makeWrapper
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
      mkdir -p "$out/bin"
      makeWrapper ${nodejs}/bin/node "$out/bin/${pkg.name}" \
        --add-flags "$out/lib/${pkg.name}/dist/src/index.js" \
        --set-default WWW_ROOT ${www}/share/www \
        --prefix PATH : ${lib.makeBinPath [openssh systemd]}
      runHook postInstall
    '';
  }

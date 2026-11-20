{
  chromium,
  dejavu_fonts,
  fetchurl,
  importNpmLock,
  lib,
  makeFontsConf,
  makeWrapper,
  nodejs,
  openssh,
  writeShellApplication,
  stdenvNoCC,
  typescript,
}: let
  manifest = lib.importJSON ./package.json;
  datastar = fetchurl {
    url = "https://raw.githubusercontent.com/starfederation/datastar/v1.0.5/bundles/datastar.js";
    hash = "sha256-c4DgNEt/k32ArXDt7aHChXgXMVfuR0i+GFCZFJHZEf0=";
  };
  datastarLicense = fetchurl {
    url = "https://raw.githubusercontent.com/starfederation/datastar/v1.0.5/LICENSE.md";
    hash = "sha256-F9oOIW08aoGVJvW3KmpE2E00vNm+tBkaxq+JwVCO8I8=";
  };
in
  stdenvNoCC.mkDerivation (finalAttrs: {
    pname = manifest.name;
    inherit (manifest) version;
    outputs = ["out" "benchmark"];
    src = lib.fileset.toSource {
      root = ./.;
      fileset = lib.fileset.unions [
        ./package.json
        ./package-lock.json
        ./.npmrc
        ./tsconfig.json
        ./tsconfig.build.json
        ./tsconfig.bench.json
        ./src
        ./bench
        ./tests
        ./test-utils
        ./assets/style.css
      ];
    };
    npmDeps = importNpmLock {npmRoot = ./.;};
    npmRebuildFlags = ["--ignore-scripts"];
    nativeBuildInputs = [importNpmLock.npmConfigHook makeWrapper nodejs typescript];
    preBuild = ''
      cp ${datastar} assets/datastar.js
      patch --batch --forward --fuzz=0 \
        -d node_modules/@earendil-works/pi-durable -p1 \
        < ${./pi-durable-conversation-context.patch}
    '';
    buildPhase = ''
      runHook preBuild
      npm run build
      npm run build:bench
      runHook postBuild
    '';
    doCheck = true;
    checkPhase = ''
      runHook preCheck
      export HOME="$(mktemp -d)"
      npm run check
      npm test
      runHook postCheck
    '';
    preInstall = ''
      cp package.json package.runtime.json
      cp "$npmDeps"/package{,-lock}.json .
      npm prune --omit=dev --omit=peer --ignore-scripts --offline
      mv package.runtime.json package.json
      rm node_modules/.package-lock.json
    '';
    installPhase = ''
      runHook preInstall
      mkdir -p "$out/lib/pds" "$out/bin"
      cp -R package.json dist assets node_modules "$out/lib/pds/"
      cp ${datastarLicense} "$out/lib/pds/assets/datastar.LICENSE"
      makeWrapper ${nodejs}/bin/node "$out/bin/pds" \
        --add-flags "$out/lib/pds/dist/index.js" \
        --prefix PATH : ${lib.makeBinPath [openssh]}
      mkdir -p "$benchmark/lib/pds/bench"
      cp bench/dist/bench/index.{js,d.ts} "$benchmark/lib/pds/bench/"
      ln -s "$out/lib/pds/dist" "$benchmark/lib/pds/src"
      ln -s "$out/lib/pds/node_modules" "$benchmark/lib/pds/node_modules"
      ln -s "$out/lib/pds/package.json" "$benchmark/lib/pds/package.json"
      runHook postInstall
    '';
    passthru = {
      bench = writeShellApplication {
        name = "pds-bench";
        runtimeInputs = [nodejs];
        text = ''
          exec node ${finalAttrs.finalPackage.benchmark}/lib/pds/bench/index.js "$@"
        '';
      };
      tests.visual = stdenvNoCC.mkDerivation {
        pname = "pds-visual-tests";
        inherit (manifest) version;
        inherit (finalAttrs) src npmDeps npmRebuildFlags;
        nativeBuildInputs = [importNpmLock.npmConfigHook nodejs];
        nativeCheckInputs = [chromium];
        CHROMIUM_BINARY = lib.getExe chromium;
        FONTCONFIG_FILE = makeFontsConf {
          fontDirectories = [dejavu_fonts];
          impureFontDirectories = [];
          includes = [];
        };
        buildPhase = ''
          runHook preBuild
          patch --batch --forward --fuzz=0 \
            -d node_modules/@earendil-works/pi-durable -p1 \
            < ${./pi-durable-conversation-context.patch}
          cp -R ${finalAttrs.finalPackage}/lib/pds/{dist,assets} .
          runHook postBuild
        '';
        doCheck = true;
        checkPhase = ''
          runHook preCheck
          export HOME="$(mktemp -d)"
          node --test tests/*.chromium.ts
          runHook postCheck
        '';
        installPhase = ''
          runHook preInstall
          touch "$out"
          runHook postInstall
        '';
      };
    };
    meta.mainProgram = "pds";
  })

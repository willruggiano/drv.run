{
  importNpmLock,
  chromium,
  esbuild,
  lib,
  stdenv,
  nodejs,
  typescript,
  makeWrapper,
  pi-runtime,
  pi-drv-run,
  pi-workspace,
  pi-development-node-modules,
}: let
  manifest = lib.importJSON ./package.json;
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ./package.json
      ./package-lock.json
      ./tsconfig.json
      ./server.ts
      ./application.ts
      ../pi-drv-run/index.ts
      ../pi-drv-run/package.json
      ./settings.ts
      ./completions.ts
      ./tests/completions.test.ts
      ./tests/base-directory.test.ts
      ./key-mappings.ts
      ./client.ts
      ./workflow-panels.ts
      ./tests/workflows.test.ts
      ./highlight.ts
      ./build.ts
      ./benchmark.ts
      ./tests/server.test.ts
      ./tests/context.test.ts
      ./tests/testing.ts
      ./index.html
      ./styles.css
      ./design-system.html
      ./sw.js
      ./icon-192.png
      ./icon-512.png
      ../pi-runtime
    ];
  };
in
  stdenv.mkDerivation (finalAttrs: {
    pname = "pi-serve";
    inherit (manifest) version;
    inherit src;
    npmDeps = pi-development-node-modules;
    nativeBuildInputs = [importNpmLock.hooks.linkNodeModulesHook nodejs typescript esbuild makeWrapper];
    buildPhase = ''
      runHook preBuild
      tsc -p pi-serve/tsconfig.json --noEmit false --rewriteRelativeImportExtensions --rootDir . --outDir dist
      node pi-serve/build.ts dist/pi-serve
      runHook postBuild
    '';
    doCheck = true;
    checkPhase = ''
      runHook preCheck
      # Browser tests run locally, not in the Nix build sandbox.
      node --test "pi-serve/tests/*.test.ts"
      runHook postCheck
    '';
    installPhase = ''
      runHook preInstall
      mkdir -p "$out/lib/pi-serve" "$out/bin"
      cp pi-serve/package.json "$out/lib/pi-serve/"
      cp dist/pi-serve/{index.html,styles.css,design-system.html,sw.js,icon-192.png,icon-512.png,server.js,application.js,settings.js,client.js,highlight.js} "$out/lib/pi-serve/"
      ln -s ${pi-workspace}/node_modules "$out/lib/pi-serve/node_modules"
      ln -s ${pi-runtime}/lib/pi-runtime "$out/lib/pi-runtime"
      ln -s ${pi-drv-run}/lib/pi-drv-run "$out/lib/pi-drv-run"
      makeWrapper ${nodejs}/bin/node "$out/bin/pi-serve" \
        --add-flags "$out/lib/pi-serve/server.js"
      runHook postInstall
    '';
    passthru = {
      bench.render = stdenv.mkDerivation {
        pname = "pi-serve-bench-render";
        inherit (finalAttrs) version src npmDeps nativeBuildInputs buildPhase;
        installPhase = ''
          runHook preInstall
          mkdir -p "$out/lib/pi-serve" "$out/bin"
          cp dist/pi-serve/{benchmark,build}.js pi-serve/package.json "$out/lib/pi-serve/"
          for file in server.js client.js highlight.js index.html styles.css; do
            ln -s ${finalAttrs.finalPackage}/lib/pi-serve/"$file" "$out/lib/pi-serve/$file"
          done
          ln -s ${pi-runtime}/lib/pi-runtime "$out/lib/pi-runtime"
          ln -s ${pi-development-node-modules}/node_modules "$out/lib/pi-serve/node_modules"
          makeWrapper ${nodejs}/bin/node "$out/bin/pi-serve-bench-render" \
            --prefix PATH : ${lib.makeBinPath [chromium esbuild]} \
            --add-flags "$out/lib/pi-serve/benchmark.js"
          runHook postInstall
        '';
        meta = {
          description = "Synthetic pi-serve renderer benchmark (JSON output)";
          mainProgram = "pi-serve-bench-render";
          platforms = ["x86_64-linux" "aarch64-linux"];
        };
      };
    };
    doInstallCheck = true;
    installCheckPhase = ''
      runHook preInstallCheck
      node --input-type=module -e "await import('$out/lib/pi-serve/server.js')"
      test ! -e "$out/lib/pi-serve/node_modules/playwright"
      runHook postInstallCheck
    '';
    meta = {
      description = "Web frontend for pi-durable";
      mainProgram = "pi-serve";
      platforms = ["x86_64-linux" "aarch64-linux"];
      license = lib.licenses.mit;
    };
  })

{
  importNpmLock,
  chromium,
  esbuild,
  lib,
  stdenv,
  nodejs,
  typescript,
  makeWrapper,
  systemd,
  git,
  harness,
  pi-workspace,
  pi-development-node-modules,
}: let
  manifest = lib.importJSON ./package.json;
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [./. ../harness];
  };
in
  stdenv.mkDerivation (finalAttrs: {
    pname = "pi-serve";
    inherit (manifest) version;
    inherit src;
    npmDeps = pi-development-node-modules;
    nativeBuildInputs = [importNpmLock.hooks.linkNodeModulesHook nodejs typescript esbuild makeWrapper git];
    buildPhase = ''
      runHook preBuild
      tsc -p serve/tsconfig.json --noEmit false --rewriteRelativeImportExtensions --rootDir . --outDir dist
      node serve/build.ts dist/serve
      runHook postBuild
    '';
    doCheck = true;
    checkPhase = ''
      runHook preCheck
      # Browser tests run locally, not in the Nix build sandbox.
      node --test "serve/tests/*.test.ts"
      runHook postCheck
    '';
    installPhase = ''
      runHook preInstall
      target="$out/lib/serve"
      mkdir -p "$target" "$out/bin"
      cp serve/package.json "$target/"
      cp dist/serve/{index.html,styles.css,design-system.html,sw.js,icon-192.png,icon-512.png,server.js,application.js,sessions.js,instances.js,inspection.js,settings.js,client.js,highlight.js} "$target/"
      ln -s ${pi-workspace}/node_modules "$target/node_modules"
      ln -s ${harness}/lib/harness "$out/lib/harness"
      substituteInPlace "$target/instances.js" \
        --replace-fail '?? "systemctl"' '?? "${systemd}/bin/systemctl"'
      makeWrapper ${nodejs}/bin/node "$out/bin/pi-serve" \
        --add-flags "$target/server.js"
      runHook postInstall
    '';
    passthru = {
      bench.render = stdenv.mkDerivation {
        pname = "pi-serve-bench-render";
        inherit (finalAttrs) version src npmDeps nativeBuildInputs buildPhase;
        installPhase = ''
          runHook preInstall
          mkdir -p "$out/lib/serve" "$out/bin"
          cp dist/serve/{benchmark,build}.js serve/package.json "$out/lib/serve/"
          for file in server.js application.js sessions.js instances.js inspection.js settings.js client.js highlight.js index.html styles.css; do
            ln -s ${finalAttrs.finalPackage}/lib/serve/"$file" "$out/lib/serve/$file"
          done
          ln -s ${harness}/lib/harness "$out/lib/harness"
          ln -s ${pi-development-node-modules}/node_modules "$out/lib/serve/node_modules"
          makeWrapper ${nodejs}/bin/node "$out/bin/pi-serve-bench-render" \
            --prefix PATH : ${lib.makeBinPath [chromium esbuild]} \
            --add-flags "$out/lib/serve/benchmark.js"
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
      node --input-type=module -e "await import('$out/lib/serve/server.js')"
      test ! -e "$out/lib/serve/node_modules/playwright"
      runHook postInstallCheck
    '';
    meta = {
      description = "Web frontend and manager for the coding harness";
      mainProgram = "pi-serve";
      platforms = ["x86_64-linux" "aarch64-linux"];
      license = lib.licenses.mit;
    };
  })

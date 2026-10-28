{
  buildNpmPackage,
  callPackage,
  chromium,
  dbus,
  libnotify,
  elmPackages,
  esbuild,
  fetchNpmDeps,
  git,
  lib,
  makeWrapper,
  nodejs,
  openssh,
  runCommand,
  systemd,
  typescript,
  writeShellApplication,
}: let
  fs = lib.fileset;
  manifest = lib.importJSON ./package.json;
  workspaces = lib.concatStringsSep " " manifest.workspaces;
  manifests = fs.toSource {
    root = ./.;
    fileset = fs.unions ([./package.json ./package-lock.json] ++ map (workspace: ./. + "/${workspace}/package.json") manifest.workspaces);
  };
  npmDeps = fetchNpmDeps {
    name = "app-npm-deps";
    src = manifests;
    fetcherVersion = 2;
    hash = "sha256-CQ+q6euwx8u/gYEWXSfpdDNG+6k1WQoQ2ZqGtEC+EN4=";
  };
  nodeModules = buildNpmPackage {
    pname = "app-node-modules";
    inherit (manifest) version;
    src = manifests;
    inherit npmDeps;
    npmDepsFetcherVersion = 2;
    npmRebuildFlags = ["--ignore-scripts"];
    dontNpmBuild = true;
    installPhase = ''
      runHook preInstall
      # Workspace links belong to the checkout, not the dependency output.
      rm ${lib.concatMapStringsSep " " (workspace: "node_modules/${workspace}") manifest.workspaces}
      mkdir -p "$out"
      mv node_modules "$out/"
      runHook postInstall
    '';
  };
  elmHome = runCommand "app-elm-home" {} ((elmPackages.fetchElmDeps {
      elmVersion = elmPackages.elm.version;
      elmPackages = lib.importJSON ./serve/elm/deps.json;
      registryDat = ./serve/elm/registry.dat;
    })
    + ''
      cp -R .elm $out
    '');
in
  buildNpmPackage (finalAttrs: {
    pname = "app";
    inherit (manifest) version;
    src = fs.toSource {
      root = ./.;
      fileset =
        fs.difference
        (fs.unions [./package.json ./package-lock.json ./harness ./serve ./tape])
        (fs.unions (lib.concatMap (workspace: [
            (fs.maybeMissing (./. + "/${workspace}/dist"))
            (fs.maybeMissing (./. + "/${workspace}/node_modules"))
          ])
          manifest.workspaces
          ++ [(fs.maybeMissing ./serve/elm/elm-stuff)]));
    };
    inherit npmDeps;
    npmDepsFetcherVersion = 2;
    npmRebuildFlags = ["--ignore-scripts"];
    nativeBuildInputs = [esbuild git makeWrapper typescript elmPackages.elm elmPackages.elm-format elmPackages.elm-test];
    preBuild = ''
      export ELM_HOME="$TMPDIR/elm-home"
      cp -R ${elmHome} "$ELM_HOME"
      chmod -R u+w "$ELM_HOME"
    '';
    nativeCheckInputs = [dbus libnotify];
    doCheck = true;
    checkPhase = ''
      runHook preCheck
      npm test
      runHook postCheck
    '';

    # dev contains compiled tooling with development dependencies, not a shell environment.
    outputs = ["out" "dev"];
    installPhase = ''
      runHook preInstall
      for output in "$out" "$dev"; do
        mkdir -p "$output/lib/app"
        cp package.json "$output/lib/app/"
        for workspace in ${workspaces}; do
          mkdir -p "$output/lib/app/$workspace"
          cp -R "$workspace/package.json" "$workspace/dist" "$output/lib/app/$workspace/"
        done
      done
      cp -R node_modules "$dev/lib/app/"
      npm prune --omit=dev --ignore-scripts --offline --no-audit --no-fund
      cp -R node_modules "$out/lib/app/"

      mkdir -p "$out/bin"
      makeWrapper ${nodejs}/bin/node "$out/bin/serve" \
        --add-flags "$out/lib/app/serve/dist/server.js" \
        --suffix PATH : ${lib.makeBinPath [openssh systemd]}
      makeWrapper ${nodejs}/bin/node "$out/bin/notify-guest" \
        --add-flags "$out/lib/app/serve/dist/notification-guest.js" \
        --suffix PATH : ${lib.makeBinPath [systemd]}
      makeWrapper ${nodejs}/bin/node "$out/bin/notify-stream" \
        --add-flags "$out/lib/app/serve/dist/notification-guest.js stream"
      runHook postInstall
    '';
    passthru = {
      inherit elmHome nodeModules;
      bench.render = writeShellApplication {
        name = "serve-bench-render";
        runtimeInputs = [chromium esbuild];
        text = ''
          exec ${lib.getExe nodejs} ${finalAttrs.finalPackage.dev}/lib/app/serve/dist/benchmark.js "$@"
        '';
      };
      tape = callPackage ./tape {app = finalAttrs.finalPackage;};
    };
    meta = {
      description = "Coding harness and web frontend for drv.run";
      mainProgram = "serve";
      platforms = ["x86_64-linux" "aarch64-linux"];
      license = lib.licenses.mit;
    };
  })

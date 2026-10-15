{
  buildEnv,
  callPackage,
  lib,
  stdenv,
  nodejs,
  typescript,
  nixosModules,
  makeWrapper,
  pi-runtime,
}: let
  nodeModules = buildEnv {
    name = "pi-serve-node-modules";
    pathsToLink = ["/node_modules"];
    paths = [pi-runtime.nodeModules (lib.hiPrio (callPackage ./dependencies.nix {}))];
    postBuild = ''rm -rf "$out/node_modules/.bin"'';
  };
  manifest = lib.importJSON ./package.json;
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ./package.json
      ./package-lock.json
      ./tsconfig.json
      ./server.ts
      ./client.ts
      ./server.test.ts
      ./testing.ts
      ./index.html
      ../pi-runtime
    ];
  };
in
  stdenv.mkDerivation (finalAttrs: {
    pname = "pi-serve";
    inherit (manifest) version;
    inherit src;
    nativeBuildInputs = [nodejs typescript makeWrapper];
    configurePhase = ''
      runHook preConfigure
      ln -s ${nodeModules}/node_modules node_modules
      runHook postConfigure
    '';
    buildPhase = ''
      runHook preBuild
      tsc -p pi-serve/tsconfig.json --noEmit false --rewriteRelativeImportExtensions --rootDir . --outDir dist
      runHook postBuild
    '';
    doCheck = true;
    checkPhase = ''
      runHook preCheck
      # Browser tests run locally, not in the Nix build sandbox.
      node --test --test-skip-pattern='^mobile browser ' pi-serve/server.test.ts
      runHook postCheck
    '';
    installPhase = ''
      runHook preInstall
      mkdir -p "$out/lib/pi-serve" "$out/bin"
      cp pi-serve/{package.json,index.html} "$out/lib/pi-serve/"
      cp dist/pi-serve/{server,client}.js "$out/lib/pi-serve/"
      ln -s ${nodeModules}/node_modules "$out/lib/pi-serve/node_modules"
      ln -s ${pi-runtime}/lib/pi-runtime "$out/lib/pi-runtime"
      makeWrapper ${nodejs}/bin/node "$out/bin/pi-serve" \
        --add-flags "$out/lib/pi-serve/server.js"
      runHook postInstall
    '';
    passthru = {
      inherit nodeModules;
      tests.nixos = callPackage ../../tests/nixos/pi-serve.nix {
        inherit nixosModules;
        pi-serve = finalAttrs.finalPackage;
      };
    };
    meta = {
      description = "Web frontend for pi-durable";
      mainProgram = "pi-serve";
      platforms = ["x86_64-linux" "aarch64-linux"];
      license = lib.licenses.mit;
    };
  })

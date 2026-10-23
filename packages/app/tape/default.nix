{
  app,
  piRevision,
  chromium,
  dejavu_fonts,
  liberation_ttf,
  makeFontsConf,
  makeWrapper,
  nodejs,
  lib,
  stdenvNoCC,
  typescript,
}: let
  source = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./browser.ts
      ./cdp.ts
      ./main.ts
      ./model.ts
      ./state.ts
      ./tests
      ./tsconfig.json
    ];
  };
  fonts = makeFontsConf {fontDirectories = [dejavu_fonts liberation_ttf];};
in
  stdenvNoCC.mkDerivation {
    pname = "app-tape";
    version = "0.1.0";
    src = source;
    nativeBuildInputs = [nodejs typescript makeWrapper];
    dontConfigure = true;
    buildPhase = ''
      runHook preBuild
      mkdir -p work/tape
      cp -r ./*.ts ./tsconfig.json ./tests work/tape/
      cp -r ${app.dev}/serve work/serve
      cp -r ${app.dev}/harness work/harness
      cp ${app.dev}/package.json work/package.json
      mkdir work/node_modules
      for module in ${app.dev}/node_modules/*; do
        ln -s "$module" "work/node_modules/$(basename "$module")"
      done
      rm work/node_modules/harness work/node_modules/serve
      ln -s ../harness work/node_modules/harness
      ln -s ../serve work/node_modules/serve
      cd work
      tsc -p tape/tsconfig.json --noEmit false --rewriteRelativeImportExtensions --outDir compiled
      runHook postBuild
    '';
    doCheck = true;
    checkPhase = ''
      runHook preCheck
      NODE_OPTIONS=--conditions=development node --test tape/tests/*.test.ts
      runHook postCheck
    '';
    installPhase = ''
      runHook preInstall
      mkdir -p "$out/lib/app/tape" "$out/bin"
      cp compiled/tape/*.js "$out/lib/app/tape/"
      ln -s ${app}/lib/app/node_modules "$out/lib/app/node_modules"
      ln -s ${app}/lib/app/serve/dist "$out/lib/app/serve"
      printf '{"type":"module"}\n' > "$out/lib/app/package.json"
      cat > "$out/lib/app/tape/build-info.json" <<'JSON'
      ${builtins.toJSON {
        inherit piRevision;
        app = toString app;
        tape = toString source;
      }}
      JSON
      makeWrapper ${lib.getExe nodejs} "$out/bin/app-tape" \
        --add-flags "$out/lib/app/tape/main.js" \
        --set CHROMIUM_BINARY ${lib.getExe chromium} \
        --set FONTCONFIG_FILE ${fonts} \
        --set TAPE_BUILD_INFO "$out/lib/app/tape/build-info.json"
      runHook postInstall
    '';
    meta = {
      description = "Durable-native app presentation capture and replay over CDP";
      mainProgram = "app-tape";
      inherit (app.meta) platforms license;
    };
  }

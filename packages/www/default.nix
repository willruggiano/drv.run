{
  chromium,
  dejavu_fonts,
  elmPackages,
  esbuild,
  importNpmLock,
  lib,
  makeFontsConf,
  nodejs,
  stdenvNoCC,
  typescript,
}:
stdenvNoCC.mkDerivation {
  pname = "www";
  version = "0.1.0";
  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./elm.json
      ./package.json
      ./package-lock.json
      ./src
      ./index.html
      ./styles.css
      ./bootstrap.ts
      ./tests
      ./tsconfig.json
    ];
  };
  npmDeps = importNpmLock {npmRoot = ./.;};
  npmRebuildFlags = ["--ignore-scripts"];
  GRAPHQL_SCHEMA = ../durable/api/graphql/schema.graphql;
  nativeBuildInputs = [
    elmPackages.elm
    elmPackages.elm-format
    esbuild
    importNpmLock.npmConfigHook
    nodejs
  ];
  nativeCheckInputs = [chromium typescript];
  CHROMIUM_BINARY = lib.getExe chromium;
  FONTCONFIG_FILE = makeFontsConf {
    fontDirectories = [dejavu_fonts];
    impureFontDirectories = [];
    includes = [];
  };
  preBuild = elmPackages.fetchElmDeps {
    elmVersion = elmPackages.elm.version;
    elmPackages = lib.importJSON ./deps.json;
    registryDat = ./registry.dat;
  };
  buildPhase = ''
    runHook preBuild
    npm run build
    runHook postBuild
  '';
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    export HOME="$(mktemp -d)"
    npm run check
    runHook postCheck
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p "$out/share/www"
    cp dist/* "$out/share/www/"
    runHook postInstall
  '';
}

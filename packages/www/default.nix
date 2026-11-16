{
  elmPackages,
  importNpmLock,
  lib,
  nodejs,
  stdenvNoCC,
}:
stdenvNoCC.mkDerivation {
  pname = "www";
  version = "0.1.0";
  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [./elm.json ./package.json ./package-lock.json ./src];
  };
  npmDeps = importNpmLock {npmRoot = ./.;};
  npmRebuildFlags = ["--ignore-scripts"];
  GRAPHQL_SCHEMA = ../durable/api/graphql/schema.graphql;
  nativeBuildInputs = [
    elmPackages.elm
    elmPackages.elm-format
    importNpmLock.npmConfigHook
    nodejs
  ];
  preBuild = elmPackages.fetchElmDeps {
    elmVersion = elmPackages.elm.version;
    elmPackages = lib.importJSON ./deps.json;
    registryDat = ./registry.dat;
  };
  buildPhase = ''
    runHook preBuild
    npm run generate
    elm make src/Main.elm --optimize --output=index.html
    runHook postBuild
  '';
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    npm run check
    runHook postCheck
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p "$out/share/www"
    cp index.html "$out/share/www/"
    runHook postInstall
  '';
}

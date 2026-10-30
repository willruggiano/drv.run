{
  elmPackages,
  lib,
  stdenvNoCC,
}:
stdenvNoCC.mkDerivation {
  pname = "www";
  version = "0.1.0";
  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [./elm.json ./src];
  };
  nativeBuildInputs = [elmPackages.elm];
  preBuild = elmPackages.fetchElmDeps {
    elmVersion = elmPackages.elm.version;
    elmPackages = lib.importJSON ./deps.json;
    registryDat = ./registry.dat;
  };
  buildPhase = ''
    runHook preBuild
    elm make src/Main.elm --optimize --output=index.html
    runHook postBuild
  '';
  nativeCheckInputs = [elmPackages.elm-format];
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    elm-format src --validate
    runHook postCheck
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p "$out/share/www"
    cp index.html "$out/share/www/"
    runHook postInstall
  '';
}

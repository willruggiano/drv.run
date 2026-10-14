{
  buildNpmPackage,
  fetchFromGitHub,
  importNpmLock,
  lib,
  nodejs,
}:
buildNpmPackage (finalAttrs: {
  pname = "pi-review";
  version = "git";
  src = fetchFromGitHub {
    owner = "earendil-works";
    repo = finalAttrs.pname;
    rev = "f1de050504936046c0f85b21fec0e0a93ef394eb";
    hash = "sha256-bvdJjLudTd9YQF8ip30jIvi6MY3MAcw5GXVONx1DLuQ=";
  };

  inherit nodejs;
  inherit (importNpmLock) npmConfigHook;
  npmDeps = importNpmLock {
    npmRoot = finalAttrs.src;
  };
  npmFlags = [
    "--omit=dev"
    "--omit=peer"
    "--legacy-peer-deps"
    "--ignore-scripts"
  ];

  dontNpmBuild = true;
  doCheck = true;

  installPhase = ''
    runHook preInstall
    mkdir -p "$out"
    cp -r . "$out/"
    runHook postInstall
  '';

  meta = {
    description = "A review extension for Pi";
    license = lib.licenses.mit;
  };
})

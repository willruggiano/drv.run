{
  buildNpmPackage,
  fetchFromGitHub,
  importNpmLock,
  lib,
  nodejs,
}:
buildNpmPackage (finalAttrs: {
  pname = "pi-autoresearch";
  version = "1.9.0";
  src = fetchFromGitHub {
    owner = "davebcn87";
    repo = finalAttrs.pname;
    rev = "v${finalAttrs.version}";
    hash = "sha256-1Pc5pTjWOt00QDu/lRmhSJrpolzBAy5PiFDmGItZY8Y=";
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

  installPhase = ''
    runHook preInstall
    mkdir -p "$out"
    cp -r . "$out/"
    runHook postInstall
  '';

  meta = {
    description = "Autonomous experiment loop for pi";
    license = lib.licenses.mit;
  };
})

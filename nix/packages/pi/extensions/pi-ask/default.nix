{
  fetchFromGitHub,
  fetchPnpmDeps,
  lib,
  nodejs,
  pnpm_10,
  pnpmConfigHook,
  stdenv,
}:
stdenv.mkDerivation (finalAttrs: {
  pname = "pi-ask";
  version = "1.2.0";
  src = fetchFromGitHub {
    owner = "eko24ive";
    repo = finalAttrs.pname;
    rev = "v${finalAttrs.version}";
    hash = "sha256-lHAJMmtlnZyHU+QYUOyAiwnksm+DBu1FPqXhhr9qPLo=";
  };

  nativeBuildInputs = [
    nodejs
    pnpm_10 # match upstream's .github/workflows/ci.yml
    pnpmConfigHook
  ];
  pnpmInstallFlags = ["--prod"];
  pnpmDeps = fetchPnpmDeps {
    inherit
      (finalAttrs)
      pname
      version
      src
      pnpmInstallFlags
      ;
    fetcherVersion = 4;
    hash = "sha256-Ug85lUiNxj1S/H6mbTJpypvSqXOj18uGUntxeF7JEcY=";
    pnpm = pnpm_10;
  };

  dontBuild = true;
  doCheck = true;

  installPhase = ''
    runHook preInstall
    mkdir -p "$out"
    cp -r . "$out/"
    runHook postInstall
  '';

  meta = {
    description = "Interactive clarification flows for Pi coding agent";
    license = lib.licenses.mit;
  };
})

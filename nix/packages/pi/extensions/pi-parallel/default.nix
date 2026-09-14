{
  fetchFromGitHub,
  fetchPnpmDeps,
  lib,
  nodejs,
  pnpm_11,
  pnpmConfigHook,
  stdenv,
}:
stdenv.mkDerivation (finalAttrs: {
  pname = "pi-parallel";
  version = "1.2.0";
  src = fetchFromGitHub {
    owner = "parallel-web";
    repo = "parallel-npm-packages";
    rev = "pi-extension-v${finalAttrs.version}";
    hash = "sha256-D1ZmAsbzT6UA3sja15eXekHgN5/x24ZSM6WiUbVOLOM=";
  };

  nativeBuildInputs = [
    nodejs
    pnpm_11
    pnpmConfigHook
  ];
  pnpmWorkspaces = [
    "@parallel-web/monorepo"
    "@parallel-web/pi-extension..."
  ];
  pnpmDeps = fetchPnpmDeps {
    inherit
      (finalAttrs)
      pname
      version
      src
      pnpmWorkspaces
      ;
    pnpm = pnpm_11;
    fetcherVersion = 4;
    hash = "sha256-gU5Jj+wFLgIUkE2eV/h6A/4VfeVqGzj9mMvL6Nuz6Bg=";
  };

  buildPhase = ''
    runHook preBuild
    pnpm --filter @parallel-web/pi-extension build
    runHook postBuild
  '';

  doCheck = true;
  checkPhase = ''
    runHook preCheck
    pnpm --filter @parallel-web/pi-extension test
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p "$out/node_modules"
    cp -r packages/pi-extension/{dist,package.json,README.md} "$out/"
    cp -rL packages/pi-extension/node_modules/parallel-web "$out/node_modules/"
    runHook postInstall
  '';

  meta = {
    description = "Pi extension that adds `web_search`, `web_fetch`, and `web_research` backed by Parallel.";
    license = lib.licenses.mit;
  };
})

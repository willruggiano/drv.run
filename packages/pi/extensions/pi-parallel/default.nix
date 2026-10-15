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
  version = "1.3.0";
  src = fetchFromGitHub {
    owner = "parallel-web";
    repo = "parallel-npm-packages";
    rev = "pi-extension-v${finalAttrs.version}";
    hash = "sha256-0x8AdxUmsgg6Ifv8qQBK2L+R40gGT1bDvf+X08pv2yw=";
  };

  nativeBuildInputs = [
    nodejs
    pnpm_11
    pnpmConfigHook
  ];
  patches = [./peer-deps-github-64.patch];
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
    hash = "sha256-ObIqigFwtyiRQD1mK8yzA02umZxgrrg+6EBwrcsV1as=";
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

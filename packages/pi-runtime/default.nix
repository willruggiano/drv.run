{
  importNpmLock,
  lib,
  stdenv,
  nodejs,
  git,
  typescript,
  pi-workspace,
  pi-development-node-modules,
}:
stdenv.mkDerivation {
  pname = "pi-runtime";
  version = (lib.importJSON ./package.json).version;
  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [./index.ts ./coding.ts ./inspection.ts ./inspection.test.ts ./context.ts ./context.test.ts ./workflows.ts ./review-instructions.ts ./testing.ts ./runtime.test.ts ./workflows.test.ts ./package.json ./tsconfig.json];
  };
  npmDeps = pi-development-node-modules;
  nativeBuildInputs = [importNpmLock.hooks.linkNodeModulesHook nodejs typescript git];
  buildPhase = ''
    runHook preBuild
    tsc -p tsconfig.json --noEmit false --rewriteRelativeImportExtensions --outDir dist
    runHook postBuild
  '';
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    node --test runtime.test.ts context.test.ts inspection.test.ts workflows.test.ts
    runHook postCheck
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p "$out/lib/pi-runtime"
    cp dist/{index,coding,context,inspection,workflows,review-instructions}.js package.json "$out/lib/pi-runtime/"
    ln -s ${pi-workspace}/node_modules "$out/lib/pi-runtime/node_modules"
    runHook postInstall
  '';
  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    node --input-type=module -e "await import('$out/lib/pi-runtime/index.js')"
    test ! -e "$out/lib/pi-runtime/node_modules/playwright"
    runHook postInstallCheck
  '';
  meta = {
    description = "Frontend-independent pi-durable session runtime";
    platforms = ["x86_64-linux" "aarch64-linux"];
    license = lib.licenses.mit;
  };
}

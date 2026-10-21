{
  importNpmLock,
  lib,
  stdenv,
  nodejs,
  typescript,
  openssh,
  pi-workspace,
  pi-development-node-modules,
}:
stdenv.mkDerivation {
  pname = "harness";
  version = (lib.importJSON ./package.json).version;
  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [./index.ts ./context.ts ./drv-run.ts ./tests ./package.json ./tsconfig.json];
  };
  npmDeps = pi-development-node-modules;
  nativeBuildInputs = [importNpmLock.hooks.linkNodeModulesHook nodejs typescript];
  buildPhase = ''
    runHook preBuild
    tsc -p tsconfig.json --noEmit false --rewriteRelativeImportExtensions --outDir dist
    runHook postBuild
  '';
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    node --test "tests/*.test.ts"
    runHook postCheck
  '';
  installPhase = ''
    runHook preInstall
    target="$out/lib/harness"
    mkdir -p "$target"
    cp dist/{index,context,drv-run}.js package.json "$target/"
    ln -s ${pi-workspace}/node_modules "$target/node_modules"
    substituteInPlace "$target/drv-run.js" \
      --replace-fail '?? "ssh"' '?? "${openssh}/bin/ssh"'
    substituteInPlace "$target/package.json" \
      --replace-fail './index.ts' './index.js'
    runHook postInstall
  '';
  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    node --input-type=module -e '
      import assert from "node:assert/strict";
      const api = await import(process.argv[1]);
      assert.deepEqual(Object.keys(api).sort(), ["DrvRunEnv", "openHarness"]);
    ' "$out/lib/harness/index.js"
    test ! -e "$out/lib/harness/node_modules/playwright"
    runHook postInstallCheck
  '';
  meta = {
    description = "Coding harness and drv.run execution environment";
    platforms = ["x86_64-linux" "aarch64-linux"];
    license = lib.licenses.mit;
  };
}

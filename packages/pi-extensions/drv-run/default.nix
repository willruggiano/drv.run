{
  importNpmLock,
  lib,
  stdenv,
  nodejs,
  typescript,
  openssh,
  systemd,
  pi-runtime,
  pi-workspace,
  pi-development-node-modules,
}:
stdenv.mkDerivation {
  pname = "pi-drv-run";
  version = (lib.importJSON ./package.json).version;
  src = lib.fileset.toSource {
    root = ../..;
    fileset = lib.fileset.unions [./index.ts ./package.json ./tsconfig.json ./tests ../../pi-runtime];
  };
  npmDeps = pi-development-node-modules;
  nativeBuildInputs = [importNpmLock.hooks.linkNodeModulesHook nodejs typescript];
  buildPhase = ''
    runHook preBuild
    tsc -p pi-extensions/drv-run/tsconfig.json --noEmit false --rewriteRelativeImportExtensions --rootDir . --outDir dist
    runHook postBuild
  '';
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    node --test pi-extensions/drv-run/tests/*.test.ts
    runHook postCheck
  '';
  installPhase = ''
    runHook preInstall
    target="$out/lib/pi-extensions/drv-run"
    mkdir -p "$target"
    cp dist/pi-extensions/drv-run/index.js pi-extensions/drv-run/package.json "$target/"
    ln -s ${pi-workspace}/node_modules "$target/node_modules"
    ln -s ${pi-runtime}/lib/pi-runtime "$out/lib/pi-runtime"
    substituteInPlace "$target/index.js" \
      --replace-fail '?? "systemctl"' '?? "${systemd}/bin/systemctl"' \
      --replace-fail '?? "ssh"' '?? "${openssh}/bin/ssh"'
    runHook postInstall
  '';
  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    node --input-type=module -e "await import('$out/lib/pi-extensions/drv-run/index.js')"
    test ! -e "$out/lib/pi-extensions/drv-run/node_modules/playwright"
    runHook postInstallCheck
  '';
  meta = {
    description = "Optional drv.run execution integration for pi-durable applications";
    platforms = ["x86_64-linux" "aarch64-linux"];
    license = lib.licenses.mit;
  };
}

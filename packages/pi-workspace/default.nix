{
  src,
  # The rest come from callPackage as usual:
  autoPatchelfHook,
  buildNpmPackage,
  fetchurl,
  importNpmLock,
  lib,
  libxcb,
  pkgsStatic,
  stdenv,
  writeText,
}: let
  package = lib.importJSON (src + "/packages/coding-agent/package.json");
  workspace =
    (lib.importJSON (src + "/package.json"))
    // {
      workspaces = ["packages/*"];
    };
  # Uploaded into the guest: no host dynamic linker or shared libraries.
  daemon = pkgsStatic.rustPlatform.buildRustPackage {
    pname = "pi-env-daemon";
    inherit src;
    version = (lib.importJSON (src + "/packages/env/package.json")).version;
    # Keep ../package.json available to build.rs.
    sourceRoot = "source/packages/env/daemon";
    cargoLock.lockFile = src + "/packages/env/daemon/Cargo.lock";
  };
  daemonArch =
    if stdenv.hostPlatform.isAarch64
    then "arm64"
    else "x64";
  catalog = let
    inherit (lib.importJSON (src + "/nix/model-catalog.json")) revision;
  in
    fetchurl {
      name = "pi-model-catalog.json";
      url = "https://pi.dev/api/models/revisions/${revision}?types=chat,image,classifier";
      sha256 = lib.removePrefix "sha256-" revision;
    };
in
  buildNpmPackage {
    pname = "pi-workspace";
    inherit (package) version;
    inherit src;
    npmBuildScript = "build:offline";
    inherit (importNpmLock) npmConfigHook;
    npmDeps = importNpmLock {
      npmRoot = src;
      package = workspace;
    };
    npmRebuildFlags = ["--ignore-scripts"];
    # Keep the source manifest scoped too: npmConfigHook restores it after install.
    postPatch = ''
      cp ${writeText "pi-workspace-package.json" (builtins.toJSON workspace)} package.json
    '';
    nativeBuildInputs = [autoPatchelfHook];
    buildInputs = [stdenv.cc.cc.lib libxcb];

    # Match upstream nix/package.nix. The normal npm build hook then compiles
    # the workspace graph once, in upstream's order.
    preBuild = ''
      node packages/ai/scripts/hydrate-model-catalog.ts ${catalog}
    '';

    # Preserve workspace links, but do not ship test/build dependencies such as
    # Vitest's Lightning CSS binaries. The source manifest excludes apps/examples.
    installPhase = ''
      runHook preInstall
      npm prune --omit=dev --ignore-scripts --offline --no-audit --no-fund
      mkdir -p "$out"
      cp -r . "$out/"
      # localDaemon() resolves relative to the real env module, not its symlink.
      mkdir -p "$out/packages/env/bin/pi-env-linux-${daemonArch}" "$out/bin"
      ln -s ${daemon}/bin/pi-env "$out/packages/env/bin/pi-env-linux-${daemonArch}/pi-env"
      ln -s ${daemon}/bin/pi-env "$out/bin/pi-env"
      runHook postInstall
    '';

    doInstallCheck = true;
    installCheckPhase = ''
      runHook preInstallCheck
      cd "$out"
      node --input-type=module -e '
        import "@earendil-works/chord/context";
        import "@earendil-works/pi-coding-agent";
        import "@earendil-works/pi-durable";
        import assert from "node:assert/strict";
        import { accessSync, constants, realpathSync } from "node:fs";
        import { localDaemon } from "@earendil-works/pi-env";
        accessSync(localDaemon(), constants.X_OK);
        assert.equal(realpathSync(localDaemon()), realpathSync("${daemon}/bin/pi-env"));
        assert.equal(
          realpathSync("node_modules/@earendil-works/pi-durable"),
          realpathSync("packages/durable"),
        );
      '
      runHook postInstallCheck
    '';

    meta = {
      description = "Pi workspace packages";
      license = lib.licenses.mit;
      platforms = ["x86_64-linux" "aarch64-linux"];
    };
  }

{
  src,
  # The rest come from callPackage as usual:
  autoPatchelfHook,
  buildNpmPackage,
  fetchurl,
  importNpmLock,
  lib,
  libxcb,
  stdenv,
  writeText,
}: let
  package = lib.importJSON (src + "/packages/coding-agent/package.json");
  workspace =
    (lib.importJSON (src + "/package.json"))
    // {
      workspaces = ["packages/*"];
    };
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
    pname = "pi-node-modules";
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
        import "@earendil-works/pi-env";
      '
      runHook postInstallCheck
    '';

    meta = {
      description = "Pi workspace packages";
      license = lib.licenses.mit;
      platforms = ["x86_64-linux" "aarch64-linux"];
    };
  }

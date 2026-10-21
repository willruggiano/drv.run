{
  src,
  buildNpmPackage,
  fetchurl,
  importNpmLock,
  lib,
  pkgsStatic,
  stdenv,
  writeText,
}: let
  packages = map (directory:
    (lib.importJSON (src + "/packages/${directory}/package.json")) // {inherit directory;}) [
    "chord"
    "telemetry"
    "ai"
    "tui"
    "agent"
    "codemode"
    "mcp"
    "durable"
    "env"
    "coding-agent"
  ];
  workspace = (lib.importJSON (src + "/package.json")) // {workspaces = ["packages/*"];};
  # Uploaded into the guest: no host dynamic linker or shared libraries.
  daemon = pkgsStatic.rustPlatform.buildRustPackage {
    pname = "pi-env-daemon";
    inherit src;
    version = (lib.importJSON (src + "/packages/env/package.json")).version;
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
  assert lib.assertMsg (lib.all (package: package.version == (lib.head packages).version) packages)
  "Pi workspace packages must have the same version";
    buildNpmPackage {
      pname = "pi-packages";
      version = (lib.head packages).version;
      inherit src;
      npmBuildScript = "build:offline";
      inherit (importNpmLock) npmConfigHook;
      npmDeps = importNpmLock {
        npmRoot = src;
        package = workspace;
      };
      npmRebuildFlags = ["--ignore-scripts"];
      postPatch = ''
        cp ${writeText "pi-workspace-package.json" (builtins.toJSON workspace)} package.json
      '';
      preBuild = ''
        node packages/ai/scripts/hydrate-model-catalog.ts ${catalog}
      '';
      installPhase = ''
        runHook preInstall
        mkdir -p "$out" packages/env/bin/pi-env-linux-${daemonArch}
        cp ${daemon}/bin/pi-env packages/env/bin/pi-env-linux-${daemonArch}/pi-env
        ${lib.concatMapStringsSep "\n" (package: ''
            tarball="$(cd packages/${package.directory} && npm pack --ignore-scripts --silent --pack-destination "$TMPDIR")"
            mv "$TMPDIR/$tarball" "$out/${package.directory}.tgz"
          '')
          packages}
        runHook postInstall
      '';
      passthru = {inherit packages;};
      meta = {
        description = "Pi npm artifacts built from the pinned source";
        license = lib.licenses.mit;
        platforms = ["x86_64-linux" "aarch64-linux"];
      };
    }

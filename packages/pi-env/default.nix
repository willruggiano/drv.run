{
  lib,
  nodejs,
  pkgsStatic,
  runCommand,
  stdenv,
  pi-node-modules,
}: let
  # The client uploads this executable into the Guest. It must not depend on
  # a dynamic linker or shared libraries from the Host's Nix store.
  daemon = pkgsStatic.rustPlatform.buildRustPackage {
    pname = "pi-env-daemon";
    inherit (pi-node-modules) src version;
    # Keep ../package.json available to build.rs.
    sourceRoot = "source/packages/env/daemon";
    cargoLock.lockFile = pi-node-modules.src + "/packages/env/daemon/Cargo.lock";
  };
  daemonArch =
    if stdenv.hostPlatform.isAarch64
    then "arm64"
    else "x64";
in
  runCommand "pi-env-${pi-node-modules.version}" {
    inherit (pi-node-modules) version;
    nativeBuildInputs = [nodejs];
    meta = {
      description = "Pi remote execution client and static daemon";
      mainProgram = "pi-env";
      license = lib.licenses.mit;
      platforms = ["x86_64-linux" "aarch64-linux"];
    };
  } ''
    target="$out/node_modules/@earendil-works/pi-env"
    mkdir -p "$out/bin" "$target/bin/pi-env-linux-${daemonArch}"
    # Copy the client so localDaemon() finds the binary in this package rather
    # than resolving its module path back into the shared workspace.
    cp -r ${pi-node-modules}/packages/env/{dist,package.json} "$target/"
    ln -s ${pi-node-modules}/node_modules "$target/node_modules"
    ln -s ${daemon}/bin/pi-env "$target/bin/pi-env-linux-${daemonArch}/pi-env"
    ln -s ${daemon}/bin/pi-env "$out/bin/pi-env"
    cd "$out"
    node --input-type=module -e '
      import { localDaemon } from "@earendil-works/pi-env";
      import { accessSync, constants } from "node:fs";
      accessSync(localDaemon(), constants.X_OK);
    '
  ''

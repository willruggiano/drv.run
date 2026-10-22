{
  pi-src,
  autoPatchelfHook,
  buildNpmPackage,
  callPackage,
  chromium,
  esbuild,
  git,
  importNpmLock,
  lib,
  libxcb,
  makeWrapper,
  nodejs,
  openssh,
  stdenv,
  systemd,
  typescript,
  writeShellApplication,
}: let
  manifest = lib.importJSON ./package.json;
  lock = lib.importJSON ./package-lock.json;
  pi = callPackage ./pi.nix {src = pi-src;};
  piPackages = lib.listToAttrs (map (package: lib.nameValuePair package.name package) pi.packages);
  # Include nested entries too: every Pi module must come from this source pin.
  piLocks = lib.filterAttrs (path: _: builtins.match ".*node_modules/@earendil-works/[^/]+" path != null) lock.packages;
  packageSourceOverrides = lib.mapAttrs (path: locked: let
    name = "@earendil-works/${builtins.baseNameOf path}";
    package = piPackages.${name};
  in
    assert lib.assertMsg (locked.version == package.version && (locked.dependencies or {}) == (package.dependencies or {}))
    "${name}: refresh packages/app/package-lock.json to match the pinned Pi source";
      pi + "/${package.directory}.tgz")
  piLocks;
in
  buildNpmPackage (finalAttrs: {
    pname = "app";
    inherit (manifest) version;
    src = lib.fileset.toSource {
      root = ./.;
      fileset =
        lib.fileset.difference
        (lib.fileset.unions [./package.json ./package-lock.json ./harness ./serve])
        (lib.fileset.unions [
          (lib.fileset.maybeMissing ./harness/dist)
          (lib.fileset.maybeMissing ./serve/dist)
          (lib.fileset.maybeMissing ./harness/node_modules)
          (lib.fileset.maybeMissing ./serve/node_modules)
        ]);
    };
    outputs = ["out" "dev"];
    npmDeps = importNpmLock {
      npmRoot = ./.;
      inherit packageSourceOverrides;
      # Registry hashes describe different bytes. The overridden artifacts are
      # built by Nix; retain integrity checks for every other dependency.
      packageLock =
        lock
        // {
          packages = lib.mapAttrs (path: entry:
            if builtins.hasAttr path packageSourceOverrides
            then builtins.removeAttrs entry ["integrity"]
            else entry)
          lock.packages;
        };
    };
    inherit (importNpmLock) npmConfigHook;
    npmRebuildFlags = ["--ignore-scripts"];
    nativeBuildInputs = [autoPatchelfHook esbuild git makeWrapper typescript];
    buildInputs = [stdenv.cc.cc.lib libxcb];

    doCheck = true;
    checkPhase = ''
      runHook preCheck
      npm test
      runHook postCheck
    '';
    installPhase = ''
      runHook preInstall

      # The development output also runs the browser benchmark. It is not in
      # the server's runtime closure.
      mkdir -p "$dev" "$out/lib/app" "$out/bin"
      cp -R node_modules harness serve package.json package-lock.json "$dev/"
      rm -rf "$dev/node_modules/.bin"

      npm prune --omit=dev --ignore-scripts --offline --no-audit --no-fund
      cp -R node_modules package.json "$out/lib/app/"
      for workspace in harness serve; do
        mkdir -p "$out/lib/app/$workspace"
        tarball="$(npm pack --workspace="$workspace" --ignore-scripts --silent --pack-destination "$TMPDIR")"
        tar -xzf "$TMPDIR/$tarball" -C "$out/lib/app/$workspace" --strip-components=1
      done
      substituteInPlace "$out/lib/app/harness/dist/drv-run.js" \
        --replace-fail '?? "ssh"' '?? "${openssh}/bin/ssh"'
      substituteInPlace "$out/lib/app/serve/dist/instances.js" \
        --replace-fail '?? "systemctl"' '?? "${systemd}/bin/systemctl"'
      makeWrapper ${nodejs}/bin/node "$out/bin/serve" \
        --add-flags "$out/lib/app/serve/dist/server.js"
      runHook postInstall
    '';
    passthru.bench.render = writeShellApplication {
      name = "serve-bench-render";
      runtimeInputs = [chromium esbuild];
      text = ''
        exec ${lib.getExe nodejs} ${finalAttrs.finalPackage.dev}/serve/dist/benchmark.js "$@"
      '';
    };
    meta = {
      description = "Coding harness and web frontend for drv.run";
      mainProgram = "serve";
      platforms = ["x86_64-linux" "aarch64-linux"];
      license = lib.licenses.mit;
    };
  })

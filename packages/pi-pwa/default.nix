{
  lib,
  stdenv,
  autoPatchelfHook,
  libxcb,
  importNpmLock,
  nodejs,
  typescript,
  chromium,
  makeWrapper,
  openssh,
  systemd,
  pi-unwrapped,
}: let
  manifest = lib.importJSON ./package.json;
  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./package.json
      ./package-lock.json
      ./tsconfig.json
      ./server.ts
      ./client.ts
      ./server.test.ts
      ./index.html
    ];
  };
in
  assert lib.all (name: manifest.dependencies.${name} == pi-unwrapped.version) [
    "@earendil-works/chord"
    "@earendil-works/pi-ai"
    "@earendil-works/pi-coding-agent"
    "@earendil-works/pi-durable"
    "@earendil-works/pi-env"
  ];
    stdenv.mkDerivation {
      pname = "pi-pwa";
      inherit (manifest) version;
      inherit src;
      # Release artifacts are integrity-pinned by the lockfile; the assertion
      # above keeps their public APIs aligned with the flake's pi version.
      npmDeps = importNpmLock {npmRoot = src;};
      npmRebuildFlags = ["--ignore-scripts"];
      nativeBuildInputs = [nodejs typescript importNpmLock.npmConfigHook makeWrapper autoPatchelfHook];
      buildInputs = [stdenv.cc.cc.lib libxcb];
      dontStrip = true;
      buildPhase = ''
        runHook preBuild
        tsc -p tsconfig.json --noEmit false --rewriteRelativeImportExtensions --outDir dist
        runHook postBuild
      '';
      doCheck = true;
      PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "${chromium}/bin/chromium";
      checkPhase = ''
        runHook preCheck
        node --test server.test.ts
        runHook postCheck
      '';
      installPhase = ''
        runHook preInstall
        mkdir -p "$out/lib/pi-pwa" "$out/bin"
        cp -r node_modules package.json index.html "$out/lib/pi-pwa/"
        cp dist/server.js dist/client.js "$out/lib/pi-pwa/"
        # drv.run guests are Linux. Do not attempt to patch Android ELF binaries
        # against glibc, or retain unrelated remote-platform payloads.
        rm -rf "$out/lib/pi-pwa/node_modules/@earendil-works/pi-env/bin"/pi-env-{android,darwin,windows}-*
        makeWrapper ${nodejs}/bin/node "$out/bin/pi-pwa" \
          --add-flags "$out/lib/pi-pwa/server.js" \
          --prefix PATH : ${lib.makeBinPath [openssh systemd]}
        cat >"$out/bin/pi" <<'SH'
        #!${stdenv.shell}
        set -euo pipefail
        if [[ ''${1:-} == serve ]]; then
          shift
          if [[ ''${1:-} == --help ]]; then
            exec @out@/bin/pi-pwa --help
          fi
          # The user manager owns the worker, not the terminal/SSH session.
          # Pass names, not secret values, in the systemd-run command line.
          environment=()
          while IFS= read -r name; do environment+=("--setenv=$name"); done < <(compgen -e)
          exec ${systemd}/bin/systemd-run --user --unit=pi-pwa --collect \
            --service-type=exec --property=UMask=0077 --property=TimeoutStopSec=20 \
            "''${environment[@]}" @out@/bin/pi-pwa "$@"
        fi
        exec ${pi-unwrapped}/bin/pi "$@"
        SH
        substituteInPlace "$out/bin/pi" --replace-fail @out@ "$out"
        chmod +x "$out/bin/pi"
        runHook postInstall
      '';
      meta = {
        description = "Single-owner LAN web client for Pi Durable in drv.run guests";
        mainProgram = "pi";
        platforms = ["x86_64-linux" "aarch64-linux"];
        license = lib.licenses.mit;
      };
    }

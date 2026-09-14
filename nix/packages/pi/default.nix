{
  fetchFromGitHub,
  fetchNpmDeps,
  fetchurl,
  lib,
  makeWrapper,
  pi-coding-agent,
  symlinkJoin,
  ...
}:
pi-coding-agent.overrideAttrs (
  final: prev: {
    version = "0.85.1";
    src = fetchFromGitHub {
      owner = "earendil-works";
      repo = "pi";
      tag = "v${final.version}";
      hash = "sha256-gU8BSiqqOYt2RRuQONHHGvZeSM5KFQVrwif9bmuUXUc=";
    };

    modelData = fetchurl {
      url = "https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-${final.version}.tgz";
      hash = "sha256-r30RmGF5RFzm/oizfVfeIvgjwP/TplyuMcVVt/XpklM=";
    };
    npmDeps = fetchNpmDeps {
      inherit (final) src;
      hash = "sha256-jzlsZIQzfl1FCZZ5//dHFWwMfBZQ4nRD6KB4HHifPqE=";
    };

    outputs = ["out" "dev"];
    postInstall = ''
      ${prev.postInstall}
      mkdir -p "$dev"
      cp -a node_modules packages package.json package-lock.json "$dev/"
      find "$dev/node_modules/.bin" -delete
    '';

    passthru.extend = exts:
      symlinkJoin {
        name = "${final.pname}-${final.version}-extended";
        paths = [final.finalPackage];
        nativeBuildInputs = [makeWrapper];
        postBuild = ''
          wrapProgram "$out/bin/pi" \
            ${lib.concatMapStringsSep " " (ext: "--add-flag -e --add-flag ${lib.escapeShellArg (toString ext)}") exts}
        '';
        inherit (final) meta;
      };
  }
)

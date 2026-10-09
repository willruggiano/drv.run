{
  inputs,
  lib,
  pkgs,
  ...
}: let
  appendSystemPrompt = pi: prompt:
    pkgs.symlinkJoin {
      inherit (pi) meta name;
      paths = [pi];
      nativeBuildInputs = [pkgs.makeWrapper];
      postBuild = ''
        wrapProgram "$out/bin/pi" \
          --add-flags "--append-system-prompt '${prompt}'"
      '';
    };

  withExtensions = pi: exts:
    pkgs.symlinkJoin {
      name = "${pi.pname}-${pi.version}-extended";
      paths = [pi];
      nativeBuildInputs = [pkgs.makeWrapper];
      postBuild = ''
        wrapProgram "$out/bin/pi" \
          ${lib.concatMapStringsSep " " (ext: "--add-flag -e --add-flag ${lib.escapeShellArg (toString ext)}") exts}
      '';
      inherit (pi) meta;
    };

  store-paths = pkgs.writeTextDir "share/nix-store-paths.txt" ''
    Nix store paths:
    drv.run source -> ${inputs.self.outPath}
    impermanence -> ${inputs.impermanence.outPath}
    jail.nix -> ${inputs.jail.outPath}
    microvm.nix -> ${inputs.microvm.outPath}
    nixpkgs -> ${inputs.nixpkgs.outPath}
               `-- docs -> /doc
               `-- nixos manual -> /nixos/doc/manual

    Man pages (read with `man -l`, ignore locale warnings):
    openssh -> ${pkgs.openssh.man}
    systemd -> ${pkgs.systemd.man}
  '';
in {
  bench = pkgs.callPackage ./bench {};
  subtrace = pkgs.callPackage ./subtrace.nix {};
  treefmt-wrapped = pkgs.callPackage ./formatter.nix {};

  # base pi (from github:earendil-works/pi)
  pi-unwrapped = inputs.pi.packages.${pkgs.stdenv.hostPlatform.system}.default;
  pi-node-modules = pkgs.runCommandLocal "pi-node-modules" {} ''
    mkdir -p "$out/node_modules"
    for module in ${pkgs.pi-unwrapped}/lib/pi/node_modules/*; do
      ln -s "$module" "$out/node_modules/$(basename "$module")"
    done
  '';
  # base pi + some core extensions
  pi-with-extensions = withExtensions pkgs.pi-unwrapped (
    with pkgs; [
      pi-ask
      pi-autoresearch
      pi-notify
      pi-parallel-web
      pi-path-rules
      pi-queued-compact
      pi-review
    ]
  );
  # base pi + core extensions + a system prompt with handy nix store links
  pi-with-store-paths = appendSystemPrompt pkgs.pi-with-extensions "${store-paths}/share/nix-store-paths.txt";
  # that^ but in jail, suitable for quick local iterations
  pi-jailed = let
    jail = inputs.jail.lib.init pkgs;
    shell = inputs.self.devShells.${pkgs.stdenv.hostPlatform.system}.default;
    drv = jail "pi" pkgs.pi-with-store-paths (cs:
      with cs; [
        mount-cwd
        network
        readonly-runtime-args
        (add-pkg-deps (shell.nativeBuildInputs ++ [pkgs.pi-node-modules]))
        (dbus {talk = ["org.freedesktop.Notifications"];})
        # TODO: This is temporary until we have drv.run up and running!
        (jail-to-host-channel "nix_build" ''
          status=0
          nix build -L --no-link "$1" 2>&1 || status=$?
          echo "nix_build: exit code $status"
        '')
        (readwrite (noescape "~/.pi"))
        (set-env "NQDIR" "/tmp")
      ]);
    prompt = pkgs.writeTextDir "share/youve-been-jailed.txt" ''
      **You are in jail!**
      You will be in jail for the entirety of this session.
      Do not attempt to break out of jail.
      If you need to do something that is not possible in jail, stop and ask me for help.
      The following tools are available in jail (non-exhaustive):
      ${lib.concatStringsSep "\n" (map (i: "- ${i.name}") shell.nativeBuildInputs)}
      Note that `nix` is intentionally *not available* in jail.
      Tips:
      - Use `nix_build` (note: underscore! this is **not** `nix-build`) to run one off Nix builds *on the host*:
          nix_build .#checks.x86_64-linux.host-basic
          nix_build .#packages.x86_64-linux.pi-extended
      - Use `nq` for serial background jobs:
          man nq
          nq -c make test
          nq -c make check && nq -c make test && nq -c nix_build .#checks.x86_64-linux.host-basic
      - Use `zmx` for persistent terminal sessions:
          zmx -h
          zmx run host-basic -d nix_build .#checks.x86_64-linux.host-basic && zmx wait host-basic
    '';
  in
    appendSystemPrompt drv "${prompt}/share/youve-been-jailed.txt";

  # extensions:
  pi-ask = pkgs.callPackage ./pi/extensions/pi-ask {};
  pi-autoresearch = pkgs.callPackage ./pi/extensions/pi-autoresearch {};
  pi-notify = pkgs.callPackage ./pi/extensions/pi-notify {};
  pi-parallel-web = pkgs.callPackage ./pi/extensions/pi-parallel {};
  pi-path-rules = pkgs.runCommandLocal "path-rules" {} ''
    mkdir -p "$out/extensions"
    cp -r ${./pi/extensions/rules} "$out/extensions/path-rules"
  '';
  pi-queued-compact = pkgs.runCommandLocal "queued-compact" {} ''
    mkdir -p "$out/extensions"
    cp -r ${./pi/extensions/queue} "$out/extensions/queue"
  '';
  pi-review = pkgs.callPackage ./pi/extensions/pi-review {};
}

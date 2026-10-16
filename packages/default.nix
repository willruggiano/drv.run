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
    nix -> ${pkgs.nix.doc}
    deploy-rs -> ${inputs.deploy-rs.outPath}
    sops-nix -> ${inputs.sops-nix.outPath}

    Man pages (read with `man -l`, ignore locale warnings):
    openssh -> ${pkgs.openssh.man}
    systemd -> ${pkgs.systemd.man}
  '';
in {
  bench = pkgs.callPackage ./bench {};
  # TODO: Remove once https://github.com/NixOS/nixpkgs/pull/574147 is merged.
  cloud-hypervisor = pkgs.callPackage ./cloud-hypervisor {};
  subtrace = pkgs.callPackage ./subtrace.nix {};
  treefmt-wrapped = pkgs.callPackage ./formatter.nix {};

  pi-runtime = pkgs.callPackage ./pi-runtime {};
  pi-drv-run = pkgs.callPackage ./pi-extensions/drv-run {};
  pi-serve = pkgs.callPackage ./pi-serve {inherit (inputs.self) nixosModules;};

  # pi packages and wrapped harnesses

  # base pi (from github:earendil-works/pi)
  pi-unwrapped = inputs.pi.packages.${pkgs.stdenv.hostPlatform.system}.default;
  pi-workspace = pkgs.callPackage ./pi-workspace {src = inputs.pi;};
  pi-development-node-modules = pkgs.callPackage ./pi-workspace/development.nix {};
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
        (add-pkg-deps (shell.nativeBuildInputs ++ [shell.npmDeps]))
        (dbus {talk = ["org.freedesktop.Notifications"];})
        (let
          rockctl = pkgs.writeShellApplication {
            name = "rockctl";
            meta.description = "Basic control over the ROCK 5B, including triggering deployment via the canonical deploy-rs app.";
            runtimeInputs = [pkgs.nix];
            text = ''
              if [[ $PWD != $HOME/dev/drv.run ]]; then
                echo 'Error: rockctl should only run from the drv.run repository root' >&2
                exit 1
              fi
              case "$1" in
              deploy)
                mkdir -p .scratch
                exec nix run ./examples/rock5b#deploy 2>&1 | tee .scratch/rock5b-deploy.log
                exit $?
                ;;
              *)
                echo "Error: unknown argument $1" >&2
                exit 1
                ;;
              esac
            '';
          };
        in
          jail-to-host-channel "rockctl" ''
            status=0
            ${lib.getExe rockctl} "$@" || status=$?
            echo "rockctl $*: exit code $status"
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
      Note that `nix` is intentionally *not available* in jail. If you need to run `nix`, stop and give me the exact command.
      Tips:
      - Use `rockctl` to interact with the ROCK 5B (examples/rock5b/flake.nix):
          rockctl deploy
      - Use `nq` for serial background jobs:
          man nq
          nq -c just test
          nq -c just check && nq -c just test && nq -c just test
      - Use `zmx` for persistent terminal sessions:
          zmx -h
          zmx run check-test -d 'make check && make test'
    '';
  in
    appendSystemPrompt drv "${prompt}/share/youve-been-jailed.txt";

  # extensions/packages:
  pi-ask = pkgs.callPackage ./pi-extensions/pi-ask {};
  pi-autoresearch = pkgs.callPackage ./pi-extensions/pi-autoresearch {};
  pi-notify = pkgs.callPackage ./pi-extensions/pi-notify {};
  pi-parallel-web = pkgs.callPackage ./pi-extensions/pi-parallel {};
  pi-path-rules = pkgs.runCommandLocal "path-rules" {} ''
    mkdir -p "$out/extensions"
    cp -r ${./pi-extensions/rules} "$out/extensions/path-rules"
  '';
  pi-queued-compact = pkgs.runCommandLocal "queued-compact" {} ''
    mkdir -p "$out/extensions"
    cp -r ${./pi-extensions/queue} "$out/extensions/queue"
  '';
  pi-review = pkgs.callPackage ./pi-extensions/pi-review {};
}

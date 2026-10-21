{
  inputs,
  lib,
  pkgs,
  ...
}: {
  bench = pkgs.callPackage ./bench {};
  # TODO: Remove once https://github.com/NixOS/nixpkgs/pull/574147 is merged.
  cloud-hypervisor = pkgs.callPackage ./cloud-hypervisor {};
  subtrace = pkgs.callPackage ./subtrace.nix {};
  treefmt-wrapped = pkgs.callPackage ./formatter.nix {};

  app = pkgs.callPackage ./app {pi-src = inputs.pi;};

  # TODO: temporary until we no longer need a local harness
  pi-unwrapped = inputs.pi.packages.${pkgs.stdenv.hostPlatform.system}.default;
  pi-jailed = let
    jail = inputs.jail.lib.init pkgs;
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
    pi = appendSystemPrompt pkgs.pi-unwrapped (
      pkgs.writeText "store-paths" ''
        Nix store paths:
        deploy-rs -> ${inputs.deploy-rs.outPath}
        drv.run -> ${inputs.self.outPath}
        impermanence -> ${inputs.impermanence.outPath}
        jail.nix -> ${inputs.jail.outPath}
        microvm.nix -> ${inputs.microvm.outPath}
        nixpkgs -> ${inputs.nixpkgs.outPath}
                   `-- docs -> /doc
                   `-- nixos manual -> /nixos/doc/manual
        nix -> ${pkgs.nix.doc}
        pi -> ${inputs.pi.outPath}
              `-- pi-durable -> /packages/durable/README.md
        sops-nix -> ${inputs.sops-nix.outPath}

        Man pages (read with `man -l`, ignore locale warnings):
        openssh -> ${pkgs.openssh.man}
        systemd -> ${pkgs.systemd.man}
      ''
    );
    shell = inputs.self.devShells.${pkgs.stdenv.hostPlatform.system}.default;
    drv = jail "pi" pi (cs:
      with cs; [
        mount-cwd
        network
        readonly-runtime-args
        (add-pkg-deps shell.nativeBuildInputs)
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
        (ro-bind "${lib.getExe' pkgs.coreutils "env"}" "/usr/bin/env")
        (set-env "NQDIR" "/tmp")
      ]);
    prompt = pkgs.writeTextDir "share/youve-been-jailed.txt" ''
      **You are in jail!**
      You will be in jail for the entirety of this session.
      Do not attempt to break out of jail.
      Your main purpose is using `rockctl` to reploy the ROCK 5B.
      If you need to do something that is not possible in jail, stop and ask me for help.
    '';
  in
    appendSystemPrompt drv "${prompt}/share/youve-been-jailed.txt";
}

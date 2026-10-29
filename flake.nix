{
  description = "drv.run - nixos microvms over ssh";

  nixConfig = {
    extra-substituters = [
      "https://drv-run.cachix.org"
    ];
    extra-trusted-public-keys = [
      "drv-run.cachix.org-1:WPTiRxMwsLWdwH7RqpbLzjXy/282xH6G4Qq/+igHVx0="
    ];
  };

  inputs = {
    self.submodules = true;
    impermanence = {
      url = "github:nix-community/impermanence";
      inputs = {
        home-manager.follows = "";
        nixpkgs.follows = "nixpkgs";
      };
    };
    microvm = {
      url = "path:microvm.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nixpkgs.url = "https://channels.nixos.org/nixpkgs-unstable/nixexprs.tar.zst";
  };

  outputs = {self, ...} @ inputs: let
    inherit (inputs.nixpkgs) lib;
    systems = ["x86_64-linux" "aarch64-linux"];
    eachSystem = f:
      lib.genAttrs systems (
        system: let
          pkgs = import inputs.nixpkgs {
            inherit system;
            overlays = [self.overlays.default];
          };
        in
          f pkgs
      );
  in {
    nixosModules = import ./nixosModules inputs;
    overlays = {
      default = final: prev: {
        inherit
          (self.packages.${prev.stdenv.hostPlatform.system})
          app
          bench
          mitm-proxy
          subtrace
          systemd-with-vmlinux-btf
          tap
          ;
      };
      # n.b. this is for packages only necessary for development and should not
      # be a dependency of the host, guest, nor rock5b components.
      dev = final: prev: {
        inherit
          (self.packages.${prev.stdenv.hostPlatform.system})
          treefmt-wrapped
          ;
      };
    };

    checks = eachSystem (pkgs: let
      environmentImage = import ./nix/nixosTests/environment-image.nix {inherit pkgs;};
    in {
      app-tape = pkgs.app.tape;
      app-tests = pkgs.app;
      bench-tests = pkgs.bench;
      environment-image = environmentImage.artifact;
      llms-snapshot = self.devShells.${pkgs.stdenv.hostPlatform.system}.toolchain.llms;
      mitm-proxy-tests = pkgs.mitm-proxy;
      ssh-exposure = self.packages.${pkgs.stdenv.hostPlatform.system}.ssh-exposure;
      nixos-ssh-exposure = self.packages.${pkgs.stdenv.hostPlatform.system}.ssh-exposure.tests;
      nixos-environment-image = environmentImage.integration;
      nixos-mitm-proxy-tests = pkgs.mitm-proxy.tests;
      nixos-notifications = import ./tests/nixos/notifications.nix {
        inherit pkgs;
        piModule = self.nixosModules.pi;
        inherit (inputs) impermanence;
      };
    });

    devShells = eachSystem (pkgs: let
      inherit (self.devShells.${pkgs.stdenv.hostPlatform.system}) toolchain;
      llms = pkgs.writeTextFile {
        name = "llms.txt";
        destination = "/llms.txt";
        text = ''
          # drv.run development context

          ## Using these references

          - Read only the references relevant to the current task; do not preload every document.
          - Use the working tree for drv.run code. Store paths are immutable dependency references, not the current checkout.
          - Verify dependency behavior against these pinned sources before consulting online documentation.

          ## Tools and preferences

          - Prefer jj over git for repository operations. Inspect the current change and parents before committing; do not assume a linear history.
          - Prefer rg over grep, fd over find, and eza over ls for interactive inspection, not as mandatory replacements in scripts.
          - Use jq for JSON and ast-grep for structural code searches.
          - Use project formatters and checks rather than introducing alternative tooling.

          ## Commands

          Run project commands from the repository root. Use PATH-resolved tools; store paths below select pinned sources and manuals.

          Inspect the working copy and select changes deliberately:
          ```sh
          jj status
          jj log -r '@ | @-'
          jj diff --stat
          jj diff --git -- flake.nix
          jj help -k revsets
          jj help commit
          ```

          Enter the development environment, verify changes, and inspect generated context:
          ```sh
          nix develop .#default
          just check
          just test
          just chromium
          NODE_OPTIONS=--conditions=development node --test --test-name-pattern='XDG context' packages/app/harness/tests/context.test.ts
          system=$(nix eval --impure --raw --expr builtins.currentSystem)
          nix build ".#checks.$system.llms-snapshot" --no-link -L
          nix eval --raw ".#checks.$system.llms-snapshot.text"
          ```

          Keep long checks in a task-specific zmx session. Inspect existing sessions before reusing a name; wait for completion and check the exit status, not just the last log lines.
          ```sh
          zmx list
          zmx run drv-run-checks -d nix flake check -L
          zmx history drv-run-checks | tail -100
          zmx wait drv-run-checks
          ```

          Find NixOS option definitions, then read their types, defaults and surrounding module code. Options may be nested rather than written as a dotted name.
          ```sh
          rg -n -F 'services.openssh' ${inputs.nixpkgs}/nixos/modules
          rg -n -C 6 'PasswordAuthentication =|PermitRootLogin =' ${inputs.nixpkgs}/nixos/modules/services/networking/ssh/sshd.nix
          rg -n 'mkOption|mkEnableOption' nixosModules
          man -M ${pkgs.systemd.man}/share/man systemd.service
          man -M ${pkgs.openssh.man}/share/man sshd_config
          ```

          ## Pinned dependency references

          Harness, conversations and extensions:
            ${pkgs.app.nodeModules}/node_modules/@earendil-works/pi-durable/README.md
          Durable API:
            ${pkgs.app.nodeModules}/node_modules/@earendil-works/pi-durable/dist/index.d.ts
          Remote execution semantics:
            ${pkgs.app.nodeModules}/node_modules/@earendil-works/pi-env/docs/semantics.md
          Remote execution protocol:
            ${pkgs.app.nodeModules}/node_modules/@earendil-works/pi-env/docs/protocol.md
          Cancellation and context propagation:
            ${pkgs.app.nodeModules}/node_modules/@earendil-works/chord/dist/context/index.js
          Telemetry contracts:
            ${pkgs.app.nodeModules}/node_modules/@earendil-works/pi-telemetry/README.md

          Nix command and language reference:
            ${pkgs.nixVersions.latest.doc}/share/doc/nix/manual/
          Nix shell applications and trivial builders:
            ${inputs.nixpkgs}/pkgs/build-support/trivial-builders/default.nix
          Nix build phases:
            ${inputs.nixpkgs}/doc/stdenv/stdenv.chapter.md
          Nix module semantics:
            ${inputs.nixpkgs}/doc/module-system/module-system.chapter.md
          NixOS modules and options:
            ${inputs.nixpkgs}/nixos/modules/
          Elm dependency APIs:
            ${pkgs.app.elmHome}/${(lib.importJSON ./packages/app/serve/elm/elm.json).elm-version}/packages/elm/

          MicroVM configuration:
            ${inputs.microvm}/README.md
          Persistence:
            ${inputs.impermanence}/README.org
        '';
        checkPhase = ''
          runHook preCheck
          ${lib.getExe pkgs.gnused} -E 's@/nix/store/[0-9a-z]{32}-@/nix/store/HASH-@g' "$target" > actual.txt
          ${lib.getExe' pkgs.diffutils "diff"} -u ${./tests/llms.txt} actual.txt
          runHook postCheck
        '';
      };
      pkgs' = pkgs.extend self.overlays.dev;
    in {
      default = pkgs.mkShell {
        inherit (toolchain) npmDeps npmRoot;
        inputsFrom = [toolchain];
      };
      local = pkgs.mkShell {
        inherit (toolchain) npmDeps npmRoot;
        inputsFrom = [toolchain];
        packages = [pkgs'.treefmt-wrapped];
      };
      toolchain = pkgs.mkShell {
        nativeBuildInputs = [pkgs.systemd.dev pkgs.importNpmLock.hooks.linkNodeModulesHook];
        npmDeps = pkgs.app.nodeModules;
        npmRoot = "packages/app";
        packages = with pkgs; (map lib.getBin [
          ast-grep
          bash
          basedpyright
          cachix
          coreutils
          chromium
          curl
          dbus
          diffutils
          esbuild
          elmPackages.elm
          elmPackages.elm-format
          elmPackages.elm-test
          eza
          fd
          file
          findutils
          gawk
          gh
          git
          gnugrep
          gnused
          gnutar
          gzip
          hunk
          jq
          jujutsu
          just
          less
          libnotify
          man
          markdownlint-cli2
          nix-eval-jobs
          nix-fast-build
          nix-update
          nodejs
          nq
          openssh
          oxlint
          patch
          pkg-config
          procps
          pueue
          (python3.withPackages (ps: [ps.mitmproxy ps.tornado]))
          ripgrep
          ruff
          scc
          sd
          stdenv.cc
          tree
          tsgolint
          typescript # tsgo
          unzip
          vtsls
          wget
          which
          zmx
        ]);
        passthru = {inherit llms;};
        shellHook = ''
          export XDG_CONFIG_DIRS="${llms}:''${XDG_CONFIG_DIRS:-/etc/xdg}"
          linkNodeModulesHook
          for workspace in ${lib.concatStringsSep " " (lib.importJSON ./packages/app/package.json).workspaces}; do
            ln -sfn "../$workspace" "$npmRoot/node_modules/$workspace"
          done
          export ELM_HOME="''${XDG_CACHE_HOME:-$HOME/.cache}/drv-run-${builtins.baseNameOf pkgs.app.elmHome}"
          if [ ! -d "$ELM_HOME" ]; then
            mkdir -p "$ELM_HOME"
            cp -R ${pkgs.app.elmHome}/. "$ELM_HOME/"
            chmod -R u+w "$ELM_HOME"
          fi
        '';
      };
    });

    formatter = eachSystem (pkgs: self.packages.${pkgs.stdenv.hostPlatform.system}.treefmt-wrapped);
    packages = eachSystem (pkgs: let
      runTest = path:
        pkgs.testers.runNixOSTest (import path {
          inherit (self) nixosModules;
          inherit pkgs;
        });
    in
      lib.attrsets.unionOfDisjoint
      (import ./packages {inherit inputs lib pkgs;})
      {
        # FIXME: these tests require a sizable chunk of compute and memory. They
        # are not included in `nix flake check` for that reason. On the aarch64
        # ROCK 5B, these tests are INCREDIBLY slow. My personal desktop is an
        # x86 system and is capable of running these checks. They are listed
        # here for all systems just in case we want to run them on the
        # (relatively constrained) ROCK 5B aarch64 system.
        nixos-host-basic = runTest ./tests/nixos/host-basic.nix;
        nixos-experimental-port-forwarding = runTest ./tests/nixos/port-forwarding.nix;
      });
  };
}

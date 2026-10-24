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
    deploy-rs = {
      url = "github:serokell/deploy-rs";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    impermanence = {
      url = "github:nix-community/impermanence";
      inputs = {
        home-manager.follows = "";
        nixpkgs.follows = "nixpkgs";
      };
    };
    jail.url = "sourcehut:~alexdavid/jail.nix";
    microvm = {
      url = "path:microvm.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nixpkgs.url = "github:NixOS/nixpkgs?ref=nixpkgs-unstable";
    pi = {
      url = "github:earendil-works/pi/stable";
      inputs = {
        nixpkgs.follows = "nixpkgs";
        nixpkgs-darwin-x64.follows = "";
      };
    };
    sops-nix = {
      url = "github:Mic92/sops-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
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
          cloud-hypervisor
          mitm-proxy
          subtrace
          ;
      };
      # n.b. this is for packages only necessary for development and should not
      # be a dependency of the host, guest, nor rock5b components.
      dev = final: prev: {
        inherit
          (self.packages.${prev.stdenv.hostPlatform.system})
          pi-jailed
          pi-unwrapped
          treefmt-wrapped
          ;
      };
    };

    checks = eachSystem (pkgs: {
      inherit (pkgs) app mitm-proxy;
      app-tape = pkgs.app.tape;
      pi-config = let
        evaluate = settings:
          (lib.nixosSystem {
            modules = [
              self.nixosModules.pi
              {
                nixpkgs.pkgs = pkgs;
                system.stateVersion = "26.11";
                boot.loader.grub.enable = false;
                fileSystems."/" = {
                  device = "none";
                  fsType = "tmpfs";
                };
                users.users.operator = {
                  isNormalUser = true;
                  uid = 1000;
                };
                services.pi =
                  {
                    enable = true;
                    user = "operator";
                  }
                  // settings;
              }
            ];
          }).config;
        valid = config: lib.all (item: item.assertion) config.assertions;
        direct = evaluate {};
        origin = "https://pi.example";
        proxied = evaluate {inherit origin;};
      in
        assert valid direct;
        assert valid proxied;
        assert direct.systemd.user.services.pi.environment.HOST == "127.0.0.1";
        assert !(direct.systemd.user.services.pi.environment ? ORIGIN);
        assert proxied.systemd.user.services.pi.environment.ORIGIN == origin;
        assert valid (evaluate {
          inherit origin;
          host = "::1";
        });
        assert !(valid (evaluate {
          inherit origin;
          host = "0.0.0.0";
        }));
        assert lib.all (origin: !(valid (evaluate {inherit origin;}))) [
          "http://pi.example"
          "https://pi.example/"
          "https://user@pi.example"
          "https://pi.example?query"
          "https://pi.example#fragment"
        ];
          pkgs.runCommand "pi-config" {} "touch $out";
      nixos-mitm-proxy = pkgs.mitm-proxy.tests.service;
      # FIXME: this should live with the bench package, not here.
      bench-test =
        pkgs.runCommand "bench-tests" {
          src = self;
          nativeBuildInputs = [pkgs.python3];
        } ''
          cd $src
          python3 -B -m unittest discover -s packages.bench.tests -p '*_test.py'
          touch $out
        '';
    });

    devShells = eachSystem (pkgs: let
      inherit (self.devShells.${pkgs.stdenv.hostPlatform.system}) toolchain;
      pkgs' = pkgs.extend self.overlays.dev;
    in {
      default = pkgs.mkShell {
        inherit (toolchain) npmDeps npmRoot;
        inputsFrom = [toolchain];
      };
      jail = pkgs'.mkShell {
        inherit (toolchain) npmDeps npmRoot;
        inputsFrom = [toolchain];
        packages = [pkgs'.pi-jailed pkgs'.treefmt-wrapped];
      };
      toolchain = pkgs.mkShell {
        shellHook = ''
          linkNodeModulesHook
          export ELM_HOME="''${XDG_CACHE_HOME:-$HOME/.cache}/drv-run-${builtins.baseNameOf pkgs.app.elmHome}"
          if [ ! -d "$ELM_HOME" ]; then
            mkdir -p "$ELM_HOME"
            cp -R ${pkgs.app.elmHome}/. "$ELM_HOME/"
            chmod -R u+w "$ELM_HOME"
          fi
        '';
        nativeBuildInputs = [pkgs.systemd.dev pkgs.importNpmLock.hooks.linkNodeModulesHook];
        # workspace support: https://github.com/NixOS/nixpkgs/pull/522939
        npmDeps = pkgs.app.dev;
        npmRoot = "packages/app";
        packages = with pkgs; (map lib.getBin [
          ast-grep
          bash
          basedpyright
          cachix
          coreutils
          chromium
          curl
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

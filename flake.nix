{
  description = "drv.run - nixos microvms over ssh";

  nixConfig = {
    extra-substituters = [
      "https://willruggiano.cachix.org"
    ];
    extra-trusted-public-keys = [
      "willruggiano.cachix.org-1:rz00ME8/uQfWe+tN3njwK5vc7P8GLWu9qbAjjJbLoSw="
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
    overlays.default = final: prev: self.packages.${prev.stdenv.hostPlatform.system};

    # per-system outputs
    checks = eachSystem (pkgs: {
      inherit (pkgs) pi-serve harness;
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
      # This one is just a proof of concept. It does not need to be part of the
      # canonical checks!
      # nixos-port-forwarding = pkgs.testers.runNixOSTest (import ./tests/nixos/port-forwarding.nix {
      #   inherit (self) nixosModules;
      #   inherit pkgs;
      # });
      nixos-host-basic = pkgs.testers.runNixOSTest (import ./tests/nixos/host-basic.nix {
        inherit (self) nixosModules;
        inherit pkgs;
      });
    });

    devShells = eachSystem (pkgs: let
      inherit (self.devShells.${pkgs.stdenv.hostPlatform.system}) toolchain;
    in {
      default = pkgs.mkShell {
        inherit (toolchain) npmDeps;
        inputsFrom = [toolchain];
        packages = [pkgs.pi-with-store-paths];
      };
      jail = pkgs.mkShell {
        inherit (toolchain) npmDeps;
        inputsFrom = [toolchain];
        nativeBuildInputs = [pkgs.importNpmLock.hooks.linkNodeModulesHook];
        packages = [pkgs.pi-jailed];
      };
      toolchain = pkgs.mkShell {
        nativeBuildInputs = [pkgs.systemd.dev];
        npmDeps = pkgs.pi-development-node-modules;
        packages = with pkgs; [
          ast-grep
          bash
          basedpyright
          coreutils
          chromium
          curl
          diffutils
          esbuild
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
          nix-update
          nodejs
          nq
          openssh
          oxlint
          patch
          pi-with-store-paths
          pkg-config
          procps
          python3
          ripgrep
          ruff
          scc
          sd
          stdenv.cc
          tree
          treefmt-wrapped
          tsgolint
          typescript # tsgo
          unzip
          vtsls
          wget
          which
          zmx
        ];
      };
    });

    formatter = eachSystem (pkgs: pkgs.treefmt-wrapped);
    packages = eachSystem (pkgs: import ./packages {inherit inputs lib pkgs;});
  };
}

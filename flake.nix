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
          f system pkgs
      );
  in {
    checks = eachSystem (system: pkgs:
      {
        pi-pwa = pkgs.pi-pwa;
        bench-test =
          pkgs.runCommand "bench-tests" {
            src = self;
            nativeBuildInputs = [pkgs.python3];
          } ''
            cd $src
            python3 -B -m unittest discover -s packages.bench.tests -p '*_test.py'
            touch $out
          '';
      }
      // lib.optionalAttrs (system == "x86_64-linux") {
        host-basic = pkgs.testers.runNixOSTest (import ./tests/nixos/host-basic.nix {
          inherit (self) nixosModules;
          inherit pkgs;
        });
      });
    devShells = eachSystem (_: pkgs: import ./nix/devshells.nix pkgs);
    formatter = eachSystem (_: pkgs: pkgs.treefmt-wrapped);
    nixosModules = import ./nixosModules inputs;
    overlays.default = final: prev: let
      inherit (prev.stdenv.hostPlatform) system;
    in
      self.packages.${system};
    packages = eachSystem (_: pkgs: import ./packages {inherit inputs lib pkgs;});
  };
}

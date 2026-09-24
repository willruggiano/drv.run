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
    impermanence = {
      url = "github:nix-community/impermanence";
      inputs = {
        home-manager.follows = "";
        nixpkgs.follows = "nixpkgs";
      };
    };
    jail.url = "sourcehut:~alexdavid/jail.nix";
    microvm = {
      url = "github:microvm-nix/microvm.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nixpkgs.url = "github:NixOS/nixpkgs?ref=nixpkgs-unstable";
  };

  outputs = inputs: let
    inherit (inputs.nixpkgs) lib;
    systems = ["x86_64-linux"];
    eachSystem = f:
      lib.genAttrs systems (
        system: let
          pkgs = import inputs.nixpkgs {
            inherit system;
            overlays = [inputs.self.overlays.default];
          };
        in
          f pkgs
      );
  in {
    checks = eachSystem (pkgs: {
      host-basic = pkgs.testers.runNixOSTest (import ./nix/nixosTests/host-basic.nix {
        inherit (inputs.self) nixosModules;
        inherit pkgs;
      });
    });
    devShells = eachSystem (pkgs: import ./nix/devshells.nix pkgs);
    formatter = eachSystem (pkgs: pkgs.treefmt-wrapped);
    nixosModules = import ./nix/nixosModules inputs;
    overlays = import ./nix/overlays inputs;
    packages = eachSystem (pkgs: import ./nix/packages {inherit inputs pkgs;});
  };
}

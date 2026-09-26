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
      cloud-hypervisor-vsock = pkgs.testers.runNixOSTest (import ./nix/nixosTests/cloud-hypervisor-vsock.nix {
        inherit (inputs.self) nixosModules;
        inherit (inputs) nixpkgs;
        inherit pkgs;
      });
      vmspawn-tap = pkgs.testers.runNixOSTest (import ./nix/nixosTests/vmspawn-tap.nix {
        inherit (inputs) nixpkgs;
        inherit pkgs;
      });
      cloud-hypervisor-primitive = pkgs.testers.runNixOSTest (import ./nix/nixosTests/cloud-hypervisor-primitive.nix {
        inherit (inputs.self) nixosModules;
        inherit (inputs) nixpkgs;
        inherit pkgs;
      });
      host-network-eval = import ./nix/nixosTests/host-network-eval.nix {inherit pkgs;};
      host-network = pkgs.testers.runNixOSTest (import ./nix/nixosTests/host-network.nix {inherit pkgs;});
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

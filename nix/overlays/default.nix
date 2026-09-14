{self, ...}: {
  default = final: prev: let
    inherit (prev.stdenv.hostPlatform) system;
  in
    self.packages.${system};
}

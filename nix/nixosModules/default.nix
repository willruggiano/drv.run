inputs: {
  nix = import ./nix.nix inputs;
  guest = import ./guest inputs;
  host = import ./host inputs;
  localhost = ./localhost.nix;
}

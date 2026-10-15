inputs: {
  guest = import ./guest inputs;
  host = import ./host inputs;
  pi = import ./pi.nix inputs;
  localhost = ./localhost.nix;
}

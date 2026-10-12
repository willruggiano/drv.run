{determinate, ...}: {
  config,
  pkgs,
  ...
}: {
  imports = [determinate.nixosModules.default];
  # Nixd's module supplies nix.custom.conf, but socket activation alone does not
  # create nix.conf. Root's local-store/stdio clients never start that daemon.
  # Run before any services (especially Guest provisioning) can invoke Nix.
  system.activationScripts.determinate-nix-config = {
    deps = ["etc"];
    text = ''
      ${determinate.packages.${pkgs.stdenv.hostPlatform.system}.default}/bin/determinate-nixd \
        --nix-bin ${config.nix.package}/bin init --stop-after nix-configuration
    '';
  };
  nix.settings = {
    eval-cache = true;
    # Explicit: client-source defaults differ from the Nixd-managed defaults.
    lazy-trees = true;
    eval-cores = 0;
    # Retain NAR hashes so lock files remain portable to upstream Nix.
    lazy-locks = false;
  };
}

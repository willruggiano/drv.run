{pkgs}:
pkgs.stdenv.mkDerivation {
  pname = "drv-run-tap";
  version = "1";
  src = ./tap.c;
  dontUnpack = true;
  nativeBuildInputs = [pkgs.pkg-config];
  buildInputs = [pkgs.systemd];
  buildPhase = ''
    $CC -std=c17 -Wall -Wextra -Werror $(pkg-config --cflags libsystemd) \
      "$src" $(pkg-config --libs libsystemd) -o drv-run-tap
  '';
  installPhase = ''
    install -Dm755 drv-run-tap "$out/bin/drv-run-tap"
  '';
}

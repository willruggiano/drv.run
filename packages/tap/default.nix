{
  stdenv,
  pkg-config,
  systemd,
}:
stdenv.mkDerivation (finalAttrs: {
  name = "drv.run.tap";
  src = ./tap.c;
  dontUnpack = true;
  nativeBuildInputs = [pkg-config];
  env.NIX_CFLAGS_COMPILE = toString [
    "-std=c17"
    "-Wall"
    "-Wextra"
    "-Werror"
  ];
  buildInputs = [systemd];
  buildPhase = ''
    mkdir -p $out/bin/
    cc $src -o $out/bin/drv.run.tap
  '';
  meta = {
    description = "nsresourced TAP allocation into the microvm runner";
    mainProgram = finalAttrs.name;
  };
})

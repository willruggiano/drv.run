{
  stdenv,
  pkg-config,
  systemd,
}:
stdenv.mkDerivation (finalAttrs: {
  pname = "drv.run.tap";
  version = "0.1.0";
  src = ./tap.c;
  dontUnpack = true;
  env.NIX_CFLAGS_COMPILE = toString [
    "-std=c17"
    "-Wall"
    "-Wextra"
    "-Werror"
  ];
  nativeBuildInputs = [pkg-config];
  buildInputs = [systemd];
  buildPhase = ''
    mkdir -p $out/bin/
    cc $src -o $out/bin/${finalAttrs.pname}
  '';
  meta = {
    description = "nsresourced TAP allocation into the microvm runner";
    mainProgram = finalAttrs.pname;
  };
})

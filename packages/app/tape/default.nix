{
  app,
  chromium,
  nodejs,
  lib,
  writeShellApplication,
}:
writeShellApplication {
  name = "app-tape";
  runtimeEnv.CHROMIUM_BINARY = lib.getExe chromium;
  text = ''
    exec ${lib.getExe nodejs} ${app}/lib/app/tape/dist/main.js "$@"
  '';
  meta = {
    description = "Durable-native app presentation capture and replay over CDP";
    inherit (app.meta) platforms license;
  };
}

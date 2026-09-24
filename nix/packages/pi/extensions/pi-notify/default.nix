{
  lib,
  libnotify,
  runCommandLocal,
}:
runCommandLocal "pi-notify" {} ''
  mkdir -p "$out/extensions/pi-notify"
  substitute ${./index.ts} "$out/extensions/pi-notify/index.ts" \
    --replace-fail '"notify-send"' '"${lib.getExe libnotify}"'
  cp ${./README.md} "$out/extensions/pi-notify/README.md"
''

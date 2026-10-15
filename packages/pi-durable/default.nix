{
  lib,
  nodejs,
  runCommand,
  pi-node-modules,
}:
runCommand "pi-durable-${pi-node-modules.version}" {
  inherit (pi-node-modules) version;
  nativeBuildInputs = [nodejs];
  meta = {
    description = "A durable agent harness";
    license = lib.licenses.mit;
    platforms = ["x86_64-linux" "aarch64-linux"];
  };
} ''
  mkdir -p "$out/node_modules/@earendil-works"
  ln -s ${pi-node-modules}/packages/durable "$out/node_modules/@earendil-works/pi-durable"
  cd "$out"
  node --input-type=module -e 'import "@earendil-works/pi-durable"'
''

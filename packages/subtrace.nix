{
  buildGoModule,
  fetchFromGitHub,
  fetchpatch,
  ...
}:
buildGoModule (finalAttrs: {
  pname = "subtrace";
  version = "b390";
  src = fetchFromGitHub {
    owner = "subtrace";
    repo = "subtrace";
    rev = finalAttrs.version;
    hash = "sha256-80jWm/kuHmqAu0bitLcNFgZslGBEPrv+dZmFTj5g7qk=";
  };
  vendorHash = "sha256-a8D+kjGgI31Q78aAkvaedve0hUX3wZb8VbU1B4K/sPY=";
  patches = [
    (fetchpatch {
      url = "https://patch-diff.githubusercontent.com/raw/subtrace/subtrace/pull/307.patch";
      includes = ["cmd/run/fd/fd_test.go"];
      hash = "sha256-PuHQQh0CeUBiRof82Z2uYcwSMO8nEOPjVJjRABEt6Fc=";
    })
  ];
  ldflags = ["-X subtrace.dev/cmd/version.Release=${finalAttrs.version}"];
  postInstall = ''
    mv $out/bin/subtrace.dev $out/bin/subtrace
  '';
})

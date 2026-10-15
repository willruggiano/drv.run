{
  lib,
  treefmt,
  alejandra,
  oxfmt,
  prettier,
  shfmt,
  stylua,
  yamlfmt,
  ...
}:
treefmt.withConfig {
  runtimeInputs = [
    alejandra
    oxfmt
    prettier
    shfmt
    stylua
    yamlfmt
  ];
  settings.formatter = let
    f = command: includes: {
      inherit command;
      includes =
        if lib.isList includes
        then includes
        else [includes];
    };
  in {
    alejandra = f "alejandra" "*.nix";
    oxfmt = f "oxfmt" ["*.cjs" "*.mjs" "*.ts"];
    prettier =
      (f "prettier" ["*.json" "*.md"])
      // {
        options = ["--write" "--prose-wrap" "always"];
      };
    shfmt = (f "shfmt" "*.sh") // {options = ["-w"];};
    stylua = f "stylua" "*.lua";
    yamlfmt = f "yamlfmt" ["*.yaml" "*.yml"];
  };
}

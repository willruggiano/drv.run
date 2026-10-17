// v10 declares subpath modules in its root type definitions.
import type {} from "highlight.js";
import hljs from "highlight.js/lib/core.js";
import typescript from "highlight.js/lib/languages/typescript.js";
import javascript from "highlight.js/lib/languages/javascript.js";
import json from "highlight.js/lib/languages/json.js";
import bash from "highlight.js/lib/languages/bash.js";
import python from "highlight.js/lib/languages/python.js";
import nix from "highlight.js/lib/languages/nix.js";
import diff from "highlight.js/lib/languages/diff.js";
import css from "highlight.js/lib/languages/css.js";
import xml from "highlight.js/lib/languages/xml.js";
import rust from "highlight.js/lib/languages/rust.js";
import go from "highlight.js/lib/languages/go.js";
import sql from "highlight.js/lib/languages/sql.js";

for (const [name, language] of Object.entries({
  typescript,
  javascript,
  json,
  bash,
  python,
  nix,
  diff,
  css,
  xml,
  rust,
  go,
  sql,
}))
  hljs.registerLanguage(name, language);

export default hljs;

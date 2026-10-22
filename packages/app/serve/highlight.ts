// v10 declares subpath modules in its root type definitions.
import type {} from "highlight.js";
import core from "highlight.js/lib/core.js";

import bash from "highlight.js/lib/languages/bash.js";
import css from "highlight.js/lib/languages/css.js";
import diff from "highlight.js/lib/languages/diff.js";
import go from "highlight.js/lib/languages/go.js";
import javascript from "highlight.js/lib/languages/javascript.js";
import json from "highlight.js/lib/languages/json.js";
import nix from "highlight.js/lib/languages/nix.js";
import python from "highlight.js/lib/languages/python.js";
import rust from "highlight.js/lib/languages/rust.js";
import sql from "highlight.js/lib/languages/sql.js";
import typescript from "highlight.js/lib/languages/typescript.js";
import xml from "highlight.js/lib/languages/xml.js";

for (const [name, language] of Object.entries({
  bash,
  css,
  diff,
  go,
  javascript,
  json,
  nix,
  python,
  rust,
  sql,
  typescript,
  xml,
}))
  core.registerLanguage(name, language);

export default core;

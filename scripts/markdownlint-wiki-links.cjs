// Custom markdownlint rule: internal references between docs must use the
// [[file.md]] wiki-link form (see docs/rules/documentation.md), not a relative
// Markdown link to another .md file. External links and in-page anchors are fine.

module.exports = {
  names: ["docs-wiki-link"],
  description:
    "Internal doc references must use [[file.md]] wiki-links, not relative Markdown links",
  tags: ["links"],
  parser: "none",
  function: (params, onError) => {
    // A standard Markdown link whose target is a relative *.md path.
    const relMdLink = /\]\(\s*(?!https?:|#|mailto:)[^)]*?\.md(?:#[^)]*)?\s*\)/g;
    params.lines.forEach((line, index) => {
      for (const match of line.matchAll(relMdLink)) {
        onError({
          lineNumber: index + 1,
          detail: "Use [[file.md]] wiki-link syntax for internal references.",
          context: match[0],
        });
      }
    });
  },
};

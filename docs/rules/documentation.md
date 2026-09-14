---
paths:
  - "**/*.md"
---

# Documentation conventions

- Use repository-relative wiki links, including `.md`: `[[docs/extensions.md]]`.
- Use standard Markdown links for external URLs.
- Use one H1, do not skip heading levels, and label every fenced code block.
- One topic per file. Link to the source of truth instead of duplicating it.
- Keep only concise, verifiable information. Remove stale content and update its
  callers; do not leave migration notes or tombstones.
- `markdownlint-cli2` is the source of truth for markdown strictness.

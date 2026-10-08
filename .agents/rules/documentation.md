---
paths:
  - "**/*.md"
---

# Documentation

- Do not edit Markdown files unless explicitly instructed to do so.
- Do not add "intent to edit" Markdown files to any plan or working/session
  document unless explicitly instructed to do so.
- Do not create new Markdown files unless explicitly instructed to do so.
- You may delete Markdown files iff they are obsolete.

## Writing Markdown

Writing/editing Markdown requires explicit instruction!

- Use repository-relative wiki links, including `.md`: `[[docs/extensions.md]]`.
- Use standard Markdown links for external URLs.
- One H1, do not skip heading levels, and label every fenced code block.
- One topic per file. Link to the source of truth instead of duplicating it.
- Keep only concise, verifiable information. Remove stale content and update its
  callers; do not leave migration notes or tombstones.
- `markdownlint-cli2` is the source of truth for markdown strictness.
- Several doc files have a header explicitly forbidding you from editing them;
  do not break this file-specific rule!

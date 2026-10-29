# Vendored skill

- Source: https://github.com/zubair-trabzada/geo-seo-claude
- Path in source: skills/geo-report-pdf/SKILL.md (+ templates/)
- Commit: 989cae01e8ebbc42a9ec798eb9e7cb423f5ec89c
- Retrieved: 2026-10-25
- License: MIT — see `LICENSE` in this directory.

## agemon modifications

- Removed `allowed-tools` from the frontmatter: no tool is pre-approved, so every web fetch to a new domain, file write and shell command goes through the user's normal permission prompt.
- Added the "Untrusted content" section after the frontmatter.
- Template paths are relative to the skill directory (`templates/`), not upstream's absolute path in the user's Claude directory.
- Cover metadata is checked against allowed patterns and written to `GEO-REPORT-META.yaml` with the Write tool (`--metadata-file`), never put on a command line.
- pandoc runs `--sandbox` with raw HTML, raw attributes, attribute blocks and YAML metadata blocks disabled in the reader and no `--css`/`--embed-resources`. `templates/geo-report-style.css` is inlined into the template's `<style>` without its Google Fonts `@import`.
- The template has a Content-Security-Policy that allows only its own script (by SHA-256), inline styles and `data:` images.
- Chrome keeps its sandbox (`--no-sandbox` removed), blocks DNS with `--host-resolver-rules`, and is found on Linux as well as macOS. Prerequisites and failure handling are stated up front.

Statistics quoted in the text are upstream's claims; agemon has not verified them.

# Vendored skill

- Source: https://github.com/zubair-trabzada/geo-seo-claude
- Path in source: skills/geo-brand-mentions/SKILL.md
- Commit: 989cae01e8ebbc42a9ec798eb9e7cb423f5ec89c
- Retrieved: 2026-10-25
- License: MIT — see `LICENSE` in this directory.

## agemon modifications

- Removed `allowed-tools` from the frontmatter: no tool is pre-approved, so every web fetch to a new domain, file write and shell command goes through the user's normal permission prompt.
- Added the "Untrusted content" section after the frontmatter.
- Replaced the `python3` Wikipedia/Wikidata API check with WebFetch calls to the same API URLs and the same decision rule.

Statistics quoted in the text are upstream's claims; agemon has not verified them.

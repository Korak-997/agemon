# Vendored skill

- Source: https://github.com/zubair-trabzada/geo-seo-claude
- Path in source: skills/geo-schema/SKILL.md
- Commit: 989cae01e8ebbc42a9ec798eb9e7cb423f5ec89c
- Retrieved: 2026-10-25
- License: MIT — see `LICENSE` in this directory.

## agemon modifications

- Removed `allowed-tools` from the frontmatter: no tool is pre-approved, so every web fetch to a new domain, file write and shell command goes through the user's normal permission prompt.
- Added the "Untrusted content" section after the frontmatter.
- Replaced `fetch_page.py` with the same fixed, user-approved read-only `curl` command as `geo-technical` (without its markdown-negotiation variant), because WebFetch drops the `<head>` where JSON-LD lives.
- Generated JSON-LD escapes `</` in string values.

Statistics quoted in the text are upstream's claims; agemon has not verified them.

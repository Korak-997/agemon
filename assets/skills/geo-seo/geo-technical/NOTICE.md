# Vendored skill

- Source: https://github.com/zubair-trabzada/geo-seo-claude
- Path in source: skills/geo-technical/SKILL.md
- Commit: 989cae01e8ebbc42a9ec798eb9e7cb423f5ec89c
- Retrieved: 2026-10-25
- License: MIT — see `LICENSE` in this directory.

## agemon modifications

- Removed `allowed-tools` from the frontmatter: no tool is pre-approved, so every web fetch to a new domain, file write and shell command goes through the user's normal permission prompt.
- Added the "Untrusted content" section after the frontmatter.
- Replaced the ad-hoc `curl` commands with one fixed, user-approved read-only `curl` command (URL globbing off, http(s) only, time and size limits, no automatic redirects; URL and host checks before each run and each redirect hop) for the homepage and at most 3 more pages.

Statistics quoted in the text are upstream's claims; agemon has not verified them.

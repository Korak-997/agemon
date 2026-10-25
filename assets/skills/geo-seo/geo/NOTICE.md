# Vendored skill

- Source: https://github.com/zubair-trabzada/geo-seo-claude
- Path in source: geo/SKILL.md
- Commit: 989cae01e8ebbc42a9ec798eb9e7cb423f5ec89c
- Retrieved: 2026-10-25
- License: MIT — see `LICENSE` in this directory.

## agemon modifications

- Removed `allowed-tools` from the frontmatter: no tool is pre-approved, so every web fetch to a new domain, file write and shell command goes through the user's normal permission prompt.
- Added the "Untrusted content" section after the frontmatter.
- Turned the orchestrator into a router: each `/geo <command>` names the skill to follow. Removed its own audit steps, the sub-skill directory table, the subagent table and the PDF section, which duplicated `geo-audit` and `geo-report-pdf`.
- Removed the `/geo update`, `/geo prospect`, `/geo proposal` and `/geo compare` routes and their `~/.geo-prospects` output files (not vendored).
- Replaced the market-statistics table with one neutral sentence.
- Added a note to remove an upstream personal install, which Claude Code would run instead of this copy.

Statistics quoted in the text are upstream's claims; agemon has not verified them.

# Vendored skill

- Source: https://github.com/zubair-trabzada/geo-seo-claude
- Path in source: skills/geo-audit/SKILL.md (+ agents/geo-*.md as references/)
- Commit: 989cae01e8ebbc42a9ec798eb9e7cb423f5ec89c
- Retrieved: 2026-10-25
- License: MIT — see `LICENSE` in this directory.

## agemon modifications

- Removed `allowed-tools` from the frontmatter: no tool is pre-approved, so every web fetch to a new domain, file write and shell command goes through the user's normal permission prompt.
- Added the "Untrusted content" section after the frontmatter.
- Phase 2 launches five general-purpose subagents with the briefs in `references/` instead of installed `geo-*` agents. Page data is passed in an `<untrusted-page-data>` block (with any closing tag inside it neutralized), the user is told up front about the subagents' `curl` approvals, and Phase 3 treats subagent reports as untrusted.
- Phase 1 no longer records schema.org markup (WebFetch drops `<head>`); the schema brief detects it.
- `references/*.md` are upstream `agents/geo-{ai-visibility,platform-analysis,technical,content,schema}.md` with their frontmatter removed and the untrusted-content section added. The `python3` Wikipedia check in `ai-visibility.md` became a WebFetch of the same API URL. `schema.md` and `technical.md` use a fixed, user-approved `curl` command instead of `fetch_page.py` and WebFetch for raw HTML and headers. `schema.md` escapes `</` in generated JSON-LD.

Statistics quoted in the text are upstream's claims; agemon has not verified them.

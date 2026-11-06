# Vendored skill

- Source: https://github.com/vercel-labs/writing-guidelines
- Path in source: command.md
- Commit: 83e2316b034cf572400513538e4e4da01c4cc742
- Retrieved: 2026-11-05
- License: MIT — see `LICENSE` in this directory.

## agemon modifications

- `references/guidelines.md` is upstream's `command.md` with its frontmatter and the `$ARGUMENTS` line removed. The rules and output format are unchanged.
- `SKILL.md` is agemon's own wrapper. Instead of fetching the guidelines from a URL, it reads `references/guidelines.md`.
- Judgement call: the wrapper keeps the `name` and the short `description` of the skill agemon installed before, so existing installs are recognised and the skill still routes on the same phrases. That text comes from https://github.com/vercel-labs/agent-skills at commit 063bee94c3f4df8453406c830b0a7df0f2860278 (path `skills/writing-guidelines/SKILL.md`). That repository's README states MIT, but it has no LICENSE file at that commit, so the licence for this carried-over text is stated, not shipped. The rest of the wrapper is written by agemon.
- Keeps the name `writing-guidelines` rather than an `agemon-*` name, so existing installs are recognised and can be updated.

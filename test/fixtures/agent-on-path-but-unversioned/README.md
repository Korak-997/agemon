# agent-on-path-but-unversioned fixture

A repository configured for Claude Code (`CLAUDE.md` + `.claude/settings.json`).
Paired with a fake `PATH` in tests that provides a `claude` binary which exits
0 but reports output the version parser can't recognize — asserting the
adapter stays capped at `configured` rather than being promoted to
`installed` on an unparseable probe result.

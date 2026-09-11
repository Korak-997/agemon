# all-agents-configured-and-installed fixture

A repository configured for all three ecosystems: `CLAUDE.md` +
`.claude/settings.json`, `GEMINI.md` + `.gemini/settings.json`, and
`.github/copilot-instructions.md`. Paired with a fake `PATH` in tests that
provides `claude` and `gemini` binaries reporting a version, so all three
adapters report `configured: true` and Claude/Gemini report `installed`
(Copilot stays at `configured`, since it has no standalone executable).

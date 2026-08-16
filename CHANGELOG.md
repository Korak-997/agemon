# agemon

## 0.1.0

### Minor Changes

- Initial public release: a plugin-orchestrated CLI (`agemon install` / `agemon nuke`) that
  bootstraps and reversibly manages an AI coding agent environment in a repository —
  `code-review-graph` install/build, a `systemd --user` daemon for it, a bundled skills
  install, GitHub workflow scaffolding, global CLI tool install, and consolidated agent
  rule files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursorrules`, `.windsurfrules`) —
  backed by an idempotent `.agemon/state.json` manifest and full reversibility guarantees.

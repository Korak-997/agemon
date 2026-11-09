# Vendored skill

- Source: https://github.com/ayghri/i-have-adhd
- Path in source: skills/i-have-adhd
- Commit: 1ecea1993b7fce257ffbd686c070948b5e07eda6
- Retrieved: 2026-11-05
- License: MIT — see `LICENSE` in this directory.

## agemon modifications

- Renamed from `i-have-adhd` to `agemon-adhd`, including the `/i-have-adhd` command it tells you to run.
- Removed the `license` and `metadata` frontmatter keys. `disable-model-invocation` stays, so the mode only starts when you ask for it.
- Left out upstream's `agents/` configuration for other tools and its optional always-on `SessionStart` hook: bundled skills cannot ship hooks.

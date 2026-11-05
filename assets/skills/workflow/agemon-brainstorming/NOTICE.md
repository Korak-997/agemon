# Vendored skill

- Source: https://github.com/obra/superpowers
- Path in source: skills/brainstorming
- Commit: 22f0b463e7a5e579904dd6211a520321035526f7
- Retrieved: 2026-11-05
- License: MIT — see `LICENSE` in this directory.

## agemon modifications

- Renamed from `brainstorming` to `agemon-brainstorming`, and updated references to upstream's other skills to their agemon names (`systematic-debugging` is `agemon-root-cause`, `verification-before-completion` is `agemon-verify-before-done`, both in the `self-review` group).
- Moved working files from `.superpowers/` to `.agemon-workflow/` and documents from `docs/superpowers/` to `docs/`.
- One of several skills cherry-picked from the superpowers framework; its `using-superpowers` bootstrap and session hook are not vendored, so nothing forces these skills to load.
- Left out the optional visual companion (`visual-companion.md`, `scripts/`) and every mention of it: it starts a local web server, and its page loads a logo from upstream's website, which reports the version in use.

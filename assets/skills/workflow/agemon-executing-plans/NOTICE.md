# Vendored skill

- Source: https://github.com/obra/superpowers
- Path in source: skills/executing-plans
- Commit: 22f0b463e7a5e579904dd6211a520321035526f7
- Retrieved: 2026-11-05
- License: MIT — see `LICENSE` in this directory.

## agemon modifications

- Renamed from `executing-plans` to `agemon-executing-plans`, and updated references to upstream's other skills to their agemon names (`systematic-debugging` is `agemon-root-cause`, `verification-before-completion` is `agemon-verify-before-done`, both in the `self-review` group).
- Moved working files from `.superpowers/` to `.agemon-workflow/` and documents from `docs/superpowers/` to `docs/`.
- One of several skills cherry-picked from the superpowers framework; its `using-superpowers` bootstrap and session hook are not vendored, so nothing forces these skills to load.
- Removed the pointer to upstream's per-platform references, which are not vendored.
- Points at `code-reviewer.md` in `agemon-subagent-driven-development`.

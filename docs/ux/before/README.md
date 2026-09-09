# UX baseline — before the terminal overhaul

Captured at the start of the terminal UX overhaul (see `plan.md`) as the reference
point for the after/ captures Phase 6 will add.

| File | Invocation | Notes |
|------|------------|-------|
| `install-run.txt` | `agemon --yes` on a clean repo, fake backends | full non-interactive install + summary box |
| `quiet-run.txt` | `agemon --yes --quiet` on a clean repo, fake backends | summary box only |

Both were produced with `AGEMON_FAKE_SUBPROCESS`/`AGEMON_FAKE_SERVICES` against the
`clean-repo` fixture, `NO_COLOR=1`, piped (non-TTY). Resolved binary paths in the
`Binary check:` lines are redacted to `<path>`.

The interactive TTY run — the double-printed gate prompt from the original issue —
is not reproducible without a real terminal; its before/after is written out in
`plan.md` Appendix A.

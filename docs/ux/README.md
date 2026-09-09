# UX before/after — terminal overhaul

Captures for the non-interactive contract described in `plan.md`. Same
invocations, same fixture (`clean-repo`), same fake backends, `NO_COLOR=1`,
piped (non-TTY); only the code under test differs.

| File | Invocation | Before → After |
|------|------------|-----------------|
| `install-run.txt` | `agemon --yes` | 5 `Binary check: … present (<path>)` lines → 1 `N/N tools present — …` line ([Phase 4](../../plan.md#phase-4--framing--structure)); raw capability ids (`crg`, `daemon`, `master-prompt`) → human labels (`code-review-graph`, `Background service`, `Instruction files`) via `src/ui/labels.ts` |
| `quiet-run.txt` | `agemon --yes --quiet` | same capability-label change; summary box shape unchanged |

The interactive TTY run — the double-printed gate prompt from the original
issue, now a single clack `select` — isn't reproducible without a real
terminal; its before/after is written out in `plan.md` Appendix A.

This delta is the intentional, documented non-interactive output change
called out in Phase 4 and pinned everywhere else by
`test/integration/non-interactive-output.test.ts`.

# Phase review records

Every phase of [`docs/plan.md`](../plan.md) passes two review gates, and each phase leaves one
record here: `pNN-<slug>.md`, started from [`_template.md`](_template.md). The full process is
in §2 of the plan; this page is the short form.

## The seven steps

1. **Discover** — code-review-graph first, re-locate every file/line the phase cites, run the
   baseline (`npm run lint && npm run typecheck && npm test && npm run build && npm run smoke`).
   A red baseline stops the phase.
2. **Design gate** — write the design note (problem, approach, rejected alternatives, public
   surface changes, migration, threat model delta, planned tests). A **tech-lead** and a
   **security** reviewer, each in a fresh context, review it. No code until both show zero
   open Blocker/High.
3. **Test first** — write the planned tests and see them fail for the right reason.
4. **Implement** — surgical, file by file, conventional commits on `v6`.
5. **Verify** — paste the output of:
   ```
   npm run lint
   npm run typecheck
   npm test
   npm run build
   npm run smoke
   npm run sandbox -- run clean-repo --dry-run
   npm run sandbox -- roundtrip clean-repo
   ```
   plus any phase-specific checks.
6. **Result gate** — fresh-context tech-lead and security reviews of
   `git diff <phase base>..HEAD`, using the checklists in §2 of the plan. Fix, then re-review
   the changed parts.
7. **Record and close** — complete the record, sync Appendix C of the plan, tick the phase,
   commit, then push `v6`.

## Severity and gate rule

| Severity | Meaning | Gate effect |
|---|---|---|
| Blocker | Data loss, RCE, privilege escalation, broken install/uninstall, wrong result in the main path | Fix in this phase |
| High | Realistic failure or exploit path, missing test for an acceptance criterion | Fix in this phase |
| Medium | Edge-case bug, unclear UX, maintainability debt introduced by this phase | Fix, or accept with a written reason |
| Low / Nit | Style, naming, docs polish, pre-existing issues | Fix if trivial, otherwise log it |

A gate passes with zero open Blocker/High, every Medium fixed or accepted with a reason, and
step 5 green on the final commit.

## Logging findings

`improvements.md` is local-only (git-ignored). When a record logs a finding there, copy the
finding's full text into the record so the tracked history keeps it.

**Exception: unfixed security findings.** A `[SECURITY]` finding discovered after P0 that is
not fixed in the phase that found it goes into `improvements.md` (or a private GitHub
security advisory). The committed record, and its row in Appendix C of the plan, name it
**by title and phase only** (no location) until a fix ships; then both get the full text.

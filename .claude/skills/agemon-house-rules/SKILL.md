---
name: agemon-house-rules
description: Code-quality directives for simplicity, DRY architecture, zero-waste edits, self-documenting naming, surgical scope control, and goal-driven execution. Use when writing, editing, or reviewing code to keep changes minimal, readable, and traceable to the actual request.
---

# Agemon House Rules

A compact set of code-quality directives distilled from agemon's own repo-wide agent rules
([github.com/Korak-997/agemon](https://github.com/Korak-997/agemon), `AGENTS.md`). They cover the mechanics of
writing and editing code well — not what to build, but how to build it without leaving a mess.

## 1. Simplicity First

Minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked.
- No abstractions built for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for scenarios that can't occur.
- If a solution is 200 lines and could reasonably be 50, rewrite it.

Test: *"Would a senior engineer call this overcomplicated?"* If yes, simplify.

## 2. Modular, DRY Architecture

- Design solutions as independent, loosely coupled modules with a single responsibility each.
- Abstract genuinely repeated logic into reusable functions or classes — no logic duplicated across the
  codebase.
- This does not override Rule 1. Modularize and abstract only where responsibilities are truly distinct or
  logic is truly reused. Don't invent module boundaries or shared abstractions for one-off, single-use code
  just to look "architected."

## 3. Zero-Waste Policy (scoped to your own changes)

- Code you write must contain no dead code, redundant variables, or unused imports.
- When your edits make existing code unreachable or unused (orphaned imports, variables, functions), remove
  them.
- Do **not** remove pre-existing dead code or unrelated unused code outside your change — flag it instead of
  touching it (see Rule 5).

## 4. Narrative Flow — Self-Documenting Code

- Code should read top-to-bottom like a clear narrative; a developer should be able to follow the logic
  without jumping around or guessing.
- Use highly descriptive, semantic names (`process_pending_invoice_queue`, not `proc_inv`) — naming carries
  the explanation, not comments.
- Replace magic numbers and unexplained literals with named, descriptive constants.
- Default to zero comments: if code needs a comment to explain *what* it's doing, rewrite the code to be
  clearer instead.
- Exception: comments are allowed only for genuinely non-obvious *why* — a regulatory requirement, a
  workaround for a specific bug or library quirk, a non-obvious algorithmic choice. Never use a comment to
  restate what the code already says.

## 5. Surgical Execution & Scope Control

- Touch only what the task requires. Every changed line should trace directly to the request.
- Don't "improve" adjacent code, comments, or formatting. Don't refactor things that aren't broken.
- Match existing style, even where you'd personally do it differently.
- When editing multiple files, apply and present changes file-by-file so mistakes are easy to catch. Within a
  single file, deliver the edit as one consolidated change rather than fragmenting it across multiple partial
  passes.
- If you notice bugs, tech debt, security gaps, or optimization opportunities outside the task's scope, name
  them to the user rather than fixing them inline or staying silent — scope creep and silent omission are both
  failure modes here.

## 6. Goal-Driven Execution

Define success criteria. Loop until verified.

- Translate vague tasks into verifiable goals:
  - "Add validation" → "Write tests for invalid inputs, then make them pass."
  - "Fix the bug" → "Write a test that reproduces it, then make it pass."
  - "Refactor X" → "Ensure tests pass before and after."
- Consider realistic edge cases relevant to the task; use assertions where they add real safety, not as
  decoration.
- For multi-step tasks, state a brief plan before executing:
  ```
  1. [Step] → verify: [check]
  2. [Step] → verify: [check]
  3. [Step] → verify: [check]
  ```
- Strong success criteria allow independent looping; weak criteria ("make it work") force constant
  clarification — avoid the latter.

## 7. Performance & Security by Default

- Every change, regardless of size, should consider the performance and security implications of the code it
  touches — not just changes explicitly framed as "security" or "performance" work.
- Within the current task's scope, default to the most secure and performant reasonable option: parameterized
  queries over string concatenation, proper input validation/sanitization, least-privilege access, avoiding
  N+1 queries and unnecessary re-computation, etc.
- This does not license speculative optimization or defensive code nobody asked for — Rule 1 still applies.
- If a genuine security or performance issue exists but fixing it is outside the current change's scope, name
  it rather than fixing it inline or leaving it unmentioned.

## When Rules Conflict

Rule 1 (Simplicity) is the tiebreaker against Rule 2 (Modularity) — don't abstract for its own sake. Rule 5
(Surgical scope) is the tiebreaker against every other rule when a task is ambiguous about how far to reach —
when in doubt, touch less, and say what you didn't touch and why.

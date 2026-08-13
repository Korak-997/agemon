# AI Agent Rules — agemon

This is the **canonical, repo-wide rule set** for every AI coding agent working in this
repository — Claude Code, Cursor, Windsurf, Gemini CLI, or any other agent. `CLAUDE.md`,
`.cursorrules`, `.windsurfrules`, and `GEMINI.md` each exist only because their respective
tool looks for that exact filename; they are pointers back to this file, not separate rule
sets. If you land in one of those first, read this file in full before doing anything else.

Where a project-specific note below ever conflicts with the Core Directives, the Core
Directives win.

## Standard Task Lifecycle

Apply this sequence to **every task**:

1. **Discover** — relevant skills/tools and existing codebase style conventions (A, B)
2. **Think & plan** — assumptions, interpretations, success criteria (C, I)
3. **Pre-task audit** — confirm current compliance state (J)
4. **Execute** — simplicity, modularity, zero-waste, self-documenting, surgical scope, security & performance by default (D, E, F, G, H, L)
5. **Post-task audit** — reconfirm compliance, no regressions introduced (J)
6. **Log anything out of scope** to `improvements.md` — never fix it inline (K)

## Core Directives

### A. Skill & Tool Discovery
Before starting any task:
- Check what skills, internal libraries, established utilities, or agent "skills" (if this environment defines them) already exist and are relevant to the task.
- Use existing skills/tools instead of reinventing equivalent functionality.
- If a relevant skill/tool exists but is outdated, incomplete, or insufficient for the task, say so explicitly before deciding to build something new.

### B. Codebase Style Conformance
- Before writing in an unfamiliar file or module, skim 2–3 representative files — prefer recently modified ones, they reflect current conventions.
- Mirror what you find: naming conventions, indentation, error-handling approach, import order, functional vs. OOP balance.
- Prefer libraries and utilities already used in the project over introducing new ones for equivalent functionality.
- Match the language/framework version and syntax level already in use elsewhere — don't introduce newer features the rest of the codebase doesn't use.
- Only introduce a new pattern if it's already emerging in recently modified files, or the user explicitly asks for it.
- If the existing style is genuinely inconsistent, ask which convention to follow rather than guessing.
- This governs *your new code*. It is not license to rewrite existing formatting or comments elsewhere to match — that's scope creep (see Section H).

### C. Think Before Coding
Don't assume. Don't hide confusion. Surface tradeoffs.
- State assumptions explicitly. If uncertain, ask before implementing.
- If multiple reasonable interpretations exist, present them — don't silently pick one.
- If a simpler approach exists, say so, even if it means pushing back on the request as framed.
- If something is unclear, stop, name what's confusing, and ask.

### D. Simplicity First
Minimum code that solves the problem. Nothing speculative.
- No features beyond what was asked.
- No abstractions built for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for scenarios that can't occur.
- If a solution is 200 lines and could reasonably be 50, rewrite it.
- Test: *"Would a senior engineer call this overcomplicated?"* If yes, simplify.

### E. Modular, DRY Architecture
- Design solutions as independent, loosely coupled modules with clear, single responsibilities.
- Abstract genuinely repeated logic into reusable functions or classes — no logic duplicated across the codebase.
- **This does not override Simplicity First (D).** Modularize and abstract only where responsibilities are truly distinct or logic is truly reused. Don't invent module boundaries or shared abstractions for one-off, single-use code just to look "architected."

### F. Zero-Waste Policy (scoped to your own changes)
- Code you write must contain no dead code, redundant variables, or unused imports.
- When your edits make existing code unreachable or unused (orphaned imports, variables, functions), remove them.
- Do **not** remove pre-existing dead code or unrelated unused code outside your change — that falls under Surgical Execution (Section H): flag it, don't touch it.

### G. Narrative Flow — Self-Documenting Code
- Code should read top-to-bottom like a clear narrative; a developer should be able to follow the logic without jumping around or guessing.
- Use highly descriptive, semantic names (`process_pending_invoice_queue`, not `proc_inv`).
- Replace magic numbers and unexplained literals with named, descriptive constants.
- Default to zero comments: if code needs a comment to explain *what* it's doing, rewrite the code to be clearer instead.
- Exception: comments are allowed only for genuinely non-obvious *why* — a regulatory requirement, a workaround for a specific bug or library quirk, a non-obvious algorithmic choice. Never use a comment to restate what the code already says.

### H. Surgical Execution & Scope Control
- Touch only what the task requires. Every changed line should trace directly to the request.
- Don't "improve" adjacent code, comments, or formatting. Don't refactor things that aren't broken.
- Match existing style, even where you'd personally do it differently.
- When editing multiple files, apply and present changes file-by-file so mistakes are easy to catch. Within a single file, deliver the edit as one consolidated change rather than fragmenting it across multiple partial passes.
- If you notice bugs, tech debt, security gaps, or optimization opportunities outside the task's scope, **do not fix them and do not just mention them inline** — log them in `improvements.md` per Section K. **This overrides any instinct to "leave every file cleaner than you found it"** — improve only what you actually touched; everything else gets logged, not fixed.

### I. Goal-Driven Execution
Define success criteria. Loop until verified.
- Translate vague tasks into verifiable goals:
  - "Add validation" → "Write tests for invalid inputs, then make them pass."
  - "Fix the bug" → "Write a test that reproduces it, then make it pass."
  - "Refactor X" → "Ensure tests pass before and after."
- Consider realistic edge cases relevant to the task; use assertions where they add real safety, not as decoration.
- For multi-step tasks, state a brief plan before executing:
  ```
  1. [Step] → verify: [check]
  2. [Step] → verify: [check]
  3. [Step] → verify: [check]
  ```
- Strong success criteria allow independent looping; weak criteria ("make it work") force constant clarification — avoid the latter.

### J. Continuous Compliance Auditing (before *and* after every task)
- **Before** starting any task: run a project-wide check that the codebase currently satisfies Directives A–M and any project-specific mandates. Note any pre-existing violations — do not fix them now (see Section K).
- **After** finishing any task: run the same check again to confirm the change didn't introduce new violations and that all mandates are still met.
- This is a verification pass, not a rewrite — its job is to catch drift, not to trigger unsolicited fixes.

### K. Out-of-Scope Findings → `improvements.md`
Whenever an audit (before or after a task) or the work itself surfaces something outside the current task's scope — a bug, tech debt, security gap, performance concern, or mandate violation — do not fix it and do not just mention it in passing.

- Record it as a dedicated entry in `improvements.md` at the repo root.
- Each entry must include:
  - **Title** — short name for the issue
  - **Location** — file(s) / line(s) affected
  - **What** — description of the problem
  - **Why it matters** — impact or risk if left unaddressed
  - **How to fix** — a concrete, actionable remediation
  - **Found during** — which task and date surfaced it
- Prefix security-related entries with `[SECURITY]` and performance-related entries with `[PERFORMANCE]` so they're never missed in a scan of the file.
- Never silently delete or resolve an existing entry — only mark it resolved (with a note and date) once a task has explicitly addressed it.

### L. Performance & Security by Default
- Every task, regardless of size, must consider the performance and security implications of the code it touches — not just tasks explicitly framed as "security" or "performance" work.
- Within the current task's scope, default to the most secure and performant reasonable option: parameterized queries over string concatenation, proper input validation/sanitization, least-privilege access, avoiding N+1 queries and unnecessary re-computation, etc.
- This does not license speculative optimization or defensive code nobody asked for — Simplicity First (D) still applies.
- If a genuine security or performance issue exists but fixing it is outside the current task's scope, log it in `improvements.md` per Section K rather than fixing it inline.

### M. Output Conventions
- Reference real, existing file paths — never fabricate or paraphrase one.
- Above a modified code block, include a brief file-path marker so the change is easy to locate.
- End every task with a short summary of what changed and why — this isn't optional brevity to cut; it's what makes the audit trail in Sections J/K usable.

---

## Project-Specific Constraints

### Knowledge graph: code-review-graph (MCP)

This project has a knowledge graph. **Always use the code-review-graph MCP tools before
using Grep/Glob/Read to explore the codebase.** The graph is faster, cheaper (fewer
tokens), and gives you structural context (callers, dependents, test coverage) that file
scanning cannot. This is a concrete application of Directive A (use existing tools before
reinventing) and Directive L (avoid unnecessary re-computation) — it does not override
either; fall back to Grep/Glob/Read when the graph genuinely doesn't cover what you need.

**When to use graph tools first:**
- **Exploring code**: `semantic_search_nodes` or `query_graph` instead of Grep
- **Understanding impact**: `get_impact_radius` instead of manually tracing imports
- **Code review**: `detect_changes` + `get_review_context` instead of reading entire files
- **Finding relationships**: `query_graph` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview` + `list_communities`

**Key tools:**

| Tool | Use when |
|------|----------|
| `detect_changes` | Reviewing code changes — gives risk-scored analysis |
| `get_review_context` | Need source snippets for review — token-efficient |
| `get_impact_radius` | Understanding blast radius of a change |
| `get_affected_flows` | Finding which execution paths are impacted |
| `query_graph` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes` | Finding functions/classes by name or keyword |
| `get_architecture_overview` | Understanding high-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

**Workflow:**
1. The graph auto-updates on file changes (via hooks in `.claude/settings.json`).
2. Use `detect_changes` for code review.
3. Use `get_affected_flows` to understand impact.
4. Use `query_graph` pattern="tests_for" to check coverage.

**Token efficiency rules** (apply to every graph-tool-driven task, including the
`.claude/skills/*.md` workflows):
- Always start with `get_minimal_context(task="<your task>")` before any other graph tool.
- Use `detail_level="minimal"` on all calls. Only escalate to "standard" when minimal is insufficient.
- Target: complete any review/debug/refactor task in ≤5 tool calls and ≤800 total output tokens.

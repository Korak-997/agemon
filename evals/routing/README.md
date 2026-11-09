# Subagent routing eval

Measures whether agemon's subagent routing saves money without losing quality. It decides whether
the routing rule and role agents stay, and whether the settings default gets built. Nothing here
ships in the npm package.

## Arms

All arms run at one session model (Opus) and one effort, with the rules installed the way agemon
installs them: the agent-rules block in `AGENTS.md` and a pointer in `CLAUDE.md`.

- **N**: no routing. The same rules with the `Subagent Models` section removed, and no role agents.
- **R**: the rule, plus `agemon-scout` and `agemon-worker` in `.claude/agents/`.
- **RD**: R plus `CLAUDE_CODE_SUBAGENT_MODEL=sonnet` in the fixture's `.claude/settings.json`.

The rule, role agents and rules block are rendered from the current `src/`, so a results file holds
what `agemonCommit` shipped, plus any uncommitted edits to them. The `workflow` skills that ship
alongside the role agents are not installed, so the routing is the only difference between arms.

## Tasks

`base/` is one small invented codebase, large enough that delegating is reasonable. Each task in
`tasks/` adds an `overlay/` on top of it, a `prompt.md` and a `task.json` that names its grader. No
grader uses an LLM, and neither prompts nor fixtures mention subagents or models.

| Task | Kind | Passes when |
|---|---|---|
| `read-refund-share` | read-only | the reply's only `path#function` token is the right one |
| `read-oversize-fee` | read-only | same, with decoys that share the word "oversize" |
| `mech-reports` | mechanical, full spec | all tests pass |
| `mech-rename-account` | mechanical, full spec | all tests pass |
| `bug-invoice-total` | bug across three files | all tests pass |
| `review-split-dispatch` | review of a diff | the reply names a line of the planted bug as `file:line` |

`test/` is restored from the fixture before grading, so editing or deleting a test cannot pass.

## What counts

- **Cost** is the CLI's `total_cost_usd`, which includes subagents and is priced at API list prices
  whatever the plan. `costByModel` comes from `modelUsage`.
- **A timed-out or over-budget run fails, and its cost still counts.** A killed run has no result
  event, so it is charged its whole budget and marked `costIsCapEstimate`.
- **A run that hits the turn limit** is still graded on what it left behind.
- **A usage limit or an auth failure** stops the batch and records nothing, so it can resume.
- **`agentCallsWithModel`** counts Agent calls that pass `model`. **`agentCallsToRoleAgents`** counts
  calls to a pinned role agent. Either one means the agent chose a tier.

## Running

Each command runs the next batch of unfinished cells and adds it to the results file for that label.
Runs use the logged-in Claude plan. The script refuses to start if `ANTHROPIC_API_KEY` or
`CLAUDE_CODE_SUBAGENT_MODEL` is set.

```sh
npm run routing-eval -- --label smoke --tasks mech-rename-account --repeats 1 --limit 3
npm run routing-eval -- --label full --limit 6
```

Results go to `results/<YYYY-MM-DD>-<label>.json`. Transcripts sit beside them and stay local.

## Pass rule

Per arm against N: **at most 1 fewer passing run out of 12, and total cost at least 20% lower.**

- R passes: keep the rule and role agents.
- R fails: take the numbers to the owner, with a recommendation to remove them.
- RD beats R on cost and also passes: build the settings default.
- RD does not beat R: skip it and record why.

Results are **indicative**. 12 runs per arm can catch only large effects, and a null result means
"no large effect". Make no savings claim beyond the numbers below.

## Re-run on

Any major model or price change, because both the prices and the models' behaviour feed the result.

## Results

**2026-11-06, `results/2026-11-06-full.json`. Indicative.** Claude Code 2.1.318, Opus 5.5, default
effort, commit `df6726b`, $5 cap per run. 36 runs, $9.13 at API list prices. The smoke run and one
forced-delegation probe, outside the 36, added $1.24.

| Arm | Passed | Cost | Against N | Turns | Agent calls | Pass rule |
|---|---|---|---|---|---|---|
| N | 12/12 | $3.29 | | 264 | 0 | |
| R | 12/12 | $2.92 | -11.2% | 254 | 0 | **fails**: under 20% lower |
| RD | 12/12 | $2.93 | -10.9% | 258 | 0 | **fails**: under 20% lower, and does not beat R |

**This run did not test routing.** No arm started a subagent, so nearly all the spend in every arm
was on Opus, and no model choice took place. The share of Agent calls naming a model has no value,
because there were no calls. Every task here was small enough, at 9 to 31 turns, that Opus did it
directly, even though each R run sampled in repeat 1 read the rule. It says nothing about routing
quality or savings once subagents are used.

The cost gap against N also did not come from routing. It is largest on `mech-rename-account` ($0.79
against $0.57), and the smoke run of that same task went the other way (N $0.32, R $0.43). Its cause
was not investigated.

The forced-delegation probe, one run in arm RD, shows the mechanism works when a subagent is
started: a `general-purpose` call with no model ran on Sonnet, and `agemon-scout` ran on Haiku.

Under the rule above, R's failure goes to the owner and the settings default is not built. The owner
later had it built anyway (the `subagent-default` capability), so this eval does not justify it.

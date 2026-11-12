# Skill-routing eval

Measures which skill an agent invokes for a task, with agemon's skills installed. It decides whether
the capability index ships as a second managed block in `AGENTS.md`. It measures routing only (the
`Skill` calls in each run), not whether the task gets done. Nothing here ships in the npm package.

## Arms

Every arm installs the rules the way agemon installs them: the agent-rules block in `AGENTS.md` and
the pointer in `CLAUDE.md`, both rendered from the current `src/`. Every built-in skill group is
copied from the working tree `assets/skills/` into `.claude/skills/`, which matches what
`agemon --yes` installs with every group selected.

- **N**: no index. The rules block and the skills, nothing else.
- **I**: N plus the capability index block. Not built yet (Phase 5).

## Cases

`cases.json` holds 17 cases. No prompt names a skill. `expected` lists the skills that count as a
hit (any one of them); an empty list is a negative control, where invoking any project skill counts
against the arm. `base/` is a small invented Nuxt invoice app the prompts refer to: an off-by-one
cent in `utils/invoice.ts`, an unchecked `id` in `server/api/invoice.get.ts`, a `div` used as a
button and a typo in `app.vue`. Nothing in it is installed or run.

## What counts

Each run starts from a fresh copy of `base/` and gets 4 turns in plan mode with only `Skill`,
`Read`, `Glob` and `Grep`. Its `Skill` calls are scored:

- positive case: `hit` if an expected skill was invoked, else `wrong-skill` if another installed
  skill was, else `miss`;
- negative case: `false-trigger` if any installed skill was invoked, else `quiet`.

`recall` is hits over scored positive runs, `wrongSkillRate` is wrong-skill over the same, and
`falseTriggerRate` is false-trigger over scored negative runs. Errored runs count in `runs` and are
left out of every rate. A batch with no `Skill` call at all fails, because then every miss would
measure the install, not the routing.

## Isolation

Runs use `--setting-sources project,local --strict-mcp-config`, so user-level settings files,
user-installed skills and plugins, user hooks and user MCP servers are not loaded. Credentials are
not copied anywhere: the run uses the owner's normal login.

It does not guarantee a clean room. Account-synced skills, and a user-level `CLAUDE.md` or memory,
may still load, and they can't be removed, only detected. The owner's account holds namespaced
copies of agemon skills (`anthropic-skills:agemon-…`). Any invoked name containing `:` is therefore
counted as `foreign`, recorded per run and in `foreignInvocations`, and left out of the outcome: a
foreign `agemon-root-cause` call is not a hit. A plain name from a non-project source can't be told
apart from the project copy, so that case is not detected. Each run records
`announcedSkillCount`, and each results file an `isolationNote` saying so.

A run that writes outside its temp project, or hits a usage-limit or auth error, aborts the batch;
what ran is already saved.

## Running

Both commands call the `claude` CLI and cost money.

```sh
npm run skill-routing-eval -- --probe --label probe
npm run skill-routing-eval -- --arm N --repeats 2 --label baseline
```

`--probe` runs `neg-explain-code` once and fails unless the session listed every installed skill,
which proves the install works. It prints the foreign skills the session listed. Other flags:
`--cases <id,…>`, `--model` (default `opus`) and `--effort`.

Results go to `results/<YYYY-MM-DD>-<label>-arm-<arm>-<stamp>.json`, saved after every run.
Transcripts sit beside them and stay local.

## Ship rule (pre-registered)

**Written 2026-11-12, before any run.** The index ships only when all four hold:

1. `recall(I) − recall(N) ≥ 0.15`;
2. `falseTriggerRate(I) ≤ falseTriggerRate(N) + 0.05`;
3. `meanCostUsd(I) ≤ 1.10 × meanCostUsd(N)`;
4. `foreignInvocations` is under 10% of `runs` in both arms.

Results are **indicative**. 2 runs per case can catch only large effects, and a null result means
"no large effect".

## Results

**2026-11-12, arm N baseline, `results/2026-11-12-baseline-arm-N-20261112021403-1bf1ba.json`.
Indicative.** Claude Code 2.1.318, Opus 5.5 (`claude-opus-5-5`), default effort, commit `8806ffa`.
34 runs, none errored, $6.85 at API list prices ($0.20 mean per run), 212 turns. Every run listed
88 skills, and none of them was foreign. A probe run beforehand cost $0.14 and passed.

| Measure | Arm N |
|---|---|
| Recall | 24/26 (0.92) |
| Wrong-skill rate | 1/26 (0.04) |
| False-trigger rate | 0/8 (0) |
| Foreign invocations | 0 |
| Skill calls | 25 |

Every positive case was a hit in both runs except these:

- `sec-input` hit with `agemon-security-audit` once and `agemon-security` once.
- `vue-composable` missed once (no skill invoked), and once invoked `agemon-brainstorming`
  (wrong skill).

All four negative controls stayed quiet in both runs.

Arm N's recall is 0.92, so arm I can be at most 0.08 higher. The ship rule's first condition
(at least +0.15) can't be met on this corpus.

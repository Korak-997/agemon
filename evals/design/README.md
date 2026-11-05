# Design skill evals

Measures whether `agemon-design` loads when it should (activation) and what it produces
(output). Nothing here is read while tuning the skill: `briefs/` and `fixtures/` are held out.

## Arms

- **A**: no agemon design skill. The companion skills below are still installed.
- **B**: the skill as it exists at a git ref, read with `git ls-tree` and `git show` (read-only:
  the index and working tree are never touched). `--skill-ref <git-ref>` picks the ref; the
  default is `c056fdc41d9eef734b85239bb21b5560e081cb3c`, which is what Phase 5 tests. Arm B
  installs the `design` group (four skills) from that ref.

Both arms install a realistic subset, not the whole catalogue (58 descriptions total about
16,561 characters, which distorts the listing budget): the `architecture`, `code-quality`,
`commit`, `performance`, `security` and `essentials` groups, also read from the ref, plus the `design`
group in B only. `essentials` holds `web-design-guidelines` and `writing-guidelines`, the skills
the `guidelines-boundary` cases compete with. For a ref that predates the bundled `essentials`
group, both arms install the copies in `test/fixtures/essentials-pinned-063bee94` instead. The
ref is recorded as `skillRef` in every results file.

## How activation is detected

`claude -p` does fire skills. A one-off probe in a temp project showed the model calling the
`Skill` tool for `agemon-design` on a landing-page prompt. With
`--output-format stream-json --verbose` the transcript holds an `assistant` event with a
`tool_use` block named `Skill` and `input.skill`. A run counts as activated when that block
names exactly the project-level `agemon-design`. A namespaced call such as
`anthropic-skills:agemon-design` or a sibling such as `agemon-design-minimal` is recorded
under `invokedDesignSkills` (exact name) and `namespacedCall`, and is not counted. Names are
matched with `/(^|:)agemon-design(-\w+)?$/`.

`claude plugin eval` was not used: it evaluates a plugin directory, runs 3 cases per prompt by
default, and under its with/without ablation treats `tool_used: Skill` as an indicator, not a
score. These skills are project skills, not a plugin.

Activation runs use `--permission-mode plan --max-turns 4`, so a read or glob before the
Skill call is not a false negative, and nothing is built. Plan mode is kept because it is the
mode the probe saw the Skill call fire in; the plan-file write seen in that probe came from
the `Write` tool, which activation runs no longer have.

## Tool restriction

Every run passes `--tools` explicitly, plus `--disallowed-tools` as a second guard:

- activation (`ACTIVATION_TOOLS`): `Skill,Read,Glob,Grep`
- output builds (`BUILD_TOOLS`): `Skill,Read,Glob,Grep,Write,Edit`

No Bash, web, MCP, Artifact or ToolSearch. A first real probe wrote a plan file into the
owner's real `~/.claude/plans/` and called the account-level `Artifact` tool, which are side
effects outside the temp project. After every run the transcript is scanned: a `Write` or
`Edit` whose path falls outside the run's temp directory marks the run `errored` with reason
`wrote-outside-project` and aborts the batch. That the flag removes the `Artifact` tool is
expected from `claude --help` and was confirmed by a re-probe: the available tools were Glob,
Grep, Read and Skill.

## Usage reporting

Each run records `costUsd` (the transcript's `total_cost_usd`) and `numTurns`; the summary
holds `totalCostUsd` and `totalTurns` for the batch. These are API-equivalent figures, not
what a plan login is billed, but they show how fast usage climbs. A probe run cost about
$0.30 on one activation case.

## Failed runs are not "did not trigger"

The `result` event of each transcript is parsed. A run is `errored` (with `errorReason`) on a
non-success result, a timeout, a stdout buffer overflow, an empty transcript or no result
event. Hitting `--max-turns` is a valid completed run and is scored from its Skill calls. A
usage-limit or auth error aborts the rest of the batch at once; what ran is already saved.
`scoreActivation` leaves errored and contaminated runs out of the rates and reports their
counts next to `correct/total`.

## Isolation: what it covers and what it does not

Runs use `--setting-sources project,local --strict-mcp-config`, so user-level settings files,
user-installed skills and plugins, user hooks and user MCP servers are not loaded. Credentials
are not copied anywhere: the run uses the owner's normal login, so there is no separate
`CLAUDE_CONFIG_DIR`.

It does not guarantee a clean room. Account-synced skills, and a user-level `CLAUDE.md` or
memory, may still load. So every run is checked: the `init` event lists the skills the session
saw. In arm A any `agemon-design*` name listed or invoked is contamination. In arm B any
namespaced one is. A plain `agemon-design` from a non-project source cannot be told apart from
the project copy by name, so arm B can miss that case. Other account-synced skills remain listed in every run (the probe listed 29, several
`agemon-*` from outside the project, but no `agemon-design`). Each run records
`announcedSkillCount` and each summary an `isolationNote` saying so. A contaminated run aborts the batch,
unless `--allow-contaminated` is passed; then every result in the batch is labelled
`contaminated: true` and left out of the rates.

## Corpus

`activation-cases.json`: 12 cases, none naming a skill. `splitCases(cases, seed)` gives a
stable 7 train / 5 validation split per seed. Rates from this few runs are rough: report
counts (`correct/total`) next to percentages. `expected` for `small-edit` and the
`guidelines-boundary` cases is an owner judgement call; review before trusting those rates.

`briefs/`: three output briefs with invented brands: `field-notes-greenfield` (empty repo),
`tarn-ember-brand` (repo with an established brand) and `orbit-ledger-shadcn` (stock shadcn).
A brief's fixture is `fixtures/<brief name>/`, copied into the project before the build.

## Commands

Activation takes `--arm`, a required `--limit` (cases per batch) and `--offset`. A batch may
not exceed 6 runs (`limit x runs`). `--dry-run` is free and starts nothing.

```sh
npm run design-eval:activation -- --dry-run
npm run design-eval:activation -- --arm B --label baseline --runs 2 --limit 3 --offset 0
npm run design-eval:output -- --arm B --brief tarn-ember-brand --label baseline
```

Output takes a required `--arm`, a required `--brief` (one build per invocation) and
`--max-budget-usd` (default 5, passed to `claude`).

## Results stay local

Summary JSON goes to `results/<date>-<label>-arm-<arm>[-<brief>]-<batch id>.json` as
`{ model, effort, agemonCommit, arm, skillRef, cases }`. The batch id is unique, files are
created exclusively and never overwritten, and activation results are rewritten after every
run so a crash loses nothing. Raw transcripts go to `results/<same name>/transcripts/` and
can contain session ids, account details and local paths. The whole `results/` folder is
git-ignored, so record headline numbers worth keeping in this README.

Activation temp projects are deleted after each run. An output build directory is kept so it
can be inspected; its path is printed and recorded in the summary. Delete it with
`rm -rf <that path>` when done.

## Recorded results

- **Invalid runs.** The 4 `guidelines-boundary` baseline (arm B) runs from 2026-11-05 are invalid
  and excluded: `web-design-guidelines` was not installed in either arm, so the baseline had no
  competing skill. Both arms now install Essentials. Phase 1's test measures this.
- **Arm B, read two ways.** Clear requests: 6/8 activated `agemon-design` strictly, and 8/8 when
  an `agemon-design-*` variant counts. Small edits: 4/4. Near-misses: 8/8 correct no-trigger.

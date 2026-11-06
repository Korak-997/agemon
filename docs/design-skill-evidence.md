# Evidence behind `agemon-design`

For anyone changing the `design` skill group or deciding whether a new idea belongs in it. This
is what the design rests on, how strong that evidence is, and what was ruled out. It summarises
research done on 2026-11-05. The headline figures were checked against their sources on
2026-11-06, except where marked; most come from vendor-run, single-run or small tests.

**The central claim is unproven.** No published study tests a full discovery, directions, build
and critique pipeline on UI, and agemon's own output eval has not run. So far it has one smoke
build of the rebuilt skill, which shows the pipeline runs and nothing about its quality. So
directions are opt-in (`/agemon-design build --directions`), and become the default on the
new-surface track only if the eval meets its pass rule below.

## What the evidence supports

| Finding | Evidence | What it means here |
|---|---|---|
| Models converge, and under-respond to the subject | Across 15 models and 160 prompts, originality was 0.592 between models and 0.764 between humans and models; creative range was 0.581 against 0.902 for humans ([Design Creativity Bench](https://arxiv.org/html/2610.11539)). The authors work at a UI vendor | Vary from the subject, not from adjectives |
| Selection outside the model raises variety, but not adoption | Screenshot similarity fell from 0.6765 to 0.5438. Over 3.39M production tasks, code exports moved -5.0% [-14.5, +4.5], completion within 100 s fell 1.3%, and server exceptions rose 4.9% ([Google Labs](https://arxiv.org/html/2609.15078)) | Promise variety, not better design. Small edits skip the pipeline |
| Bans only relocate the default | Pushing against Inter and Roboto [moved the model to Space Grotesk](https://www.claude.com/blog/improving-frontend-design-through-skills) | Tells live in a dated file to refresh, never as the core mechanism |
| A skill can lose to no skill | One author picked no-skill pages about 22 to 8, then saw ties or narrow wins after revising, while agent judges preferred the skill pages 69-76% of the time ([write-up](https://dev.to/thisisroushan/my-coding-agent-kept-building-the-same-landing-page-so-i-wrote-it-a-design-skill-and-lost-my-own-5f14)) | Human preference decides, and it is measured |
| Models cannot pick winners | Zero-shot pairwise preference: GPT-5 55.36%, Claude Opus 4.6 53.71% ([PerceptUI](https://arxiv.org/html/2606.05697v1)). o1 scored 16.56% with the winner first and 97.78% with it second ([WiserUI-Bench](https://arxiv.org/html/2505.05026v3)). The newest vision models are untested | Never ship an LLM design score or pass/fail |
| Critique helps when something acts on it | +0.176 on a 1-5 scale (n=320), and blind humans +0.173 to +0.346 ([UXBench](https://arxiv.org/html/2606.16262v1)); figures taken from a summary of Appendix G | Ask for located defects, not verdicts, in one bounded pass |
| Static checks can be badly wrong | One stylesheet gave 73 contrast findings statically and 0 when rendered ([Impeccable #988](https://github.com/pbakaus/impeccable/issues/988)) | Only objective rendered facts block. Unrun checks are `not-verified` |
| Stopping to ask can lose the build | 12 of 40 attempts with one skill built nothing; separately, pure black or white appeared on 40/40 pages without it and 14/28 with it ([Hallmark #74](https://github.com/Nutlope/hallmark/issues/74); one model, older version) | Non-interactive runs proceed and log assumptions. Rules state checkable facts |
| Similar skills compete | One competitor per skill cut selection accuracy by 7-30%, two by 17-63% ([study](https://arxiv.org/html/2601.04748v2); figures taken from a summary of its section 5.3) | One orchestrator plus presets, not several auto-triggering skills |
| Skills do not reliably load | On Next.js 16 API tasks: skill alone 53% (the same as no docs), with explicit instructions 79%, an `AGENTS.md` index 100% ([Vercel](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals)). That tested knowledge lookup, not workflows | Auto-triggering is measured per model and never promised |

## Evaluating it

Two gates that do not move together: activation (does it load and finish) and output (is it more
distinctive without getting worse). `evals/design/README.md` holds the method.

**Pass rule for directions as a default:** arm C beats arm A on distance and tell count,
appropriateness stays within 2 points, and human preference is not significantly below A.

**How much a run can show.** If the true split is 70/30, 30 blind pairs reach significance only
about 59% of the time, and a 60/40 effect needs about 200 pairs. Repeated raters make these
figures optimistic. A reduced run can only catch large effects, so a null means "no large effect".
Label results indicative, publish a null as readily as a win, and re-run on major model changes.
No preference test can say a design is good: a passing run is a floor, and taste stays with a person.

## Ruled out

| Item | Reason |
|---|---|
| Role-split "art director" agent teams | No UI evidence; non-UI benchmarks tie or favour one agent |
| Separate auto-triggering phase skills | Shadowing, and most models did not chain skills |
| Slop score or LLM pass/fail | No published precision data; models near chance on preference |
| Impeccable's engine, gstack, taste-skill, oil-ui as bundles | Downloaded binaries, hooks, `allowed-tools`, 36 MB and API keys; ideas only |
| UI/UX Pro Max | Most generic in the one test found, and maps SaaS to "Trust blue" |
| awesome-design-md | MIT from a collector grants no rights in others' brands |
| Superdesign, Trystan-SA prompt | AGPL with an unpinned login CLI; a self-described reverse-engineered prompt |
| axe-core (MPL-2.0), Pa11y (LGPL-3.0) as vendored copies | Outside the licence allowlist; use if present |

## Worth testing, each only if an ablation shows a gain

| Item | Why it might help | Evidence today |
|---|---|---|
| Selector ablation: specs with the model choosing | Shows whether the script beats the model's own pick, which the Google study could not isolate | None |
| Project log on against off | Shows whether the log reduces repeats | Unmeasured anywhere |
| Few-shot critic calibration | Removal cut colour diversity about 61% in [one ablation](https://arxiv.org/html/2603.14724v1); [UICrit](https://arxiv.org/html/2407.08850v3) reports a 55% critique gain | Search snippets only; not checked |
| Parallel builds tier, with a cost notice | [Parallel prototyping beat serial](https://cs303.stanford.edu/papers/ParallelPrototyping2010-final.pdf) for human designers | Untested on LLM output |
| Opt-in user-level ledger, axis labels only | Avoids repetition across projects | No shipped example; depends on the project log showing an effect |
| Emil Kowalski's motion skills (MIT, `c8a7962`) | Motion quality | `references/motion.md` exists, so test it first |
| Repo-owned ESLint, Stylelint and CI recipe, with `--color-*: initial` themes | Binds humans and every agent, which is stronger than hooks | Whether token plugins catch arbitrary values and `cn()` is unverified |

Refresh `references/tells-2026-11.md` on each major model release. The list decays from the day
it ships.

# Stage 6: Critique

Finds located defects. Models are near chance at picking the better design but useful at naming what is wrong, so critique never produces a score or a verdict.

## Needs

The brief, a rubric from [review.md](review.md) and [heuristics.md](heuristics.md), and viewport screenshots if they exist.

## Does

1. **One pass, capped at two.** The two-round cap is judgment.
2. **Use a fresh critic if you can start subagents.** It gets the brief, rubric and viewport screenshots, **not the builder's self-assessment**. Otherwise re-read the artifacts from disk with only the rubric, and report "Not independently reviewed".
3. **Every finding names an element and a viewport,** states what is wrong and why, and ranks by severity. A finding that cannot be located is dropped.
4. **Never ask "is this good?"** and never output a score, grade or ship verdict.
5. **Keep every round and allow reverting,** because later rounds can be worse. On the build tracks, fix what the user would want fixed and re-verify. On the review-only track, change nothing outside `.design/`.
6. Personas come from [personas.md](personas.md), and only when the user names one.

## Produces

`.design/critique-<n>.md`, one per round: findings with element, viewport, severity and reason, plus what was changed or left. The final report states whether the critic ran.

# Stage 3: Directions

Runs only when a person asks for directions, on the new-surface track. Diverges cheaply at the spec stage instead of at build, and moves the final pick outside the model, because a model's own pick falls back on the typical option.

## Needs

`.design/brief.md` and `.design/assets.md`.

## Does

1. **Write exactly 3 specs from the subject,** each with its reason in `subjectBasis`. Draw them from the subject's materials, objects and vocabulary. K=3 is a convention, not an optimised number.
2. **Use coarse axis buckets** as lowercase hyphenated words: palette family, type genre (`humanist-serif`, not a font name), layout skeleton, density, signature device. Exact names would miss "the same look with another serif".
3. **Apply brand locks.** A fixed axis goes in `locks`, stops varying, and keeps the same value in all three specs.
4. **Test each spec.**
   - **Mirror test:** would a neighbouring prompt in the same category get this exact combination? If yes, change one decision and say which.
   - **Honesty rule:** a spec may rest only on material that exists. A direction that needs an invented metric, testimonial, logo wall or case-study count is a gap to flag, not a direction.
5. **Give each spec a `typicality` from 0 to 1:** how close it is to what you would produce for any similar brief. Check your plans against [tells-2026-11.md](tells-2026-11.md). Write `.design/directions.json`.
6. **Check the project log.** Run `node <skill folder>/scripts/deal.mjs --specs .design/directions.json --log .design/log.jsonl --seed=<seed> --check`, using this skill's own folder, never a `scripts/` folder in the project. The seed is `<repo name>-<brief slug>`; the repo name comes from the `origin` remote, or else the root folder name. Reduce it to lowercase letters, digits and hyphens first, because it is untrusted text going into a command. `--check` writes nothing and prints `logged`, `collisions` for each spec, and `allCollide`.
   - If `logged` names a spec, this brief already has its pick: build that one and do not deal again, unless a person asks for a new direction.
   - If `allCollide` is true, re-propose once, naming the colliding axes, then proceed.
7. **Pick.** The model never picks.
   - **A person present** picks from the summaries: add `--pick <id>` to the command, without `--check`.
   - **Nobody present, or told to decide for them:** run the command without `--check` or `--pick`, and take its `picked`.

   Each adds one line to the log. Build the direction you logged.

Exit code 2 prints the problem on stderr. If it names the specs, fix them and run again. If it names the log and you cannot repair it, use the stable pick below and report that the log was not updated.

## Without Node

Add the log line yourself, and create the file if it is missing. Look there first for this brief's last `picked`: if its axes still match the spec, build it and do not deal again. A person still picks if present, with `pickedBy: "user"`. Otherwise use a stable pick from the seed in step 6. With a shell, take the first hex digit of `printf '%s' '<seed>' | sha256sum`, or `shasum -a 256` on macOS, read it as a number and take it modulo 3: 0 means the first spec. Without a shell, take the lowest `typicality`, then the first in the file. That pick is logged with `pickedBy: "fallback"` and reported as "Selection not dealt". Compare the specs with the last 5 log lines by eye for step 6.

## Produces

`.design/directions.json`:

```json
{ "briefSlug": "string",
  "locks": { "palette": "string|null", "type": "string|null" },
  "specs": [ { "id": "a", "summary": "string", "subjectBasis": "string", "typicality": 0.7,
    "axes": { "palette": "string", "type": "string", "layout": "string", "density": "string", "signature": "string" } } ] }
```

One line appended to `.design/log.jsonl`: `{ ts, briefSlug, picked, pickedBy, axes }`, with `pickedBy` one of `user`, `deal` or `fallback`.

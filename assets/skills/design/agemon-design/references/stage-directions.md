# Stage 3: Directions

New-surface track only. Diverges cheaply at the spec stage instead of at build, and moves the final pick outside the model, because a model's own pick falls back on the typical option.

## Needs

`.design/brief.md` and `.design/assets.md`.

## Does

1. **Write exactly 3 specs from the subject,** each with its reason. Draw them from the subject's materials, objects and vocabulary. K=3 is a convention, not an optimised number.
2. **Use coarse axis buckets:** palette family, type genre (`humanist-serif`, not a font name), layout skeleton, density, signature device. Exact names would miss "the same look with another serif".
3. **Apply brand locks.** A fixed axis goes in `locks` and stops varying.
4. **Give each spec a `typicality` from 0 to 1:** how close it is to what you would produce for any similar brief. Check your plans against [tells-2026-11.md](tells-2026-11.md).
5. **Compare with `.design/log.jsonl`** if it exists. If all three repeat recent axis values, re-propose once and name the collisions, then proceed.
6. **Pick.** A person picks if one is present. Otherwise use a stable pick from the repo and brief names: with a shell, the first hex digit of the SHA-256 of `<repo name>-<brief slug>`, modulo 3; without one, the lowest `typicality`, then the first in the file. **The model never picks** by preference. A pick made this way is logged with `pickedBy: "fallback"` and reported as "Selection not dealt".

## Produces

`.design/directions.json`:

```json
{ "briefSlug": "string",
  "locks": { "palette": "string|null", "type": "string|null" },
  "specs": [ { "id": "a", "summary": "string", "subjectBasis": "string", "typicality": 0.7,
    "axes": { "palette": "string", "type": "string", "layout": "string", "density": "string", "signature": "string" } } ] }
```

One line appended to `.design/log.jsonl`: `{ ts, briefSlug, picked, pickedBy, axes }`, with `pickedBy` one of `user` or `fallback`.

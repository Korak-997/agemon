# Interactive illustration guidance in agemon-design

Date: 2026-11-12. Size: a small change. Approved by the owner in chat on 2026-11-12.

## Intent

The owner liked Hairline (github.com/lucasmarkes/hairline, MIT): isometric line figures that answer the
pointer. The question was whether agemon needs its own version. A spike answered it: a fresh agent with only
`agemon-design` and `agemon-motion-design` built "an isometric line drawing of a server rack; the blades
nearest the pointer slide out", and the owner judged the result good. So agemon does not get a new engine or
skill group. It gets the guidance the spike showed was missing, so the result no longer depends on the
model's own knowledge.

## Goals

Close the five gaps the spike exposed:

1. No guidance for interactive illustrations (projection, paint order, line hierarchy, a shared loop).
2. No rule against the pointer flicker loop (hit-testing against a moving pose).
3. `motion.md` contradicts itself and `agemon-motion-design` on exit easing.
4. No reduced-motion rule for a figure whose motion is its content.
5. No rule that a figure takes its shape from a reserved aspect-ratio box.

## Non-goals

- No figure library, engine, npm package or new skill group.
- No edits to the vendored `agemon-motion-design` (it stays identical to its pinned LottieFiles commit).
- No changes to skill descriptions, so activation is unchanged.

## Anti-goals

- Copying Hairline's text or code. Its ideas are credited; the words are agemon's.
- Guidance that turns every UI animation into an illustration concern: the new reference applies only to
  decorative figures and diagrams that answer the pointer.

## Constraints

- `agemon-design` is vendored from ui-craft and already modified by agemon; every change is logged in its
  `NOTICE.md`.
- Every file in `references/` must be linked from `SKILL.md` or a stage file (`test/unit/plugins/design-skill.test.ts`).
- `SKILL.md` stays under 20,000 bytes with its section order intact.
- After the last edit under `assets/skills/`, run `npm run skills:fingerprints`.
- Phase-end gate: `npm run lint && npm run lint-skills && npm run skills:fingerprints -- --check && npm run typecheck && npm test`.
- No commits without the owner's go-ahead.

## Approaches

| Approach | Trade-off | Outcome |
|---|---|---|
| Fix inside `agemon-design` (new `references/illustration.md` plus edits to `motion.md`) | Follows the existing pattern of agemon-owned changes logged in `NOTICE.md`; no new routing surface | **Chosen** |
| New `illustration` skill or group | A third visual skill competing with design and motion for the same requests | Rejected |
| Edit the vendored `agemon-motion-design` | Drifts from its pinned upstream | Rejected |

## Design

| Gap | Fix | File |
|---|---|---|
| 1 | New reference: when it applies, isometric projection, painting back to front with opaque faces, solids as a silhouette plus one dim inner line, one shared animation loop that sleeps offscreen and when settled | `references/illustration.md` |
| 2 | Interaction rule: pick what is under the pointer from the rest or target pose, never the pose mid-animation | `references/motion.md`, Interaction Rules (and referenced from `illustration.md`) |
| 3 | Easing rule: acceleration only for an element leaving the screen, never one arriving or staying; the 0.4, 0, 1, 1 exit tail is named as that case | `references/motion.md`, Easing Scale, Choreography Rules, Anti-Patterns |
| 4 | Reduced motion when motion is the content: replace it with an instant state change, keep the pointer response, never a blank figure | `references/motion.md`, Reduced-Motion Contract |
| 5 | The figure's shape comes from a reserved `aspect-ratio` box and a fixed `viewBox`, so it fits any container and nothing shifts | `references/illustration.md` |

Wiring: a row in `SKILL.md`'s reference map, a row in `references/routing.md`, a cross-ref in `motion.md`,
a `NOTICE.md` line, regenerated fingerprints.

## Verification

1. The phase-end gate passes.
2. A fresh agent re-runs the rack prompt and one different prompt with the updated skills; the results are
   compared with the first spike for the five gaps. The owner judges how they look.

## Left to the builder

The wording and length of `illustration.md` (keep it short; aim for under about 120 lines), and where exactly
each `motion.md` sentence sits within its section.

## Out of scope, logged separately

`motion.md` links to `../examples/animation-storyboard.md`, which does not exist.

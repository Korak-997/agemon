# Interactive Illustration Guidance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use agemon-subagent-driven-development (recommended) or agemon-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the five guidance gaps the rack spike exposed, inside `agemon-design`, so interactive line illustrations no longer depend on the model's own knowledge.

**Architecture:** One new reference, `references/illustration.md`, reached from `SKILL.md`'s reference map and `routing.md`. Three rule changes in `references/motion.md` (pointer hit-testing, exit easing, reduced motion when motion is the content). Changes logged in `NOTICE.md`; fingerprints regenerated.

**Tech Stack:** Markdown skill files; vitest content tests in `test/unit/plugins/design-skill.test.ts`.

**Spec:** `docs/specs/2026-11-12-interactive-illustration-guidance-design.md`

## Global Constraints

- Do not edit `assets/skills/motion/agemon-motion-design/` (vendored, pinned).
- Do not copy Hairline's text or code; credit its ideas in `illustration.md`'s Sources.
- `illustration.md` under about 120 lines.
- `SKILL.md` stays under 20,000 bytes with its heading order unchanged.
- Run `npm run skills:fingerprints` after the last edit under `assets/skills/`.
- Never `git add`, `git commit` or `git push` without the owner's go-ahead; end with a proposed commit message.
- Gate: `npm run lint && npm run lint-skills && npm run skills:fingerprints -- --check && npm run typecheck && npm test`.

## Review Focus

1. An ordinary UI hover or modal (not an illustration) gets routed to `illustration.md`: its "When to read" must exclude plain UI motion. Checked by reading, Task 1 step 3.
2. The new easing rule still bans `ease-in` for anything arriving or staying on screen: Task 2 test `keeps ease-in banned for arriving elements`.
3. The old blanket "different easings on entrance vs exit" anti-pattern stays in a form that no longer contradicts the exit tail: Task 2 test `allows acceleration only for elements leaving`.
4. Reduced motion leaves a blank or frozen-mid-pose figure: Task 2 test `defines reduced motion when motion is the content`.
5. `illustration.md` exists but nothing links it: the existing `links every reference` test, plus Task 1's routing test.

---

### Task 1: `references/illustration.md` and its wiring (gaps 1 and 5)

**Files:**
- Create: `assets/skills/design/agemon-design/references/illustration.md`
- Modify: `assets/skills/design/agemon-design/SKILL.md:98` (Motion and sound row of the reference map)
- Modify: `assets/skills/design/agemon-design/references/routing.md` (intent table, after the dataviz row)
- Modify: `assets/skills/design/agemon-design/references/motion.md` (Cross-Refs)
- Test: `test/unit/plugins/design-skill.test.ts`

**Interfaces:**
- Produces: the file `references/illustration.md` and the anchor heading `## Hit areas`, which Task 2's motion rule links to as `illustration.md#hit-areas`.

- [ ] **Step 1: Write the failing test** `routes interactive illustrations to illustration.md`:
  - `SKILL.md` contains `(references/illustration.md)`;
  - `references/routing.md` contains `(illustration.md)`;
  - `references/illustration.md` contains each heading: `## When to read this`, `## Frame`, `## Projection`, `## Paint order`, `## Line hierarchy`, `## Hit areas`, `## One loop`, `## Reduced motion`;
  - the `## Frame` section contains `aspect-ratio` and `viewBox`.
- [ ] **Step 2:** `npx vitest run test/unit/plugins/design-skill.test.ts` → FAIL (file missing).
- [ ] **Step 3: Write `illustration.md`.** Sections as in step 1, each a few rules with a why:
  - When to read: decorative figures and diagrams drawn in SVG that answer the pointer; not ordinary UI motion (that is `motion.md`).
  - Frame: fixed `viewBox`; the host reserves `aspect-ratio` before drawing (no layout shift, empty box on the server); scale by width.
  - Projection: one projection function for every point; isometric 2:1; fit the most extreme pose, not rest, so nothing leaves the frame at the far end.
  - Paint order: faces opaque, filled with the ground colour; append far to near; when depth order changes move the node, do not redraw.
  - Line hierarchy: silhouette bright, inner edges dim, one highlight that means one thing; no glows or gradients; round corners and do not draw vertical corner edges.
  - Hit areas: pick from the rest or target pose (or a fixed ground plane), never the pose on screen; why: flicker loop.
  - One loop: one shared `requestAnimationFrame` for every figure on the page; ticks return whether they still move; sleeps offscreen (IntersectionObserver) and when settled; springs for continuous pointer input, tweens for discrete choices.
  - Reduced motion: link to `motion.md`'s rule (Task 2).
  - Sources: Hairline (github.com/lucasmarkes/hairline, MIT), for the ideas.
- [ ] **Step 4: Wire it.** Add `[illustration.md](references/illustration.md)` to SKILL.md's Motion and sound row; add routing row `| Interactive illustrations (SVG figures and diagrams that answer the pointer) | [illustration.md](illustration.md) |`; add a Cross-Refs bullet in `motion.md`.
- [ ] **Step 5:** run the test file → PASS.

### Task 2: `motion.md` rules (gaps 2, 3, 4)

**Files:**
- Modify: `assets/skills/design/agemon-design/references/motion.md` (Interaction Rules, Easing Scale "Never", Choreography Rules first paragraph, Reduced-Motion Contract, Anti-Patterns)
- Test: `test/unit/plugins/design-skill.test.ts`

**Interfaces:**
- Consumes: `illustration.md#hit-areas` from Task 1.

- [ ] **Step 1: Write failing tests:**
  - `keeps ease-in banned for arriving elements`: motion.md contains `` `ease-in` for anything arriving or staying on screen ``.
  - `allows acceleration only for elements leaving`: motion.md contains `cubic-bezier(0.4, 0, 1, 1)` and the phrase `leaving the screen`, and does not contain `` - [ ] Different easings on entrance vs exit of the same element. ``.
  - `defines reduced motion when motion is the content`: motion.md contains `When motion is the content`.
  - `hit-tests against the resting pose`: motion.md contains `illustration.md#hit-areas`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Edit motion.md:**
  - Interaction Rules: a bullet "Hit-test against where things rest or are heading, never where they are mid-animation" with the flicker why and a link to `illustration.md#hit-areas`.
  - Easing "Never": reword the ease-in bullet to `` `ease-in` for anything arriving or staying on screen ``; reword the entrance/exit bullet to the two directions of one on-screen state change (hover in/out, expand/collapse).
  - Choreography: state that the accelerating tail `cubic-bezier(0.4, 0, 1, 1)` is for an element leaving the screen, the one place acceleration is right.
  - Anti-Patterns: the matching two checklist lines reworded the same way.
  - Reduced-Motion Contract: a third exception, "When motion is the content" (a figure that answers the pointer): move to the target state instantly or swap the motion for a highlight; keep the pointer response; never blank, never frozen mid-pose.
- [ ] **Step 4:** run → PASS.

### Task 3: NOTICE, fingerprints, gate

**Files:**
- Modify: `assets/skills/design/agemon-design/NOTICE.md` (append one bullet)
- Modify (generated): `src/plugins/skills/bundle-fingerprints.ts`

- [ ] **Step 1:** Append to NOTICE.md a bullet describing Tasks 1-2 (new `references/illustration.md`, credited to Hairline's ideas, MIT; the three `motion.md` rule changes).
- [ ] **Step 2:** `npm run skills:fingerprints`.
- [ ] **Step 3:** Run the gate → all pass.
- [ ] **Step 4:** Propose the commit message `feat(skills): add interactive illustration guidance to agemon-design` and wait.

### Task 4: Verify against the spike, log the out-of-scope link

- [ ] **Step 1:** A fresh agent (never shown Hairline) re-runs the rack prompt and one new prompt ("an isometric line drawing of a padlock; the shackle lifts as the pointer nears") with the updated skills, writing to the session scratchpad. Report per gap whether it was followed.
- [ ] **Step 2:** Draft (do not post) a GitHub issue for the missing `../examples/animation-storyboard.md` link in `motion.md`; post only on the owner's yes.

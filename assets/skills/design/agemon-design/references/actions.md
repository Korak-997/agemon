# Actions

Eight focused passes you can ask `agemon-design` for. Invoke one as `/agemon-design <action> [target]`, or just say it in plain words ("review this page", "harden the settings form", "write the design brief") — the words route to the same action. Anything not listed here is not an action: apply the reference files directly.

| Action | What it does | Edits code? |
|---|---|---|
| [brief](#brief) | Write or update the project's design brief | writes `brief.md` |
| [tokens](#tokens) | Audit or establish the token spine | proposes patches |
| [build](#build) | Build a whole surface from an outcome recipe | yes |
| [review](#review) | Design critique, or a heuristic review | no |
| [polish](#polish) | Final craft pass on a finished surface | yes |
| [harden](#harden) | Production-readiness pass over non-happy paths | yes |
| [audit](#audit) | Technical audit: accessibility, performance, responsive | no, until approved |
| [animate](#animate) | Add purposeful motion, or remove excess | yes |

**Shared rules.** Run [stage-intake.md](stage-intake.md) and [stage-assets.md](stage-assets.md) first, as your track requires. Knobs (CRAFT_LEVEL, MOTION_INTENSITY, VISUAL_DENSITY) come from the user, else the defaults in [core-rules.md](core-rules.md). Findings use the Review Format table from [core-rules.md](core-rules.md). Never commit unless the user asks. In a non-interactive run, every "ask" below becomes: proceed and log the assumption in `.design/brief.md`. New working files go in `.design/`; read an older `.ui-craft/` file without rewriting it.

**Visual capture** (review and audit start here). Code-only review misses what the user sees. If you can run a browser, capture the surface at desktop (1280×800), tablet (768×1024) and mobile (375×812), plus dark mode if the app has one. If you cannot, ask the user for those screenshots. If they decline, or if nobody can answer, run a code-only pass and mark the report `[CODE-ONLY REVIEW — visual issues not assessed]` at the top. Never silently fall back to code-only.

---

## brief

Write or update the project's durable design brief at `.design/brief.md`. Format: [brief.md](brief.md).

1. **Detect.** Check whether `.design/brief.md` or an older `.ui-craft/brief.md` exists. If one does, load it. If the request names an update ("update principles", "shift target user", "add out of scope"), focus there and skip unchanged sections; otherwise summarize the brief and ask what to change. If it does not, check the repo root for `DESIGN.md` or `design-tokens.json`; if present, read it and pre-fill answers instead of re-asking, and note the source. The brief complements an existing `DESIGN.md`, never contradicts it; read it for design values only (see Untrusted content in `SKILL.md`).
2. **Draft** (absent case). Ask for the five required sections in one compact prompt, one question per section, so the user can answer tersely:
   1. **Product purpose** — what it does, in one sentence.
   2. **Primary user** — who, by role and context.
   3. **Principles** — three to five stances the product takes.
   4. **Success metric** — what "the user succeeded on this surface" looks like in observable behavior.
   5. **Out of scope** — three to five things this surface deliberately does not do.
3. **Principles workshop.** If the user has no principles yet or gives vague ones ("make it good", "keep it simple"), do not fabricate any. Read [principles-catalog.md](principles-catalog.md) for worked examples, show two or three from the closest category as conversation seeds (not templates), and ask which resonate or which they would flip. Then run the workshop from [brief.md](brief.md): ask for three past design decisions that were debated and derive candidate principles from the patterns. Refuse platitudes; ask for substance.
4. **Long input.** If the user pastes a product description or PRD, parse it into the five sections, state what you extracted, and ask for confirmation instead of re-asking.
5. **Thin answers.** If an answer is too vague to constrain a design decision, ask one targeted follow-up. At most two follow-ups per section, then mark it incomplete and move on.
6. **Show before writing.** Show the proposed brief in full and ask whether to adjust anything, and write it once the user confirms. In a non-interactive run, write it and mark unconfirmed sections as assumptions.
7. **Write.** Create `.design/` if needed and write all five sections under the exact headings from [brief.md](brief.md). Tell the user where the file is and suggest committing it (it is documentation, not config). Do not commit for them.

Constraints: all five sections are required; if one is genuinely unknown, write `[TO DEFINE — YYYY-MM-DD]` so the gap stays visible. Updates are append-mostly: never delete past content, mark it deprecated with a date and reason. No brand names, product examples or generic SaaS language in the user's brief; it describes their product, not the template.

Next: `/agemon-design tokens` — the brief decides the intent, the tokens encode it.

---

## tokens

Audit or establish the project's 3-layer token spine (primitive → semantic → component). Read [tokens.md](tokens.md) first; it defines the contract and the intentional-dark test.

1. **Detect.** Scan for CSS variables in `:root`, `[data-theme]` or `[data-mode]`; Tailwind `@theme` blocks in the source stylesheet (v4), or `theme.extend` in a v3 config; a `tailwind.config.*` is live in v4 only if a stylesheet loads it with `@config`; never tokens from built CSS; CSS-in-JS theme objects (`theme.ts`, `*.styles.ts`, `ThemeProvider`); `design-tokens.json` or `tokens.json`; `globals.css`, `variables.css`, `tokens.css`. Build an inventory: which of the 7 categories exist (color, spacing, type, radii, shadows, motion, z-index), which layers are present, and whether light and dark are both defined.
2. **Route.** "audit" → audit only, no proposals. "establish" → skip to step 4. A category name → focus the audit and any proposal on it. Nothing specified → audit if tokens exist, establish if none.
3. **Audit.** Output a severity-ranked gap list, no code yet:
   1. 3-layer coverage — missing semantics is the most common gap (primitives exist, nothing switches for dark mode, no surface stack).
   2. 7-category coverage — flag each absent category.
   3. Intentional dark mode — does it do more than invert `--text-primary`? Is `--surface-canvas` a tinted near-black, not `#000`? Is accent chroma reduced 10–15%? Are shadows replaced by border rings?
   4. Naming — primitives named for values (`--gray-500`), semantics for roles (`--text-primary`).
   5. Arbitrary values — inline colors, spacing or z-index that bypass the system.

   | Severity | Category | Finding |
   |---|---|---|
   | Critical | Dark mode | `--surface-canvas` is `#000` — fails the intentional-dark test |
   | High | Semantics | No surface stack — components use raw primitives |
   | Medium | Shadows | Single-layer shadows — ambient layer missing |
   | Low | Z-index | Arbitrary values (`z-index: 999`) in 3 components |

   To iterate until nothing is off-system, the user must ask for it explicitly: fix the top off-system value (raw hex, arbitrary radius, magic spacing), re-scan, and repeat per [loops.md](loops.md) (preset `token-consistency`) until zero off-system values or the budget runs out.
4. **Establish** (no tokens found). Propose a minimal spine inline covering all 7 categories, with intentional light and dark blocks. Order: primitives (neutral ramp gray-50 to gray-950, one accent ramp, status bases, spacing, type, radii, shadows, motion, z-index); semantics (5-level surface stack, text, border, accent and status roles); component tokens only when a component is already being built. Use OKLCH unless the project is sRGB throughout; then flag it, propose OKLCH, and do not auto-convert. Before writing, ask which file (in a non-interactive run, take the suggestion and log it), suggested from the stack: Tailwind → `globals.css`; CSS-in-JS → `theme.ts`; vanilla CSS → `tokens.css`; cross-platform → `design-tokens.json`.
5. **Never overwrite.** If a token file exists, show additions as a diff and let the user apply it.

Constraints: do not impose Tailwind on vanilla CSS; do not impose OKLCH on a consistent sRGB project; extend the project's naming (`--color-primary`) rather than adding a parallel scheme.

Next: `/agemon-design build` — build on the spine.

---

## build

Build a complete surface from an outcome recipe, ending in working code that passes the recipe's acceptance bar. Use when the user asks for a whole surface ("build me a dashboard", "I need a landing page") and expects something shippable, not component-level help. With `--directions`, or when asked for directions in plain words, run [stage-directions.md](stage-directions.md) after step 1 and build the direction it logs.

Recipes: dashboard → [recipe-dashboard.md](recipe-dashboard.md) · landing → [recipe-landing.md](recipe-landing.md) · auth → [recipe-auth.md](recipe-auth.md). If the surface has no recipe (settings, docs, e-commerce), say so and fall back to the standard build with the closest references; do not improvise a fake recipe.

0. **Spec.** If `.design/spec.md` or an older `.ui-craft/spec.md` has a `## Surface: <name>` section matching the request ([spec.md](spec.md)), load it. Its composition, component inventory, state lattice and acceptance bar override the recipe defaults; note which bar items came from where.
1. **Inputs.** Run [stage-intake.md](stage-intake.md) and [stage-assets.md](stage-assets.md) (existing tokens, briefs). Read [craft-intent.md](craft-intent.md). Ask the recipe's Step 0 questions in one compact prompt, pre-filling anything the request or brief already answers. If the user declines or says "you decide", apply the recipe defaults silently and say which. Never ask twice, never block. Set DESIGN_VARIANCE from the craft-intent default for the surface type unless the user or brief says otherwise.
2. **Craft Read and plan.** Output the Craft Read line ([stage-build.md](stage-build.md)) before any code, including the signature bet. Choose composition, tokens (the project's existing ones, else derived from the brief; a theme preset only when the user asks or no direction exists), density, variance and signature bet; with no brand direction, rotate one axis (craft-intent §6) and name it.

   For **landing** surfaces, choose the fold class by exclusion, not taste. List the composition classes already recorded under `## Fold classes used` in the brief, then commit to one the project has not used, and say out loud what sacrifice that class demands: the sacrifice is what makes the page look like itself. Do not average candidate compositions together and do not fall back to text-left/visual-right because it fits everything: it fits everything because it commits to nothing.

   Print a short plan (5–7 lines): Craft Read, composition and its sacrifice, theme, signature bet, what is above the fold, what is deferred. Then proceed unless the user objects.
3. **Build** in the recipe's order exactly (tokens → shell → hero tier → primary region → remaining tiers → states → keyboard → finish). Load the references each step names plus the craft-intent patterns for this surface type. Build the signature bet in this pass, not later. States and keyboard are build steps, not polish: a surface without empty, loading and error states is not done.
4. **Acceptance bar.** Run the recipe's checklist against what you built and fix every unchecked item before reporting. The bar is the definition of done.

   If you can run a browser, capture the built surface at desktop width and look at it: a render exposes spacing collisions, hierarchy ties and dead zones that code review cannot. Run the similar-prompt self-test (craft-intent §1): would this exact page pass for a different brand in the category? If yes, strengthen the signature. If you cannot run a browser, report the render check as not verified.

   For landings, also check the fold you built is the class you chose, not the split you drift back to.
5. **Record.** For landings, append the class you built to `## Fold classes used` in `.design/brief.md`, creating the section if missing, so the next build in this project picks something else.
6. **Report:** the Craft Read; the composition class and its sacrifice; the signature bet built; checklist results; anything the user waived. Lead with intent, not a findings dump. Use the Review Format table only for fixes made in this pass. At CRAFT_LEVEL ≥ 8, also run the 10 passes in [finish-bar.md](finish-bar.md).

Next: `/agemon-design review` on the result. If the project has no brief yet, `/agemon-design brief` first.

---

## review

A critique of the UI through a design lens. Produces findings, no code edits unless the user asks. Two kinds: **design critique** (default) and **heuristic review** (when the user asks for a PM-ready or Nielsen-style review).

### Design critique

Start with Visual capture (above). Knob awareness: CRAFT_LEVEL 3 → flag only Critical anti-slop items; 5–7 → Critical and Major, Minor as optional; 9+ → everything including Minor polish and a missing signature detail.

Run these lenses in order:

1. **Anti-Slop Test** ([core-rules.md](core-rules.md)): every item present, Critical first, then Major, then Minor.
2. **Craft Test** ([core-rules.md](core-rules.md)): where the design falls short of "one accent, 3–5 placements; plain secondary text for comparisons; functional color only; every section earns its space".
3. **Hierarchy**: can the user tell primary, secondary and tertiary at a glance, or does everything shout equally?
4. **Clarity**: is the value proposition legible in 5 seconds? Are CTAs specific, not "Learn more"?
5. **Signature detail**: is there one memorable element that makes it feel designed, not assembled? If not, suggest one (motif, layout break, custom marker, distinctive hover).
6. **Inspiration gap**: read [inspiration.md](inspiration.md); which observed pattern applies here, and how does the current state diverge from it?

Output the Review Format table (Before | After | Why), prioritized by impact, not file order. End with one paragraph naming the top 3 changes that would raise it from "AI-generated" to "designed". Do not edit code. Close with a Craft Report ([review.md](review.md), Craft Report): Checked names the lenses run and the CRAFT_LEVEL bar, Passed carries what held up, Changed stays empty, Left alone covers anything flagged but out of scope, Verdict is one sentence. Produce it even when the surface passes clean.

### Heuristic review

Read [heuristics.md](heuristics.md) for the checklist and the required output format; do not invent a new format. This review produces severity-ranked findings, never a number, grade or pass/fail verdict.

1. **Nielsen's 10** as a checklist. Every finding names the element and the viewport it was seen at, and is concrete: quote text, count elements, name the broken flow. Vague findings are rejected. A heuristic with nothing to report gets no row.
2. **The 6 design laws**, each checked against a specific element: Fitts (target sizing, CTA placement), Hick (choice density), Doherty (perceived latency, optimistic UI), Cleveland-McGill (chart encoding), Miller (nav depth, form section counts), Tesler (where complexity lives).
3. **Persona walkthrough** (only if the user names one or asks for all). Read [personas.md](personas.md) and run the matching checklist as a `| Checklist item | Element | Viewport | Finding | Impact |` table.
4. **Rank** at most 5 findings by impact: `blocks-conversion > adds-friction > reduces-trust > minor-polish`. Cut `minor-polish` unless nothing higher exists.
5. **Output** in order: Heuristic Findings table, Design Law Findings table, Persona Walkthrough table (if run), Top findings ranked by impact. Tables and a ranked list only: no first-impressions paragraph, no hedging, no praise padding.

Usability is not a knob: a blocking problem is blocking whether CRAFT_LEVEL is 3 or 9. Do not soften findings. Do not edit code.

Next: fix the findings (`/agemon-design polish` for craft details, `/agemon-design harden` for missing states).

---

## polish

Final craft pass on a surface that is functionally complete but feels unfinished or generic ("polish this", "add the final touches"). Edits code directly.

**Source of truth:** [review.md](review.md), **Polish Pass (Compound Details)**. Apply every item on that list to the target; do not re-derive the list here.

**Signature detail.** A surface built with `build` already carries exactly one signature bet. Polish verifies it survived and strengthens it, and never stacks a second. Only a surface with no signature anywhere gets one added: a subtle motif, an asymmetric layout break, a custom list marker, a distinctive hover — one thing someone would remember.

**Knob gating (CRAFT_LEVEL):** ≤ 4 → ask the user before running the Polish Pass. 5–7 → apply everything, leave the signature as built unless asked. 8+ → apply everything and verify or strengthen the signature.

**Output.** After each file, print the Review Format table, one row per change, no full diffs. Close every run with a Craft Report ([review.md](review.md)): the table is the per-file diff log, the Craft Report is the run's receipt (Checked / Passed / Changed / Left alone / Verdict). Produce it even when nothing needed changing: that is itself the finding.

Next: `/agemon-design audit` before shipping.

---

## harden

Production-readiness pass: audit and implement the full non-happy-path matrix. Use before shipping a surface, or when the user says "it crashes on empty data", "there's no loading state" or "harden this".

Check every key surface:

1. **Loading** — skeletons match the final layout (no layout shift on resolve) and appear after ~200ms to avoid flashing on fast responses. Never a generic centered spinner when a skeleton is possible.
2. **Empty** — one line on why it is empty plus one clear primary action. Illustration optional, CTA mandatory.
3. **Error** — inline and actionable: what failed and the next step ("Save failed. Try again / Copy error / Contact support"), never just "Something went wrong."
4. **Partial data** — `—` for missing metrics, never `N/A`, `null`, or `0` when the value is truly unknown.
5. **Long content** — truncation with a `title` tooltip, `text-overflow: ellipsis`, container queries for constrained regions. Test with a 120-character name.
6. **i18n** — no hardcoded strings, ~1.3× expansion slack for German, narrower glyphs for CJK, RTL flip for directional icons.
7. **Offline / slow** — optimistic UI that reconciles on failure; skeleton persists past a timeout with a "still loading…" affordance.
8. **Permission** — what happens without access: disabled vs hidden, and always a "why" (tooltip, inline helper) when disabled.
9. **Zero-state to first-run** — inline hints beat 5-step tours; guide within the surface, not over it.

Correctness is not tunable: run the full matrix regardless of the knobs. Read [accessibility.md](accessibility.md) (keyboard and screen-reader paths), [copy.md](copy.md) (error and empty-state voice), [motion.md](motion.md) Rendering Performance (skeleton motion, reduced motion) and [state-design.md](state-design.md) (the state lattice).

**Output.** A per-surface checklist marking each of the 9 items present / missing / partial. Then edit the code to fix what is missing, and print the Review Format table of the fixes. End with a "still at risk" list for what you could not safely fix (needs a backend, a design decision, or translation files).

Next: `/agemon-design audit`.

---

## audit

Technical UI audit: accessibility, performance, responsive. Produces a prioritized findings table. Start with Visual capture (above). Audit is knob-agnostic: accessibility and performance are not tunable.

Non-negotiable checks:

1. **Accessibility** ([accessibility.md](accessibility.md)): visible `:focus-visible` on every interactive element; keyboard reachable, no focus traps; touch targets ≥ 44px on mobile; color is never the only signal for state; form labels, error association and required indication; `prefers-reduced-motion` honored for every animation.
2. **Performance** ([motion.md](motion.md), Rendering Performance): only `transform` and `opacity` animated (never `width`, `top`, `height`); no `transition: all`; `will-change` scoped to the active interaction and removed after; images have `width`/`height` or `aspect-ratio`; no layout thrash in scroll or resize handlers.
3. **Responsive** ([responsive.md](responsive.md)): mobile-first breakpoints, no fixed-width components; `env(safe-area-inset-*)` respected on fixed elements; touch zones do not overlap; no horizontal scroll at 320px.

Output the Review Format table (Before | After | Why), grouped **Critical** (blocks usability or a11y) → **High-impact** (immediately noticeable) → **Quick wins** (polish). Do not rewrite code unless asked: report first, wait for approval before editing. Report any check you did not run as not-verified, never as passed.

Close with a Craft Report ([review.md](review.md), Craft Report): Checked states scope (a11y, performance, responsive, at which viewports), Passed carries what was inspected and found sound, Changed stays empty before approval, Verdict names the top priority. Produce it even on a clean audit.

Next: `/agemon-design harden` to turn the findings into real production coverage.

---

## animate

Motion pass: add purposeful animation, fix janky transitions, or trim motion that distracts ("make it feel smoother"). Edits code directly.

1. **Decision Ladder.** Run the Decision Ladder in [motion.md](motion.md) first. Anything that fails it is removed, not improved.
2. **Pick the library.** If the user opted into a stack during intake, read [stack.md](stack.md) and use the matching section (Motion, GSAP or Three.js); never mix libraries on one property. Otherwise use CSS transitions, `@keyframes` and `animation-timeline: view()` only.
3. **Motion budget.**

   | Element | Budget |
   |---|---|
   | Color / opacity | 100–150ms |
   | Small UI (tooltips, dropdowns) | 150–200ms |
   | Medium UI (modals, panels) | 200–300ms |
   | Large UI (page transitions, drawers) | 300–400ms |

   Exit ≈ 75% of entrance duration (shorter, same `ease-out`, or a flatter tail like `cubic-bezier(0.4, 0, 1, 1)`). Never `ease-in` on UI. `cubic-bezier(0.22, 1, 0.36, 1)` is a safe spring-like default.
4. **Sequences.** Multi-stage sequences stagger 30–80ms, not 200ms. Choreography detail is in [motion.md](motion.md).
5. **Knobs.** MOTION_INTENSITY ≤ 3 → hover states only, no entrances, no scroll-triggered motion. 4–7 → standard entrances and hover, one scroll reveal per section at most. 8+ → scroll-linked motion, page transitions and magnetic cursor are fine (still honor reduced motion).

Output: edit the code, print the Review Format table after each file, and flag every animation you removed and why.

Next: `/agemon-design polish` for the compound details around the motion.

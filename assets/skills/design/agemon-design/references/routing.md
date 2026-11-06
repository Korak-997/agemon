# Routing detail

The ladder, intent table and reference tiers that used to sit in `SKILL.md`. Use it when a request does not map cleanly to a track or action. The reference map in [SKILL.md](../SKILL.md) is the short version.

## The Ladder (use this when explaining agemon-design to the user)

One progression, three rungs. Never describe agemon-design as "layers" or "modes" — use these rung names, and name the rung the user is on before suggesting an action.

| Rung | User wants | They do | They get | Effort |
|------|-----------|---------|----------|--------|
| **0 · Ask** | better UI, zero effort | ask for UI as always | taste by default: real hierarchy, system tokens, no slop | none |
| **1 · Direct** | control one pass | `/agemon-design build`, `review`, `polish`, `harden`, `audit`, `animate` | a focused pass on one surface | one request |
| **2 · Persist** | consistency across sessions | `/agemon-design brief`, `/agemon-design tokens` | durable design context every future session reads | write once |

When a pass finishes, name the natural next step (`build` → `review`, `brief` → `tokens`, `audit` → `harden`).

## Intent routing

Invoke an action as `/agemon-design <action>`, or just say what you want in plain words — "review this page", "write the brief", "harden the settings form" route the same way. The actions are `brief`, `tokens`, `build`, `review`, `polish`, `harden`, `audit` and `animate`; each is defined in [actions.md](actions.md). Anything else routes by the table below.

| Intent | Pass / Reference |
|--------|------------------|
| Pre-build: write the project's design brief | Action `brief` → [actions.md](actions.md#brief), format in [brief.md](brief.md) |
| Pre-build: establish or audit token spine | Action `tokens` → [actions.md](actions.md#tokens), contract in [tokens.md](tokens.md) |
| Build a whole surface in one shot | Action `build <surface>` → [actions.md](actions.md#build); outcome recipes: [recipe-dashboard.md](recipe-dashboard.md), [recipe-landing.md](recipe-landing.md), [recipe-auth.md](recipe-auth.md) |
| Pick a ready-made theme (no token system exists) | [themes.md](themes.md) — 4 production token presets |
| Building new UI | **Build pass** (rung 0/1) — [stage-build.md](stage-build.md) + relevant references |
| Adding/fixing animations | Action `animate` → [actions.md](actions.md#animate) + **Motion pass** — [motion.md](motion.md) |
| Reviewing existing UI, UX critique, no code changes | Action `review` → [actions.md](actions.md#review) + **Review pass** — [review.md](review.md), [inspiration.md](inspiration.md) — ends with a Craft Report |
| Polishing existing UI | Action `polish` → [actions.md](actions.md#polish) + [review.md](review.md) Polish Pass — ends with a Craft Report |
| Multi-stage animations | [motion.md](motion.md) — choreography and stagger |
| Layout / spacing | [layout.md](layout.md) |
| Typography | [typography.md](typography.md) |
| Color / theming / dark mode | [color.md](color.md) |
| Accessibility / technical audit | Action `audit` → [actions.md](actions.md#audit) + [accessibility.md](accessibility.md) |
| Production hardening (states, i18n, edge cases) | Action `harden` → [actions.md](actions.md#harden) + [state-design.md](state-design.md) |
| Amplify personality ("make it bolder") or tone down ("quieter", "more restrained") | [craft-intent.md](craft-intent.md) — raise or lower DESIGN_VARIANCE and MOTION_INTENSITY |
| Purposeful micro-interactions | [motion.md](motion.md) |
| Animation performance | [motion.md](motion.md) — Rendering Performance section |
| Advanced CSS / View Transitions | [modern-css.md](modern-css.md) |
| Sound design | [sound.md](sound.md) |
| UX copy / voice / tone / microcopy | [copy.md](copy.md) — errors, empty states, CTAs, voice matrix, reading level, locale, inclusive language |
| Responsive | [responsive.md](responsive.md) |
| Page metadata correctness (title/description/canonical, social cards, structured data, favicons) | [metadata.md](metadata.md) |
| Three.js / GSAP / Motion | [stack.md](stack.md) — **OPT-IN ONLY — do not load unless the user chose Motion/GSAP/Three.js during intake** |
| PM-ready, severity-ranked heuristic critique | Action `review`, heuristic review → [heuristics.md](heuristics.md) + [personas.md](personas.md) |
| State-first design (before happy path) | [state-design.md](state-design.md) |
| Data visualization / charts / dashboards | [dataviz.md](dataviz.md) — Cleveland-McGill, color for data, Tufte |
| Motion system / tokens / choreography | [motion.md](motion.md) — duration + easing scale, motion budget |
| Wireframe-first: lay out states and content before coding | [state-design.md](state-design.md) — state lattice + content inventory |
| AI / chat / streaming surfaces | [ai-chat.md](ai-chat.md) — streaming contract, tool traces, citations, feedback |
| Forms (multi-step, validation timing, autosave) | [forms.md](forms.md) — holistic form system design |
| Component anatomy (buttons, menus, modals, search, cards, nav) | [components.md](components.md) — contracts below the surface level |
| Pre-ship: full finishing bar before merge | [finish-bar.md](finish-bar.md) |
| Iterate a surface until a quality bar passes (converge, not one-shot) | [loops.md](loops.md) — loop engine + presets |
| Remember a design correction (record as a learned constraint) | [brief.md](brief.md) — Self-Correction |
| Ambiguous | Ask which action |

**Overlap with other skills:** defer marketing copy to a copywriting skill; defer SEO strategy to an SEO skill — agemon-design covers the correctness of metadata already being emitted ([metadata.md](metadata.md)), not keyword or ranking strategy. agemon-design is the visual and interaction layer.

**Out of scope.** These are surface classes the recipes do not help with. Say so, name the right tool, and still apply agemon-design to the web surfaces around them — a brief containing one of these is rarely only that.

| Not this | Use instead |
|---|---|
| Code editor surfaces (syntax, gutters, diff views) | Monaco or CodeMirror with their own theming API |
| Native mobile apps | Apple HIG or Material directly — agemon-design covers web |
| Realtime collaboration UI (presence, live cursors, conflict states) | Liveblocks, or Yjs / Automerge if you own the sync layer — the recipes assume a single actor |
| HTML email | MJML or a dedicated email framework — the CSS rules here are void in mail clients |

Refusing with a pointer beats confident bad output. Silence produces the second one.

## Reference Files

Tiered by signal. Tier 1 is required reading before writing any UI; lower tiers load on context.

### Tier 1 — Always load before writing UI

Two entries, because two is what a build actually loads. This list used to hold seven; build evals showed a passing dashboard opened one of them and a passing landing opened two, while both reached for the surface recipe that was filed a tier below. A required list that nobody reads is not a standard, it is a wish — so the list now names what carries the build, and everything else below states the trigger that pulls it in.

| Reference | When to Read |
|-----------|--------------|
| [craft-intent.md](craft-intent.md) | Craft Read, DESIGN_VARIANCE, signature bets, product + marketing build patterns. The one reference every full-surface build needs. |
| **The surface recipe** | [recipe-dashboard.md](recipe-dashboard.md) · [recipe-landing.md](recipe-landing.md) · [recipe-auth.md](recipe-auth.md) — whichever matches what you are building. Every numeric limit that keeps a surface off template grammar lives here (hero subtext ≤20 words, eyebrow budget, form column width, acceptance bar). Skipping it does not soften those limits, it removes them. |

### Tier 1b — Load on trigger

Same references as before, same weight when their trigger fires. Only the claim changed: these are conditional, and pretending otherwise made the whole Tier-1 label unreliable — including for the two above.

| Reference | Trigger |
|-----------|---------|
| [brief.md](brief.md) | `.ui-craft/brief.md` exists — then read it first, it anchors every decision and its learned constraints override skill defaults. Absent: run `/agemon-design brief` or proceed from [stage-intake.md](stage-intake.md). |
| [tokens.md](tokens.md) | The project has a token system to respect or extend, or you are establishing one. With neither, derive tokens from the brief; [themes.md](themes.md) offers presets only when the user asks for one or no direction exists. |
| [accessibility.md](accessibility.md) | Any form, any custom interactive control, any focus or keyboard work. The a11y floor in [core-rules.md](core-rules.md) is the minimum; this is the detail. |
| [color.md](color.md) | Choosing or changing a palette, building dark mode, or auditing accent budget. Not needed to apply a preset the user asked for. |
| [layout.md](layout.md) | Composing a surface from scratch, or a spacing/hierarchy pass. Not needed when a recipe already prescribes the composition. |
| [inspiration.md](inspiration.md) | Highest-signal reference in the skill. Read it when the build needs an archetype or a signature detail, and whenever the result feels generic. |

> **What this measured, and what it did not.** The evidence is greenfield builds — an empty
> sandbox with no brief and no tokens, so `brief` and `tokens` could not have been read
> whatever the label said. It shows the label was not causing loads. It does **not** show the
> references are unnecessary: `layout` and `color` govern craft that automated checks
> barely cover, so a build can pass every check with mediocre spacing rhythm. Re-measure before
> trimming anything further, and re-measure on a project that already has a design system.

### Tier 2 — Surface-specific (read when building this surface)

| Reference | When to Read |
|-----------|--------------|
| [spec.md](spec.md) | Durable composition spec at `.ui-craft/spec.md` — the "what". Read after `brief.md` when a spec exists for the surface being built. |
| **Outcome recipes** | Promoted to Tier 1 — see *Always load*. Listed there and not here so the recipe has one home; two descriptions of the same requirement is how one of them goes stale. |
| [themes.md](themes.md) | 4 named production token presets (Graphite, Porcelain, Carbon, Signal). Load only when the user asks for a preset or no design direction exists. |
| [dashboard.md](dashboard.md) | Dashboards, metric cards, charts, tables, sidebar, filters. |
| [forms.md](forms.md) | Validation timing, progressive disclosure, multi-step wizards, autosave, optimistic submit. |
| [components.md](components.md) | Component anatomy contracts: buttons (padding ratio, icon-side semantics), menus (5-option threshold, scroll affordance), modals (verb labels, ways out), search, content cards, nav bar. |
| [ai-chat.md](ai-chat.md) | Streaming contract, 7-state affordance model for AI surfaces, tool traces, citations, generative UI. |
| [review.md](review.md) | Critique methodology, Polish Pass, common issues, component craft. Load when reviewing or refining. |
| [finish-bar.md](finish-bar.md) | 10-pass finishing protocol. Load at CRAFT_LEVEL ≥ 8, or when the user asks for a full pre-ship pass. |
| [loops.md](loops.md) | Loop engine: read→evaluate→fix-one→re-evaluate→stop contract + 3 presets. Load when the user asks to iterate a surface or a token audit until a bar passes. |
| [principles-catalog.md](principles-catalog.md) | 42 example design principles across 8 product categories. Load during the `/agemon-design brief` principles workshop branch as conversation seed. |

### Tier 3 — Foundations (read for the relevant discipline)

| Reference | When to Read |
|-----------|--------------|
| [typography.md](typography.md) | Scale, font choice, readability, weight — scoped per script and role. |
| [motion.md](motion.md) | Decision ladder, duration + easing scales with perceptual grounding, interaction rules, motion-gap audit. |
| [modern-css.md](modern-css.md) | View Transitions, scroll timelines, container queries, `@starting-style`. |
| [responsive.md](responsive.md) | Mobile/tablet/desktop, breakpoints, touch zones. |
| [metadata.md](metadata.md) | Title/description/canonical consistency, deterministic metadata, social cards, noindex on staging, structured data honesty, favicons. |
| [tells-2026-11.md](tells-2026-11.md) | Checking your own palette, type and layout plan against what generated interfaces converge on. Calibration only: it never overrides a brand or a brief. |
| [copy.md](copy.md) | Voice/tone matrix, reading level (Flesch ≥70), terminology, inclusive language, errors, empty states, CTAs. |
| [sound.md](sound.md) | Web Audio, UI sound, appropriateness matrix. Rare — load when explicitly building audio feedback. |

### Tier 4 — Opt-in (only on explicit request or specific commands)

| Reference | When to Read |
|-----------|--------------|
| [stack.md](stack.md) | Three.js / GSAP / Motion — **opt-in only — do not load unless the user chose Motion/GSAP/Three.js during intake.** |
| [heuristics.md](heuristics.md) | Nielsen's 10 + 6 design laws (Fitts, Hick, Doherty, Cleveland-McGill, Miller, Tesler) as a checklist. Load for the heuristic review of `/agemon-design review`. |
| [personas.md](personas.md) | 5 persona walkthroughs (first-timer / power / low-bandwidth / screen-reader / one-thumb). Load when a heuristic review names a persona. |
| [state-design.md](state-design.md) | State lattice — idle / loading / empty / error / partial / conflict / offline. Load for `/agemon-design harden` and state-first design. |
| [dataviz.md](dataviz.md) | Cleveland-McGill perceptual hierarchy, chart selection matrix, ColorBrewer/Okabe-Ito palettes, Tufte, direct labeling. Load when designing charts. |


# Core rules

The detail behind the hard rules in [SKILL.md](../SKILL.md). Load this when building or reviewing a whole surface. Brand and brief always win over anything here; the accessibility floor wins over both.

## Knobs (ask during Discovery, 1-10)

Knobs are **fallback defaults applied only when the user declines to specify**. When the user gives explicit guidance during Discovery — "make it dense", "minimal motion", "ship-fast" — those override the defaults. Knobs are not a starting position; they are a graceful fallback.

- **CRAFT_LEVEL** (default 7) — refinement depth. 3 ships fast, 9 is pixel-perfect.
- **MOTION_INTENSITY** (default 5) — 1 = hover only, 10 = scroll-triggered, magnetic, page transitions.
- **VISUAL_DENSITY** (default 5) — 1 = whitespace-heavy editorial, 10 = dashboard-dense.
- **DESIGN_VARIANCE** (default by surface — see [craft-intent.md](craft-intent.md)) — 1 = symmetric/safe layout, 10 = experimental composition. Dashboards default 4; landings 7; portfolios 8. Gates layout risk separately from density.

Behavior: **CRAFT_LEVEL 8+** → run Polish Pass ([review.md](review.md)). **≤4** → skip it. **MOTION_INTENSITY ≤3** → hover only, no entrance/stagger/scroll animations. **4-7** → standard entrances + hover, one scroll reveal max per section. **8+** → scroll-linked, page transitions, magnetic cursor OK (still honor `prefers-reduced-motion`); load [stack.md](stack.md) if user opts in. **VISUAL_DENSITY ≤3** → wide spacing, 1-2 items/row. **8+** → dashboard-dense ([dashboard.md](dashboard.md)). **DESIGN_VARIANCE ≤4** → symmetric grids, safe product layouts. **5-7** → split heroes, alternating rows, one layout break. **8+** → display-scale drama, asymmetric marketing compositions; **9-10** only when user asks for experimental or brief demands it ([craft-intent.md](craft-intent.md)).

## Quick Start: Top 12

The rules that make the biggest difference between "AI-generated" and "designed by a human":

0. **Read before assuming** — never default accent, font, or style. Analyze the project, then ask as [stage-intake.md](stage-intake.md) says. In a non-interactive run, proceed and log assumptions. Use Knob defaults only when the user declines to specify or nobody can answer.
1. **Sentence case by default** — uppercase = template. Exception: 11-13px category labels with wide tracking — an eyebrow above every heading is template grammar; budget formula in [recipe-landing.md](recipe-landing.md) (Eyebrow budget).
2. **Commit to a palette strategy that fits the subject** — mostly-neutral with one accent is one option, not the default; the brief and brand decide ([color.md](color.md) Commitment Axis). NEVER *default* to blue — if your brand is blue, that's different.
3. **Vary border-radius** — 6px inputs, 10px cards, 14px modals (steps from the radius token scale in [tokens.md](tokens.md)); uniform radii look stamped out.
4. **Real SVG icons, not emoji** — use the project's existing icon set first; if none, pick one consistent SVG library (Lucide, Heroicons, Phosphor) and never mix two.
5. **Tight letter-spacing on large headings** — `tracking-tight` or `-0.02em`+ above 24px.
6. **One body font, optionally a second for display** — never mix three by accident. Use the project's fonts. With none, choose from the brief's subject and say why; a font you reach for on every project is a default, not a choice.
7. **Layered shadows over flat borders** — ambient + direct light.
8. **Exit faster than enter** — ~75% of entrance duration.
9. **Plain secondary text for comparisons** — "+12.5% from last month", not a colored pill.
10. **Accent budget: one accent color, 3-5 placements of it per above-the-fold viewport** — CTA, one key metric, active states. **Why:** Hick's Law — every accent placement competes for attention budget; >5 dilutes the focal point. Modals and overlays count as their own viewport.
11. **Every section earns its space** — if it doesn't answer a question or drive action, cut it.
12. **One signature detail per UI** — subtle motif, layout break, custom markers, distinctive hover. When building a whole surface (`/agemon-design build`), pick and **build** it in the first pass ([craft-intent.md](craft-intent.md)) — not only at polish.

> **Before writing ANY code:** For non-trivial projects, check for a design brief and token set first (`/agemon-design brief`, `/agemon-design tokens`) — durable artifacts beat per-session re-derivation. Then run [stage-intake.md](stage-intake.md) and [stage-assets.md](stage-assets.md). Use existing tokens if any token system is present. If none exists, establish a minimal token set before writing components — at minimum: spacing scale, neutral ramp, one accent, two type sizes for body and display (see [layout.md](layout.md) and [color.md](color.md)). If preferences are missing, follow [stage-intake.md](stage-intake.md).

## Core Rules

### The Anti-Slop Test

Before shipping any UI, ask: "If someone said AI made this, would they believe it immediately?" If yes, start over.

**Critical (immediately reads as AI):**
- Identical card grids (icon + heading + text, 3-6x repeated)
- ALL CAPS on headings, labels, tables, nav, buttons (exception: 11-13px category labels)
- Purple/cyan gradient everything
- Emoji as feature icons
- Bounce/elastic easing curves
- Glassmorphism on dark + neon accents

**Major (designers notice):**
- Colored pills on trend percentages — use plain secondary text
- Thick colored left/top borders on cards — use elevation or bg tint
- Uniform border-radius on everything — vary by element
- Gradient text on hero metrics
- Vertical bar charts for time-series — use area/line (horizontal bars OK for categorical)
- `transition: all` — list specific properties
- Decorative glow as primary affordance
- Soft blurry gradient blobs/orbs
- Generic CTAs ("Learn more", "Click here") — be specific
- Walls of text — no landing section > 2-3 sentences
- "OR" divider in caps between auth options — lowercase it: "or with email"
- Full-bleed saturated brand panel beside a sign-in form — tinted neutral surface with one proof asset ([recipe-auth.md](recipe-auth.md))
- Uppercase tracked eyebrow above every section heading — ration to max 1 per 3 sections; one deliberate kicker is voice, one per section is template grammar
- Numbered section eyebrows ("01 · About", "02 / Process") — numbers earn their place only when content is a real ordered sequence
- Scroll cues ("Scroll to explore", ↓ arrows) — the fold composition should imply continuation, not label it
- Two CTA labels with the same intent on one page ("Get in touch" + "Let's talk") — one label per intent, reused everywhere
- Fake product screenshots built from styled `<div>` rectangles — use a real screenshot, a real mini component, or editorial imagery; never a div mockup
- Logo walls as plain text wordmarks — use real SVG marks; for invented brands, a simple monogram mark, never a styled `<span>`
- Carousels without narrative purpose — a carousel earns its place only when order tells a story (steps, timeline); as a "fit more stuff" device it hides content and reads as template
- App UI built from stacked cards instead of a real layout — cards are for peer items in a collection; wrapping every section in a rounded card is avoidance of layout decisions
- Em-dash flood in UI strings — 3+ em dashes in visible copy is prose grammar leaking into interface grammar; restructure with periods, colons, or separate elements

**Minor** (polish that separates good from great — full list in [review.md](review.md) Polish Pass): no `tabular-nums` on data, missing `text-wrap: balance`, straight quotes, no `&nbsp;` in brand names, testimonial star ratings, hero metric without adjacent context.

### The Craft Test (What TO Do)

Anti-slop says what to avoid. Craft says what to aim for.

**General craft:**
- One accent, 3-5 placements per above-the-fold viewport. Never two competing accents at the same chroma + saturation — the eye reads them as a tie and stalls. Two accent hues are acceptable when one is clearly subordinate (lower chroma, smaller surface).
- White backgrounds with barely-there borders or whitespace. Numbers large, undecorated, `tabular-nums`.
- Comparisons plain secondary text. One chart color at different opacities. Area fill fades ~15% → 0%.
- Functional color only — dots for status, flags for countries. Real content, not placeholders.

**Landing pages** (detail in [inspiration.md](inspiration.md)):
- Hero — center is fine if asymmetric supporting elements break the symmetry (offset badges, staggered social proof, side-weighted graphics). Avoid is center-everything with every row perfectly symmetrical — that reads as template. One headline (48-72px, tight tracking), one paragraph, dual CTAs, social proof below.
- Features: 2-3 asymmetric rows with real visuals (chart, timeline, funnel). NEVER uniform 3-column icon grids.
- Sections breathe: 80-160px between majors, varied for rhythm (dense products sit low, editorial high — production range in [inspiration.md](inspiration.md)). Every section answers one question.
- Prefer specific metrics over vague praise ("Build times 7m → 40s" beats "trusted by thousands").

**Dashboards** (detail in [dashboard.md](dashboard.md)):
- Sidebar: subtle bg tint, NOT full dark (common AI pattern).
- Metric cards: primary gets accent tint; others neutral. Sparklines only where a trend is the question the card answers. NEVER identical colored top borders.
- At least 3 content types per dashboard viewport (e.g., chart + table + metric). **Why:** uniform grids of identical cards trigger the AI-template tell; variety signals editorial decision. Chart type matches data story (area/horizontal bar/sparkline). Never pie or 3D.

### When Rules Break

Every rule above has a context where it inverts. Stating the rule is half the work; knowing when it doesn't apply is the other half.

- **"Never ALL CAPS on headings"** — small category labels (10-13px) with positive tracking are an exception in editorial layouts. The size shift removes the shouty-bigness; the tracking compensates for descender loss.
- **"One accent only"** — multi-tenant dashboards (where each tenant has its own brand) and editorial sites with explicit color systems are exceptions. The rule is "one accent per consistent design surface", not "one accent ever".
- **"Avoid pie charts"** — for two-segment proportional comparisons (e.g., used vs. free storage on a single device), a donut with center label is acceptable. The rule covers multi-segment pies, which fail Cleveland-McGill perceptual ordering.
- **"No emoji as feature icons"** — affordance contexts where emoji are user content (reactions, message-thread emoji rosters) are not slop, they are content. The rule covers decorative emoji standing in for designed icons.
- **"Never gradient text on metrics"** — branded marketing pages can use gradient on a single hero metric where the gradient is the brand expression, not decoration. Inside-the-product metrics still follow the rule.
- **"Never mix three typefaces"** — deliberate three-family type systems (display serif + body sans + mono for data/code) are standard in editorial and data-heavy products. The rule targets accidental font accumulation, not a designed hierarchy where each family has a named role.

**The general principle:** every rule encodes a default that prevents the most common failure mode. When the context inverts the failure mode, the rule may invert too. The work is recognizing the inversion, not memorizing exceptions.

### Convergence

Actions can iterate until their stated checks pass rather than producing a single-shot output. Never fake a render; report honestly what was and was not checked. See [loops.md](loops.md).

### Self-Correction

When the user corrects design output — "not like that", "I don't like this", "always do X here", "never Z", or a reversal that reads as a standing preference — record it as a **learned constraint** in the brief (section 6). Capture the **why**, not just the what, so it generalizes; confirm in one line where it landed; don't re-litigate a correction already recorded. Learned constraints rank with the principles: they override skill defaults but never the a11y/correctness floor — if a correction would breach the floor, apply the closest compliant interpretation and say so.

This is project-scoped and lives in the brief by design — agemon-design is a UI skill, not a general memory engine. Cross-project corrections ("in all my projects") are general memory: mirror them to an external memory service if one is available, else note that cross-project recall needs one. Full behavior → [brief.md](brief.md) (Self-Correction).

### Animation Decision Ladder

> **Should this animate?** → High-frequency? No. Not communicating hierarchy/state/space? Cut it. Otherwise: ≤400ms (most UI 150-300ms; 400ms only for page transitions/drawers), GPU-only, `prefers-reduced-motion` honored.

Full ladder, easing, springs, stagger, interaction contract → [motion.md](motion.md) (**Decision Ladder**).

### Design Rules (core)

Layered shadows (ambient + direct). Semi-transparent borders + shadows for crisp edges. Hue-consistent borders/shadows/text on colored surfaces. APCA over WCAG 2. Interactions increase contrast. `color-scheme` + `theme-color` match theme. OKLCH for scales. Full detail in [layout.md](layout.md) and [color.md](color.md).

## Review Format (Required)

When reviewing UI code, use a markdown table. Never use "Before:"/"After:" on separate lines.

| Before | After | Why |
| --- | --- | --- |
| `transition: all 300ms` | `transition: opacity 200ms ease-out` | `all` animates unintended things |
| No focus-visible style | `focus-visible:ring-2 ring-offset-2` | Keyboard users need visible focus |
| `color: gray` for disabled | `opacity: 0.5` + `cursor: not-allowed` | Multiple signals, not just color |

Prioritize findings by impact:
1. **Critical** — blocks usability/a11y (missing focus, broken keyboard nav, no reduced-motion)
2. **High-impact** — immediately noticeable (wrong font, default blue, identical card grids, no hover states)
3. **Quick wins** — big polish (tabular-nums, letter-spacing, curly quotes, `&nbsp;`)

---

## Quick Decision Frameworks

### Should This Animate?

| Frequency | Decision |
|-----------|----------|
| High (keyboard, toggles, typing) | No animation. Speed is the feature. |
| Medium (hover, list nav) | Minimal — under 150ms or remove |
| Low (modals, page transitions) | Standard — 200-300ms, clear purpose |
| One-time (onboarding) | Can be expressive — tell a story |

### Motion Budget

| Element | Budget |
|---------|--------|
| Color/opacity | 100-150ms |
| Small UI (tooltips, dropdowns) | 150-200ms |
| Medium UI (modals, panels) | 200-300ms |
| Large UI (page transitions, drawers) | 300-400ms |

Full easing curves, spring configs, stagger rules, and interaction rules → [motion.md](motion.md).

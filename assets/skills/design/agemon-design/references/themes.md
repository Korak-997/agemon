# Theme Presets

Four named, production-ready token stacks. Each is a complete primitive layer for the 3-layer contract in [tokens.md](tokens.md) — map these into your semantic tokens, don't reference them raw from components. If the project has tokens, those win ([stage-assets.md](stage-assets.md)).

**Presets are opt-in starting points.** Use one only when the user asks for it, or when there is no brand and no direction at all. Rotate each preset's accent for the brief (see Accent rotation below); the accents shown are placeholders, not recommendations. Several presets sit close to the looks in [tells-2026-11.md](tells-2026-11.md), and a near-black page with one bright accent is a current tell in its own right.

These are not "styles to sprinkle". A preset is all-or-nothing: mixing Porcelain's radii with Carbon's shadows produces incoherence that reads as generated.

**Contrast rule for all presets:** before shipping, verify text pairs with APCA — Lc ≥ 75 for body text, Lc ≥ 60 for large text (≥24px), Lc ≥ 45 for non-text UI. The pairs below are chosen to clear these; re-verify after any tweak.

**Default usage:** light mode unless the user asks for dark. Every preset defines both; both must be intentional ([color.md](color.md) dark-mode rules).

**Motion tokens:** each preset's `--motion-*` values intentionally override the canonical scale in [motion.md](motion.md) — pace is part of the aesthetic (Signal is fast, Porcelain unhurried). When a preset is active, its values win; the motion.md scale is the default when building without a preset. All values stay within the ≤400ms ceiling.

---

## Graphite — minimal clean

Cool neutrals, one deep accent, hairline borders, tight type. Suits SaaS tools, admin surfaces, and the Command/Overview dashboard compositions when the brief asks for quiet. It is close to the SaaS card kit, so vary radii by rank and do not repeat one shadow on every card. Disappears behind the data — which is the point.

```css
:root {
  /* neutrals — cool, hue 255 */
  --gray-0:   oklch(99% 0.002 255);   /* page */
  --gray-1:   oklch(97% 0.003 255);   /* raised surface, sidebar tint */
  --gray-2:   oklch(93% 0.004 255);   /* hairlines, dividers */
  --gray-3:   oklch(86% 0.005 255);   /* disabled fills */
  --gray-6:   oklch(55% 0.012 255);   /* secondary text */
  --gray-7:   oklch(42% 0.014 255);   /* tertiary headings */
  --gray-9:   oklch(18% 0.012 255);   /* primary text */

  /* accent — deep indigo */
  --accent:        oklch(46% 0.17 275);
  --accent-hover:  oklch(41% 0.17 275);
  --accent-tint:   oklch(46% 0.17 275 / 0.08);
  --on-accent:     oklch(99% 0.002 255);

  /* semantic */
  --success: oklch(52% 0.13 155);
  --warning: oklch(62% 0.14 75);
  --danger:  oklch(52% 0.18 25);

  /* type — one grotesque sans for everything */
  --font-body: var(--font-sans);       /* the project's font, else chosen from the brief; system-ui acceptable */
  --text-body: 14px / 1.5;
  --text-display: 28px;                 /* metrics; 36px for hero */
  --tracking-display: -0.02em;

  /* shape + depth */
  --radius-input: 0.375rem;  --radius-card: 0.625rem;  --radius-modal: 0.875rem;
  --shadow-card: 0 0 0 1px oklch(0% 0 0 / 0.04), 0 1px 2px oklch(0% 0 0 / 0.05);
  --shadow-overlay: 0 0 0 1px oklch(0% 0 0 / 0.05), 0 8px 24px oklch(0% 0 0 / 0.12);

  /* motion */
  --motion-fast: 120ms;  --motion-base: 200ms;  --motion-slow: 320ms;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
}
```

**Dark mapping:** page `oklch(15% 0.012 255)`, raised `oklch(19% 0.012 255)`, hairline `oklch(26% 0.012 255)`, text `oklch(93% 0.004 255)`, accent lifts to `oklch(62% 0.15 275)`, shadows replaced by surface lightness steps.

---

## Porcelain — soft modern

Warm neutrals, a deep teal accent (moved off terracotta, which with cream and a serif is a tell), generous radius, soft layered shadows. Do not add a high-contrast serif display and cream ground on top of this unless the brief asks. For products that want approachable over technical: consumer SaaS, onboarding-heavy tools, health/finance for humans. Pairs with VISUAL_DENSITY ≤ 5.

```css
:root {
  --gray-0:   oklch(98.5% 0.004 80);
  --gray-1:   oklch(96.5% 0.006 80);
  --gray-2:   oklch(92% 0.008 80);
  --gray-3:   oklch(85% 0.009 80);
  --gray-6:   oklch(54% 0.015 70);
  --gray-9:   oklch(22% 0.015 60);

  --accent:        oklch(50% 0.10 205);
  --accent-hover:  oklch(45% 0.10 205);
  --accent-tint:   oklch(50% 0.10 205 / 0.09);
  --on-accent:     oklch(98.5% 0.004 80);

  --success: oklch(56% 0.12 150);
  --warning: oklch(66% 0.13 80);
  --danger:  oklch(54% 0.17 28);

  /* type — humanist sans body, optional rounded display */
  --text-body: 15px / 1.55;
  --text-display: 30px;
  --tracking-display: -0.015em;

  --radius-input: 0.625rem;  --radius-card: 0.875rem;  --radius-modal: 1.25rem;
  --shadow-card: 0 1px 2px oklch(30% 0.02 60 / 0.06), 0 4px 12px oklch(30% 0.02 60 / 0.06);
  --shadow-overlay: 0 2px 4px oklch(30% 0.02 60 / 0.08), 0 16px 40px oklch(30% 0.02 60 / 0.14);

  --motion-fast: 140ms;  --motion-base: 220ms;  --motion-slow: 360ms;
  --ease-out: cubic-bezier(0.22, 1, 0.36, 1);
}
```

**Dark mapping:** keep the warm hue — page `oklch(17% 0.012 70)`, raised `oklch(21% 0.012 70)`; accent lifts to `oklch(70% 0.10 205)`. Warm dark is this preset's signature; switching to cool dark breaks it.

---

## Carbon — dark premium

Dark-first. Deep cool neutrals, elevation by surface tint (not shadow), one restrained luminous accent. A near-black page with a single bright accent is a current tell, so use Carbon only when the brief asks for dark or the product really is used for hours in the dark (developer tools, monitoring, pro audio/video), and rotate the accent. Not because the category is technical. Light mode exists but dark is primary.

```css
:root {  /* dark IS the root */
  --surface-0: oklch(14% 0.012 260);   /* page */
  --surface-1: oklch(17.5% 0.012 260); /* card */
  --surface-2: oklch(21% 0.012 260);   /* raised: popover, hover */
  --surface-3: oklch(25% 0.012 260);   /* highest: modal */
  --line:      oklch(28% 0.012 260);   /* hairlines */
  --text-1:    oklch(93% 0.005 260);
  --text-2:    oklch(70% 0.01 260);
  --text-3:    oklch(52% 0.012 260);

  --accent:        oklch(76% 0.10 235);  /* luminous sky blue — reads as light, not paint */
  --accent-hover:  oklch(82% 0.10 235);
  --accent-tint:   oklch(76% 0.10 235 / 0.10);
  --on-accent:     oklch(8% 0.008 260);  /* near-true black — the 14% surface tone fails Lc 60 here */

  --success: oklch(74% 0.12 155);
  --warning: oklch(78% 0.13 85);
  --danger:  oklch(68% 0.16 25);

  --text-body: 14px / 1.5;
  --text-display: 28px;
  --tracking-display: -0.02em;
  /* numbers and code in mono; tabular-nums everywhere */

  --radius-input: 0.375rem;  --radius-card: 0.625rem;  --radius-modal: 0.875rem;
  /* NO drop shadows — elevation = surface step + 1px line. Glow only on the
     single primary CTA, subtle: 0 0 16px var(--accent-tint) */

  --motion-fast: 120ms;  --motion-base: 180ms;  --motion-slow: 300ms;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
}
```

**Light mapping (secondary):** invert the surface ladder onto Graphite's neutrals; accent darkens to `oklch(50% 0.13 235)`. Don't ship light-Carbon as default — if light is the primary need, pick Graphite.

---

## Signal — sharp geometric

High-contrast, near-mono neutrals, semantic color doing real work, minimal radius, zero decorative depth. It sits near the broadsheet look (hairlines, small radius, dense columns), so use it when density is the actual need. For dense data products — the Analytics composition, trading-adjacent surfaces, ops consoles at VISUAL_DENSITY ≥ 8.

```css
:root {
  --gray-0:   oklch(100% 0 0);
  --gray-1:   oklch(97% 0 0);
  --gray-2:   oklch(91% 0 0);
  --gray-6:   oklch(50% 0 0);
  --gray-9:   oklch(12% 0 0);

  --accent:        oklch(40% 0.16 264);   /* one decisive blue-violet — used ONLY for selection + primary action */
  --accent-hover:  oklch(34% 0.16 264);
  --accent-tint:   oklch(40% 0.16 264 / 0.08);
  --on-accent:     oklch(100% 0 0);

  /* semantic carries the information load — held to dots, deltas-on-demand, alerts */
  --success: oklch(50% 0.15 150);
  --warning: oklch(60% 0.15 70);
  --danger:  oklch(50% 0.20 25);

  /* type — body sans, ALL numerals mono */
  --text-body: 13px / 1.45;
  --font-data: var(--font-mono);
  --text-display: 26px;
  --tracking-display: -0.01em;

  --radius-input: 0.125rem;  --radius-card: 0.375rem;  --radius-modal: 0.625rem;
  --shadow-card: none;                      /* 1px hairline only */
  --shadow-overlay: 0 0 0 1px oklch(0% 0 0 / 0.08), 0 6px 20px oklch(0% 0 0 / 0.10);

  --motion-fast: 100ms;  --motion-base: 160ms;  --motion-slow: 240ms;  /* speed IS the aesthetic */
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
}
```

**Dark mapping:** pure-neutral dark — page `oklch(13% 0 0)`, card `oklch(16.5% 0 0)`, hairline `oklch(25% 0 0)`; accent lifts to `oklch(70% 0.13 264)`; semantic hues lift ~20% lightness. The mono-numeral rule does not relax in dark.

---

## Choosing

| Signal in the brief | Preset |
|---|---|
| "clean", "professional", internal tool, quiet is wanted | **Graphite** |
| "friendly", "approachable", consumer-facing, onboarding matters | **Porcelain** |
| "developer tool", "pro", users live in it at night | **Carbon** |
| "dense", "fast", data is the product, power users | **Signal** |

No row fits? Do not pick one to have a default; derive tokens from the brief's subject. Brand color exists? Replace `--accent` with the brand hue at the preset's lightness/chroma discipline — the preset survives an accent swap; it does not survive a radius or shadow swap.

---

## Accent rotation (no brand yet)

When the brief has no brand color, **rotate one accent family per build** so outputs don't all land on indigo. Declare the choice in the Craft Read ([craft-intent.md](craft-intent.md) §6). Swap only `--accent`, `--accent-hover`, `--accent-tint`, and `--on-accent` on the chosen preset — keep neutrals, radii, and shadows intact.

| Family | Light `--accent` (OKLCH) | Best on preset | Avoid pairing with |
|---|---|---|---|
| **Indigo** | `oklch(46% 0.17 275)` | Graphite, Signal | — (over-used; rotate away often) |
| **Teal** | `oklch(48% 0.12 195)` | Graphite, Carbon | Porcelain's own teal |
| **Rose** | `oklch(52% 0.14 15)` | Porcelain, Graphite | Signal high-contrast grids |
| **Amber** | `oklch(58% 0.14 75)` | Porcelain, Graphite, Carbon (lift lightness on dark) | Signal's warning color |
| **Forest** | `oklch(46% 0.11 155)` | Porcelain, Graphite | Signal blue-violet default |

Three of the four presets ship a cool placeholder accent (indigo, blue, blue-violet) and Porcelain ships teal, which is cool too; that is an accident of the examples, not a lean. Rotate to a warm or green family whenever the brief allows.

**Hover / tint discipline:** `--accent-hover` ≈ 5% darker on the same hue; `--accent-tint` ≈ 8–10% alpha of accent; `--on-accent` must clear APCA Lc ≥ 60 against the filled button.

**Dark mode:** lift accent lightness ~15–20% on dark surfaces (see each preset's dark mapping). Re-verify contrast after swap.

**Marketing vs product:** landings and portfolios may rotate accent **and** theme preset; dashboards and auth rotate accent only unless the user asks for a full re-skin.

## Premium palette families (artisan / luxury / wellness briefs)

"Premium" briefs converge on one palette — warm cream background, brass/clay accent, espresso text — until every generated artisan site is interchangeable. Unless the brief names those colors, rotate through distinct families (one per build, never the same family twice in a row):

| Family | Recipe | Reads as |
|---|---|---|
| **Cold luxury** | silver-grey neutrals + chrome + smoke dark | precision, engineering premium |
| **Forest** | deep green + bone + amber accent | outdoor heritage, built-to-last |
| **Black & tan** | true off-black + warm tan, hard contrast, no beige | leather-goods, deliberate |
| **Cobalt + cream** | one saturated blue against a single neutral | confident, modern craft |
| **Terracotta + slate** | warm rust against cool grey | earthy without the beige wash |
| **Mono + pop** | off-white + off-black + one bright accent | gallery, editorial-modern |

Warmth can come from typography, imagery, and copy — it doesn't have to live in the background color. Verify AA contrast after picking; dark-mode mapping per the preset rules above.

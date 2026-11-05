# Heuristics — Severity-Ranked Review Methodology

Any skill can list anti-patterns. A heuristic review is a defensible artifact a PM can action: every finding names a heuristic or law, the element it applies to, the viewport it was seen at, and an impact tag. This file is the source of truth for the heuristic mode of `/agemon-design review` — the checklist, the laws, the output shape. It produces findings, not numbers: a figure computed from model judgment reads as a measurement it is not.

---

## How to Use

Run the full pass: Nielsen's 10 as a checklist → the 6 Design Laws as checks → rank findings by impact tag. Output is a findings table PMs can paste into any issue tracker.

Usability is not a knob. `CRAFT_LEVEL` does not relax these findings — a blocking problem is blocking at every craft level.

---

## Finding Format

Every finding is one row: `| Heuristic or law | Element | Viewport | Finding | Impact |`.

- **Element** names the specific thing: "Save button in the settings form", not "the form".
- **Viewport** is where you saw it (desktop 1280, tablet 768, mobile 375, or "code only" if you did not render it).
- **Finding** is concrete: quote the text, count the elements, name the broken flow. Vague findings are rejected.
- A heuristic with nothing to report gets no row. Do not pad the table with praise.

---

## Nielsen's 10 Usability Heuristics

Source: Nielsen, J. (1994). "10 Usability Heuristics for User Interface Design." Nielsen Norman Group.

### 1. Visibility of System Status

The system should always keep users informed about what is going on, through appropriate feedback within reasonable time.

**What to look for:**
- [ ] Every async action has a loading state (spinner, progress, skeleton)
- [ ] Submit buttons disable + show progress while in flight
- [ ] Optimistic UI reconciles on server response (no silent failure)
- [ ] Navigation state is visible (active tab, breadcrumb, selected row)
- [ ] Long operations (>5s) escalate to progress percentage or estimate

**Common failures in AI-generated UIs:**
- Form submit has no loading state — user clicks 3-4x thinking nothing happened
- Toast appears then disappears before the user can read it
- No indication that a save succeeded ("did it work?")

### 2. Match Between System and the Real World

Speak the user's language — words, phrases, concepts they know. Follow real-world conventions.

**What to look for:**
- [ ] No system jargon in user-facing copy ("exception thrown", "null ref")
- [ ] Icons match cultural convention (trash = delete, not a cog)
- [ ] Dates are formatted for the user's locale, not ISO
- [ ] Error messages speak human, not stack trace
- [ ] Metaphors are consistent (folder, file, workspace)

**Common failures in AI-generated UIs:**
- "Submit payload" instead of "Save changes"
- "Entity not found" instead of "We couldn't find that project"
- Time displayed as `1713369600` (Unix) instead of `2 hours ago`

### 3. User Control and Freedom

Users often perform actions by mistake. They need a clearly marked emergency exit.

**What to look for:**
- [ ] Every destructive action has Undo (preferred) or a confirm dialog
- [ ] Modals close on Esc and on backdrop click
- [ ] Multi-step flows have Back without losing state
- [ ] Autosave preserves in-progress work on nav away
- [ ] URL reflects state so the back button works

**Common failures in AI-generated UIs:**
- Delete is instant and irreversible — no undo toast
- Modal traps the user; no way out without completing the form
- Browser back loses all form input

### 4. Consistency and Standards

Users should not have to wonder whether different words, situations, or actions mean the same thing. Follow platform conventions.

**What to look for:**
- [ ] Primary action placement consistent across views (right side, solid fill)
- [ ] Same verb for same operation throughout ("Delete" always, not "Delete"/"Remove"/"Trash")
- [ ] Icon meanings stable across screens
- [ ] Form patterns match platform (e.g., Cmd+Enter submits on macOS)

**Common failures in AI-generated UIs:**
- Buttons swap position between modals (Cancel left here, right there)
- Three different words for "delete" in the same product
- Non-standard scroll hijacking on a standard content page

### 5. Error Prevention

Better than good error messages is a design that prevents the problem from occurring in the first place.

**What to look for:**
- [ ] Destructive actions require confirmation typed with the resource name
- [ ] Disabled states prevent invalid submissions (with explanation on hover)
- [ ] Input constraints enforced client-side (date pickers, typed inputs)
- [ ] Autosave + version history on content-creation surfaces
- [ ] Warn before leaving unsaved changes

**Common failures in AI-generated UIs:**
- Freeform "Are you sure?" confirms that users mindlessly click
- No validation until submit; user fills 12 fields then sees 4 errors
- Paste blocked on fields (password confirm, order IDs)

### 6. Recognition Rather Than Recall

Minimize the user's memory load by making objects, actions, and options visible.

**What to look for:**
- [ ] Recently used / favorited items surfaced
- [ ] Autocomplete on any field with a known set of answers
- [ ] Keyboard shortcuts listed in tooltips (not hidden in a help menu)
- [ ] Current selection persists visibly
- [ ] Empty states suggest next actions

**Common failures in AI-generated UIs:**
- Power-user shortcuts (Cmd+K) exist but are undiscoverable
- User must remember which tab they were on after a refresh
- Dropdown with 200 options and no search

### 7. Flexibility and Efficiency of Use

Accelerators — unseen by novice — may speed up the interaction for the expert.

**What to look for:**
- [ ] Keyboard shortcuts for frequent actions (Cmd+K, j/k nav)
- [ ] Bulk actions on lists (multi-select + batch operate)
- [ ] Saved views / filters / segments
- [ ] Customization for heavy users (column config, hotkeys)
- [ ] Paste-to-action patterns (URL paste auto-parses)

**Common failures in AI-generated UIs:**
- Forces the same flow for novice and expert
- No way to multi-select in lists of 100+
- Command palette missing on tools users will spend hours in

### 8. Aesthetic and Minimalist Design

Dialogues should not contain information that is irrelevant or rarely needed.

**What to look for:**
- [ ] Every section answers one question; no filler
- [ ] Visual weight proportional to importance
- [ ] One accent, 3-5 placements per viewport (see SKILL.md anti-slop)
- [ ] White space is used, not avoided
- [ ] No decorative graphics competing with content

**Common failures in AI-generated UIs:**
- Hero has 4 CTAs of equal weight
- Every card has a colored top border
- Gradient backgrounds on every section

### 9. Help Users Recognize, Diagnose, and Recover From Errors

Error messages in plain language, precisely indicate the problem, and constructively suggest a solution.

**What to look for:**
- [ ] Errors appear inline, at the field, not as a global banner
- [ ] Messages specify what went wrong AND how to fix it
- [ ] Server errors include a copy-to-clipboard ID for support
- [ ] Recovery is one click (retry, undo, contact support)
- [ ] Network errors differ from validation errors

**Common failures in AI-generated UIs:**
- "Something went wrong" with no detail, no retry, no support path
- Red toast that disappears before the user reads it
- Error blames the user ("Invalid input") instead of explaining

### 10. Help and Documentation

Even though it is better if the system can be used without documentation, help may be necessary.

**What to look for:**
- [ ] Help is contextual, not a separate site the user must leave to
- [ ] Empty states double as onboarding ("Create your first project")
- [ ] Tooltips on non-obvious icons
- [ ] Inline help links in complex forms
- [ ] Searchable docs for deep features

**Common failures in AI-generated UIs:**
- No tooltips on icon-only buttons
- Help buried behind a "?" in the corner with a 404 behind it
- Onboarding is a 10-slide lightbox the user skips

---

## The 6 Design Laws

Each is checked against a specific element. These are physics + psychology, not preferences — breaking them has measurable UX impact.

### Fitts's Law

Source: Fitts, P. M. (1954). "The information capacity of the human motor system in controlling the amplitude of movement."

**Statement:** Time to acquire a target is a function of its size and distance.

**When load-bearing:** Every tappable / clickable surface. Critical on mobile.

**What to look for:**
- **Holds when** touch targets ≥ 44px on mobile, ≥ 24px on desktop; primary CTA in the natural eye/thumb path; related actions grouped
- **Breaks when** touch targets under 44px mobile; destructive actions adjacent to primary actions; CTA placed far from where the user just looked

### Hick's Law

Source: Hick, W. E. (1952). "On the rate of gain of information."

**Statement:** Decision time grows logarithmically with the number of choices.

**When load-bearing:** Menus, navigation, plan selectors, form fields, dashboards.

**What to look for:**
- **Holds when** nav ≤ 7 items at any level; no field offers 20+ unfiltered options without search
- **Breaks when** 12+ top-nav items; a single select with 200 entries and no type-ahead; dashboard with 18 metrics at equal weight

### Doherty Threshold

Source: Doherty, W. J. & Thadani, A. J. (1982). "The Economic Value of Rapid Response Time." IBM.

**Statement:** Productivity soars when response time is under 400ms.

**When load-bearing:** Every user-initiated action. Critical on data-heavy views and transitions.

**What to look for:**
- **Holds when** perceived response < 400ms; optimistic UI for saves, likes, toggles; skeletons within 200ms
- **Breaks when** form submit shows a spinner for 2s with no optimistic state; nav click waits on full server round-trip before painting anything

### Cleveland-McGill Hierarchy

Source: Cleveland, W. S. & McGill, R. (1984). "Graphical Perception: Theory, Experimentation, and Application to the Development of Graphical Methods." JASA.

**Statement:** Humans decode visual encodings with different accuracy — position > length > angle > area > color-hue.

**When load-bearing:** Every chart, metric card, comparative dataviz.

**What to look for:**
- **Holds when** quantitative comparisons use position or length (bar, line, dot); color reserved for category; no pie or 3D
- **Breaks when** pie chart used for comparison; donut with ≥ 5 slices; color-gradient used to encode magnitude where length would work

### Miller's Law

Source: Miller, G. A. (1956). "The Magical Number Seven, Plus or Minus Two."

**Statement:** Humans hold ~7 (±2) items in working memory. Chunking extends this.

**When load-bearing:** Nav depth, form section counts, onboarding flows, step counts.

**What to look for:**
- **Holds when** navigation ≤ 7 items per level; forms chunked into ≤ 5 sections; multi-step flows ≤ 5 steps or with clear progress. (Wizard ceiling is 5, not 7: each step holds multiple fields, and each field consumes working-memory slots of its own.)
- **Breaks when** 14-item top nav; a single-page form with 23 ungrouped fields; a checkout with 9 steps and no progress indicator

### Tesler's Law

Also called the Law of Conservation of Complexity. Attributed to Larry Tesler.

**Statement:** Every application has an irreducible amount of complexity. The only question is who deals with it — the user, the UI, or the backend.

**When load-bearing:** Feature-rich tools. Configuration-heavy flows. Anywhere you're tempted to "expose a toggle."

**What to look for:**
- **Holds when** complexity absorbed by sensible defaults, automation, or backend inference; advanced controls behind progressive disclosure
- **Breaks when** UI exposes every backend knob; user must configure 8 things before they can accomplish the primary task; no default state, only empty forms

---

## Impact Tags

Every finding carries exactly one impact tag. This is how a PM prioritizes:

| Tag | Meaning | Example |
|-----|---------|---------|
| `blocks-conversion` | User cannot complete the core journey | Signup form submit silently fails on network error |
| `adds-friction` | User completes but abandonment rate rises | Submit button has no loading state; users click 3-4x |
| `reduces-trust` | Quality signal — affects retention | Typos in error messages; inconsistent button styles |
| `minor-polish` | Craft layer only; no measurable user impact | Missing `tabular-nums` on a metric |

Rank findings in the final output by impact tag, not by heuristic order: `blocks-conversion > adds-friction > reduces-trust > minor-polish`.

---

## Output Format

The heuristic review outputs **exactly** this structure. Do not invent new sections. Do not merge tables. Do not drop the ranking at the end. Do not add a score, grade or pass/fail verdict.

```markdown
## Heuristic Findings

| Heuristic | Element | Viewport | Finding | Impact |
|-----------|---------|----------|---------|--------|
| Visibility of system status | Submit button, signup form | mobile 375 | No loading state; users click 3-4x thinking nothing happened | adds-friction |
| User control and freedom | Delete confirm dialog, project list | desktop 1280 | Confirm exists but there is no undo after it lands | reduces-trust |
| Consistency and standards | Cancel button, billing modal | desktop 1280 | Cancel on the right here, on the left in every other modal | minor-polish |
| Flexibility and efficiency | Invoice list, 200+ rows | desktop 1280 | No bulk select | adds-friction |
| Error recovery | Error banner, checkout | mobile 375 | "Something went wrong" with no ID, no retry | blocks-conversion |

## Design Law Findings

| Law | Element | Viewport | Detail | Impact |
|-----|---------|----------|--------|--------|
| Fitts's Law | Primary CTA, pricing card | mobile 375 | 32px tall; expected ≥ 44px | adds-friction |
| Doherty Threshold | Save button, settings | desktop 1280 | Spinner for ~1.8s with no optimistic state | adds-friction |
| Tesler's Law | First-run form | desktop 1280 | 8 required config fields before the first action | reduces-trust |

## Top findings (ranked by impact)

1. Error recovery (blocks-conversion) — "Something went wrong" banner strands users in checkout on mobile; no ID, no retry, no support path
2. Fitts's Law (adds-friction) — primary CTA on the pricing card is 32px on mobile; raise to ≥ 44px
3. Doherty Threshold (adds-friction) — save feels broken on desktop; add optimistic UI
4. Flexibility and efficiency (adds-friction) — bulk select missing on the 200+ row invoice list
5. Visibility of system status (adds-friction) — signup submit has no loading state on mobile
```

**Notes on output:**
- Use the short name for each heuristic (not the verbose Nielsen title). The heuristic is unambiguous from context.
- The `Top findings` list is a rank, not a re-listing. Include only findings at `reduces-trust` or worse. Cap at 5.
- Laws and heuristics that hold up get no row. If you want to say what is working, say it in one line after the ranking, not in the tables.

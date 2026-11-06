# Stage 5: Verify

Checks objective facts. Code checks facts; a model finds located defects; a person decides taste.

## Needs

The changed files, and a running page if one can be rendered.

## Does

Run in this order, and report anything you could not run as `not-verified`, never as passed.

1. **The repo's own lint, type check and tests,** when they cover the changed files.
2. **Source read:** placeholder copy ("Lorem ipsum", "John Doe"), raw values beside a matching token, missing states. Do not judge contrast from source; list it as `not-verified` until rendered.
3. **Rendered checks,** if you can run a browser, at about three widths (around 375, 768 and 1280 px), using viewport shots rather than full-page images, because downsizing hides small type. Save shots under `.design/shots/`, uncommitted.

**Only these can block:** rendered contrast failures, target size failures, horizontal overflow, console errors after filtering out unrelated noise, and placeholder copy. Fix a blocker or report it as still failing. Aesthetics stay advisory: list them, and record any waiver the user gives along with who gave it.

With no browser, finish the run, report every rendered check as `not-verified`, say "Not visually verified" and ask the user to look. [accessibility.md](accessibility.md), [responsive.md](responsive.md) and [finish-bar.md](finish-bar.md) hold the detail for each check. A passing run does not mean a good design.

## Produces

`.design/verify.md`: a findings list with each check marked `passed`, `failed` or `not-verified`, with waivers. On a small edit, the same list in the final report is enough.

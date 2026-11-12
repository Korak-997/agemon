---
name: agemon-unused-code-check
description: Use when asked to find unused files, exports, or dependencies in a JavaScript or TypeScript project, or before finishing a change that removed or moved code. Runs the project's own Knip and never installs it.
---

# Agemon Unused-Code Check

Find unused files, exports, and dependencies with [Knip](https://knip.dev), using only the copy the project
already has. Knip reads the project's entry points and imports, so its report is a list of candidates to
check, not a list of things to delete.

## 1. Confirm the Project Has Knip

- Look for `knip` in `package.json` (`devDependencies` or `dependencies`) and for `node_modules/.bin/knip`.
- If either is missing, stop. Tell the user the project has no Knip and that adding it is their decision.
  Do not add it to `package.json`, do not install it, and do not download it for a one-off run.

## 2. Run It

```bash
npx --no-install knip
```

- `--no-install` makes `npx` fail instead of downloading Knip when the local copy is missing.
- If the project has a `knip` script in `package.json`, run that script instead; it carries the project's
  own flags.
- A configuration error (unknown entry, missing plugin) is a finding for the user, not something to fix by
  editing `knip.json` unless they asked for that.

## 3. Check Each Finding Before Calling It Unused

Knip misses references it cannot see. Before reporting an item as unused, search for its name across the
repository, including:

- dynamic imports and `require` calls built from strings;
- framework conventions that load files by path (routes, pages, plugins, middleware);
- scripts, config files, and CI workflows that call a dependency's binary;
- public exports of a published package, which callers outside the repository use.

Report each item as **unused** (no reference found) or **likely false positive** (with the reference that
explains it).

## 4. Act Only Within Scope

- Remove only what your own change made unused: imports, exports, files, or dependencies your edit
  orphaned.
- Everything else Knip reports is out of scope. Record it where this repository's rules say out-of-scope
  findings go (see AGENTS.md); do not fix it.
- After removing anything, run the project's tests and typecheck, then run step 2 again to confirm the
  removed items no longer appear and nothing new does.

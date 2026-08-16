# agemon

## 2.2.0

- feat(skills): introduce skill groups and enhance installation process

## 2.1.1

- fix: update references to 'crg' with 'code-review-graph' for clarity and consistency

## 2.1.0

- feat: enhance daemon plugin with dynamic unit naming and confirmation prompts
- fix: update daemon service command to use 'code-review-graph watch'

## 2.0.0

- feat: add update checking mechanism for agemon CLI
- feat: implement dynamic package version resolution from package.json

## 1.1.0

- feat: enhance deploy script with changelog entry management and prompt interface
- fix: correct escaping in package version retrieval command

## 1.0.0

### Major Changes

- **Breaking: dropped npm registry distribution.** `agemon` is no longer published to
  npm — `npx agemon@latest` no longer works, and the previously published `agemon@0.1.0`
  package on the npm registry is deprecated. Install instead via:
  ```bash
  curl -fsSL https://raw.githubusercontent.com/Korak-997/agemon/master/install.sh | sh
  ```
  This downloads a self-contained release tarball from GitHub Releases and links it onto
  `PATH` (`/usr/local/bin/agemon` as root, `~/.local/bin/agemon` otherwise) — no
  `node_modules` required at runtime.

### Minor Changes

- The build now fully bundles all runtime dependencies (`boxen`, `commander`, `ora`,
  `picocolors`, `yaml`) into a single self-contained `dist/index.js`, making the compiled
  CLI runnable with nothing but a Node.js binary.
- Releases are now cut via GitHub Actions building a tarball (`npm pack`, not `npm
  publish`) and attaching it to a GitHub Release, gated by the same lint/typecheck/test
  guards as before. Removed the npm Trusted Publishing (OIDC) flow entirely.
- Added `npm run deploy`, an interactive release script that verifies a clean `master`,
  runs the full quality gate, prompts for a `patch`/`minor`/`major` bump, checks
  `CHANGELOG.md` for a matching entry, then commits, tags, and pushes.
- Removed Changesets tooling (`.changeset/`, `@changesets/cli`); `CHANGELOG.md` is now
  maintained by hand as part of each release.

## 0.1.0

### Minor Changes

- Initial public release: a plugin-orchestrated CLI (`agemon install` / `agemon nuke`) that
  bootstraps and reversibly manages an AI coding agent environment in a repository —
  `code-review-graph` install/build, a `systemd --user` daemon for it, a bundled skills
  install, GitHub workflow scaffolding, global CLI tool install, and consolidated agent
  rule files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursorrules`, `.windsurfrules`) —
  backed by an idempotent `.agemon/state.json` manifest and full reversibility guarantees.

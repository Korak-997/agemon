# agemon

## 6.0.0

agemon 6 is a rework focused on safety: it can always undo what it did, it never removes
or replaces your own files, and a cloned repository cannot make it do either. There is no
5.x release.

### Breaking changes

- **Exit codes.** agemon used to exit 0 or 1. It now exits `2` when it finds drift, when
  consent is missing in a non-interactive run, or when an apply finished but verification
  found problems, and `130` / `143` / `129` when interrupted by SIGINT / SIGTERM / SIGHUP.
  `agemon status` exits 2 when it finds a problem in a repository agemon manages.
- **`agemon nuke` needs `--yes` in scripts.** It now lists everything it will reverse and
  asks once. Without a terminal and without `--yes` it prints the list and stops (exit 0).
- **`install.sh` checks every download** against the release's `SHA256SUMS`, so releases
  up to 4.7.2 can no longer be installed with it.
- **Node.js 22.12 or later** is required (was 24).
- **Repositories that track `.code-review-graph/`** are refused for the code graph and the
  daemon until it is removed from git (`git rm -r --cached .code-review-graph`).

### Uninstall that leaves nothing behind

- `agemon nuke` reverses only what agemon recorded, never deletes your content, and keeps
  a skill or agent you edited. It removes agemon's skills without running the skills CLI
  or touching the network, removes the `.gitignore` lines and empty directories agemon
  added, and deletes `agemon.toml` only when everything was reversed.
- Shared tools (code-review-graph, agnix) are removed only by the repository that
  installed them, once no other repository uses them; `--remove-shared` handles tools
  installed before agemon tracked them.
- New `agemon self-uninstall` removes agemon itself and its machine state.

### Safe applies and recovery

- Files are written atomically with their permissions kept; backups never overwrite each
  other; agemon refuses to write through a symlink, special file or read-only file.
- A failed apply rolls back every file it touched. An interrupted apply (Ctrl-C, a closed
  terminal, a crash) is restored with the new `agemon recover`.
- Plans are validated and pinned to the agemon version that made them, and `--plan`
  cannot point outside the plan directory.

### Trust and consent

- The ledger in `.agemon/state.json` is signed with a per-machine key. A forged or copied
  ledger in a cloned repository can no longer make agemon remove, replace or repair
  anything.
- Every install path asks first: a first run without consent shows a preview, and
  `--yes` approves it.
- Repository git config that could run a program is refused before code-review-graph or
  its daemon runs. Pass `--yes --trust-repo-git-config` (command line only) to approve it
  for one run after reading the keys agemon prints.

### Skills and agents

- Bundled skill fixes reach existing installs. A skill you edited is reported as
  `present-modified` and never replaced.
- Skill groups can install Claude Code subagents into `.claude/agents/`; `status` shows a
  row for every agent and reports shadowed and retired ones.
- New `geo-seo` skill group.

### Installing and upgrading

- agemon is published to npm (`npm install --global agemon`) with provenance, and the
  GitHub Release assets are checksummed and attested.
- New `agemon upgrade` (with `--rollback` for script installs) and an update check that
  offers the upgrade after a successful run.
- macOS 11 or later is supported, with the daemon as a launchd user agent.

### Daemon

- A daemon that keeps crashing is stopped after five starts in ten minutes and shown as
  `failed` in `agemon status`; the next `agemon` run registers it again. On macOS a crash
  loop is slowed to one restart a minute.
- On systemd the unit refuses to start when a symlink appears under
  `.code-review-graph`, for example after a `git pull`.
- When the `strict` sandbox is requested but the host does not apply it (Ubuntu with
  `kernel.apparmor_restrict_unprivileged_userns=1`), agemon says
  `strict requested, not enforced on this host` instead of claiming `strict`.
- **Existing daemon units** get the new start-time checks, restart limit and hardening
  only after `agemon nuke --only daemon` and a fresh `agemon` run.

## 4.7.2

- fix: distinguish declined skill groups from never-offered ones (#16)

## 4.7.1

- fix(skills): name pending groups in the drift-detection gate preview (#15)

## 4.7.0

- fix(skills): detect catalog groups added after a project's initial install (#14)

## 4.6.0

- feat: add team-lead skill group (#13)

## 4.5.0

- fix: add replace option to instruction-file conflict resolution (#12)

## 4.4.0

- fix: lint issues are resolved

## 4.3.1

- feat: add agemon skill bundle and agent rules config

## 4.3.0

- feat: Add read-only agent detection (Claude Code, Gemini CLI, Copilot) (#11)

## 4.2.0

- fix: update output normalization to mask plan IDs in non-interactive output (#10)

## 4.1.0

- feat: improve terminal design and loading (#9)

## 4.0.0

- feat: add cut-release workflow for automated versioning and release process (#8)
- fix: correct installation flow and CI setup (#7)

## 3.0.0

- V3 (#5)

## 2.3.0

- feat: add 'researches/' to .gitignore to exclude research files from version control
- feat: update code quality guidelines to emphasize self-documenting code and readability in reviews
- feat(nuke): enhance runNuke action to merge command options and add scoped nuke test
- refactor: remove workflow-scaffolder plugin and related files
- Merge pull request #3 from Korak-997/fix-1
- feat: implement ensureAgemonGitignored function and integrate it into plugin installation process

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

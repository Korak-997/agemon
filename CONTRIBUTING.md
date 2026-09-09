# Contributing to agemon

Thanks for contributing to agemon.

## Development Setup

1. Install dependencies:

```bash
npm install
```

2. Enable the repo git hooks (one time) so commit messages are checked locally:

```bash
git config core.hooksPath .githooks
```

3. Run local quality checks:

```bash
npm run lint
npm run typecheck
npm test
```

## Sandbox Workflow (Required)

Use the sandbox harness to verify behavior in an isolated environment before opening a PR.

1. Dry-run checkpoint:

```bash
npm run sandbox -- run clean-repo --dry-run
```

2. Real isolated run checkpoint:

```bash
npm run sandbox -- run clean-repo
```

3. Reversibility checkpoint:

```bash
npm run sandbox -- roundtrip clean-repo
```

Use `--real` only when you intentionally want to exercise host-coupled tooling.

## Code Style

- Node.js `>=24`
- TypeScript + ESM
- Biome for formatting and linting

Format changes when needed:

```bash
npm run format
```

## Commit Messages

Every commit subject must follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/):

```
<type>[(scope)][!]: <description>
```

Allowed types:

| Type | Meaning |
| --- | --- |
| `feat` | a user-facing feature (drives a minor bump) |
| `fix` | a bug fix (drives a patch bump) |
| `perf` | a performance improvement |
| `refactor` | code change that neither fixes a bug nor adds a feature |
| `docs` | documentation only |
| `test` | adding or fixing tests |
| `build` | build system or bundling changes |
| `ci` | CI configuration changes |
| `chore` | maintenance with no `src/` impact |
| `revert` | reverts a previous commit |

Breaking changes: append `!` after the type (`feat!: ...`) or add a `BREAKING CHANGE:`
footer. Either drives a major bump.

Examples:

```
feat(installer): verify tarball checksum before extraction
fix: bundle every runtime dependency so the tarball runs standalone
ci: smoke-test the packaged bundle
```

The `commit-msg` hook checks this locally once `core.hooksPath` is set (see Development
Setup); the `commitlint` CI job is the enforced gate and blocks merge on failure.

PRs are squash-merged, so the **PR title** becomes the commit subject on `master` and must
itself be a valid Conventional Commit — the `pr-title` CI job enforces this.

## Commit and Release Flow

This repository does not publish to npm — releases are self-contained tarballs attached
to GitHub Releases, installed via `install.sh`. See `docs/releasing.md` for the full flow.

1. For user-facing changes, add a `## X.Y.Z` entry to the top of `CHANGELOG.md` describing
   them (a maintainer will fold this into the next release's version bump).
2. CI validates code quality and sandbox checks on every PR.
3. Maintainers cut releases by tagging `vX.Y.Z` — see `docs/releasing.md`.

## Pull Requests

- Keep changes scoped to one task.
- Include test updates when behavior changes.
- Include the sandbox commands you ran in the PR description.

# Contributing to agemon

Thanks for contributing to agemon. Everyone taking part follows the
[Code of Conduct](CODE_OF_CONDUCT.md); how decisions are made is in [GOVERNANCE.md](GOVERNANCE.md).

## Start here

1. Open the repository in its dev container (`.devcontainer/`: Node 22 and pipx, no systemd
   needed), or install Node 22.12+ yourself and run `npm install`.
2. See what agemon does, safely, in a throwaway copy of a test repository:

```bash
npm run sandbox -- run clean-repo --dry-run
```

3. Pick a guide:
   - [Adding a skill](docs/contributing/adding-a-skill.md) to a bundled skill group;
   - [Writing a capability plugin](docs/contributing/writing-a-plugin.md);
   - issues labelled `good first issue` are a good place to begin.

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
npm run lint-skills
npm run typecheck
npm test
```

4. If you change anything the website is built from (`README.md`, `SECURITY.md`,
   `CHANGELOG.md`, `docs/contributing/`, the skill catalog, CLI help text or `website/`),
   build it once. CI does the same on every pull request:

```bash
npm ci --prefix website --ignore-scripts
npm run website:build
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

- Node.js `>=22.12`
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

Each release is one self-contained tarball, attached to the GitHub Release (installed by
`install.sh`) and published to npm as `agemon`. See `docs/releasing.md` for the full flow.

1. For user-facing changes, add a `## X.Y.Z` entry to the top of `CHANGELOG.md` describing
   them (a maintainer will fold this into the next release's version bump).
2. CI validates code quality and sandbox checks on every PR.
3. Maintainers cut releases by tagging `vX.Y.Z` — see `docs/releasing.md`.

## Pull Requests

- Keep changes scoped to one task.
- Include test updates when behavior changes.
- Include the sandbox commands you ran in the PR description.

# Contributing to agemon

Thanks for contributing to agemon.

## Development Setup

1. Install dependencies:

```bash
npm install
```

2. Run local quality checks:

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

## Commit and Release Flow

This repository uses Changesets.

1. Add a changeset for user-facing changes:

```bash
npm run changeset
```

2. CI validates code quality and sandbox checks.
3. Release/version updates are generated via Changesets.

## Pull Requests

- Keep changes scoped to one task.
- Include test updates when behavior changes.
- Include the sandbox commands you ran in the PR description.

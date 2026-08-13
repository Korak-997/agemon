# Architecture and Operations

This document describes the current implementation of `agemon` in this repository.
It focuses on behavior that exists now (v0.1), not design-only roadmap ideas.

## System Overview

`agemon` is a plugin-orchestrated CLI with reversible operations.

Core flow:

1. Build execution context (platform + binaries + manifest + service manager).
2. Resolve plugin order and dependency graph.
3. Run plugin lifecycle (`detect` -> `install` -> `verify`) for install.
4. Run plugin lifecycle in reverse for uninstall (`nuke`).
5. Persist manifest actions as source of truth for reversal safety.

## Runtime Context

Context is created in `src/core/context.ts` and includes:

- `cwd`: repository working directory.
- `os`: currently `ubuntu` only.
- `binaries`: runtime checks for `python3`, `pip`, `pipx`, `uv`, `crg`.
- `dryRun`, `yes`.
- `run`: subprocess runner abstraction.
- `manifest`: `.agemon/state.json` handler.
- `serviceManager`: platform-specific daemon manager.

Platform detection lives in `src/platform/detect.ts` and validates Ubuntu via
`/etc/os-release` (`ID=ubuntu`).

## Plugin Model

Interface (`src/plugins/types.ts`):

- `detect(ctx)`: determine current presence and whether pre-existing.
- `install(ctx)`: apply plugin changes.
- `verify(ctx)`: validate installation outcome.
- `uninstall(ctx)`: reverse managed changes.

Registered core plugin order (`src/plugins/index.ts`):

1. `crg`
2. `daemon` (depends on `crg`)
3. `skills`
4. `workflow-scaffolder`
5. `cli-tool`
6. `master-prompt`

Dev-only plugins are enabled when `AGEMON_DEV=1`.

## Plugin Responsibilities

### `crg`

- Installs `code-review-graph` via `pipx install code-review-graph`.
- Builds graph via `pipx run --spec code-review-graph code-review-graph build`.
- Verifies with `... status`.
- Preserves pre-existing installs using manifest metadata.

### `daemon`

- Registers `agemon-crg-daemon.service` with `systemd --user`.
- Ensures `loginctl` linger enabled when needed.
- Verifies service active.
- On uninstall, disables service and optionally disables linger if agemon enabled it.

### `skills`

- Uses `npx skills list --json` to detect current skills.
- Installs skill bundle entries via `npx skills add ...`.
- Removes only managed skill entries on uninstall.
- Tracks generated `skills-lock.json` when created by install.

Current bundle (`src/plugins/skills/catalog.ts`):

- `web-design-guidelines`
- `writing-guidelines`

### `workflow-scaffolder`

- Writes bundled workflows to `.github/workflows/`.
- Fails fast on unmanaged filename collisions.
- Removes only managed workflow files on uninstall.

Current bundle (`src/plugins/workflow-scaffolder/catalog.ts`):

- `claude-code-security-review.yml`
- `code-review-graph-action.yml`

### `cli-tool`

- Detects tool binaries via `--version` checks.
- Installs missing tools globally through npm.
- Removes only tools installed by agemon.

Current bundle (`src/plugins/cli-tool/catalog.ts`):

- `agnix` (`npm install --global agnix`)

### `master-prompt`

- Consolidates rule files into canonical set.
- Writes:
  - `AGENTS.md`
  - `CLAUDE.md`
  - `GEMINI.md`
  - `.cursorrules`
  - `.windsurfrules`
- Backs up pre-existing files into `.agemon/backups/master-prompt/`.
- Restores backups on uninstall.

## Orchestrator Behavior

`src/core/orchestrator.ts`:

- Resolves dependency order with DFS and cycle detection.
- Supports `--only` selection.
- Install path:
  - `detect`
  - skip if already present
  - `install`
  - `verify` (throws on failure)
- Uninstall path:
  - reverse order
  - `uninstall`
  - prune manifest if empty

## State Manifest

Manifest path: `.agemon/state.json`

Data tracked:

- plugin id
- action type
- target
- `preExisting`
- action timestamp

Role:

- Prevents removing user-preexisting dependencies/files.
- Enables precise `nuke` behavior.
- Keeps install/uninstall idempotent and auditable.

## UI/Output Layer

UI files:

- `src/ui/theme.ts`
- `src/ui/spinner.ts`
- `src/ui/banner.ts`
- `src/ui/table.ts`

Key behavior:

- Interactive TTY: `ora` spinner output.
- Non-interactive/`NO_COLOR`: plain line output.
- Commander supports `--no-color`, `--verbose`, `--quiet` flags.

## Sandbox Harness

Script: `scripts/sandbox.ts`

Modes:

- `run <fixture>`
- `roundtrip <fixture>`
- `watch <fixture>`
- `reset`

Purpose:

- Execute CLI in isolated temp directories.
- Force fake backends by environment toggles unless `--real`.
- Capture deterministic output for verification.
- Validate reversibility through before/after snapshot hashing.

## Fake Backend Environment Flags

Used for sandbox and unit/integration tests:

- `AGEMON_DEV=1`
- `AGEMON_FAKE_SUBPROCESS=1`
- `AGEMON_FAKE_SERVICES=1`
- `AGEMON_FAKE_PREINSTALLED_CRG=1`
- `AGEMON_FAKE_PREINSTALLED_SKILLS=<csv>`
- `AGEMON_FAKE_PREINSTALLED_NPM_PACKAGES=<csv>`
- `AGEMON_OS_RELEASE_PATH=<path>`

`src/core/dev-mode.ts` enforces that fake backends cannot be used outside
`AGEMON_DEV=1`.

## Operational Commands

Primary commands:

```bash
# install
npx agemon@latest install

# uninstall/reverse
npx agemon@latest nuke
```

Local development:

```bash
npm run build
npm run typecheck
npm run lint
npm test
npm run sandbox -- run clean-repo --dry-run
npm run sandbox -- roundtrip clean-repo
```

## Known Gaps

Current known gaps tracked in `improvements.md` include:

- integration fixture coverage is incomplete
- error handling edge cases in environment/platform bootstrap
- cross-platform assumptions still present in path parsing

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
- `run`: subprocess runner abstraction (`src/core/subprocess-runner.ts`). Calls without
  `timeoutMs` time out after 5 minutes; each output stream is capped at 10 Mi characters
  and marked `…[truncated]` beyond that.
- `manifest`: `.agemon/state.json` handler.
- `serviceManager`: platform-specific daemon manager.
- `confirm`: shared mid-run confirmation policy (`src/core/prompt.ts`) — resolves `true`
  immediately under `--yes`, `false` immediately with no TTY to prompt on, otherwise
  shows a real y/N prompt.

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
4. `cli-tool`
5. `master-prompt`

Dev-only plugins are enabled when `AGEMON_DEV=1`.

## Plugin Responsibilities

### `crg`

- Installs `code-review-graph` via `pipx install code-review-graph==<pin>`
  (`CODE_REVIEW_GRAPH_VERSION` in `src/plugins/pins.ts`) with `--require-hashes
  --only-binary=:all:` and the hash-locked constraints shipped in
  `assets/tools/code-review-graph-constraints.txt`, so every dependency is pinned and
  checked against its sha256 and no source build runs. The constraints are copied to
  `<state>/agemon/tools/code-review-graph-constraints-<hash>.txt`, a path pipx records:
  `pipx reinstall` and `pipx upgrade-all` reuse it (and fail closed if the file was
  deleted; running agemon again recreates it). `pipx upgrade code-review-graph` drops the
  lock. pipx itself still installs its shared `pip` from PyPI without hashes.
- Finds the installed binary by reading pipx's `pipx_metadata.json` (no pipx subprocess),
  falling back to `code-review-graph` on `PATH` outside the repository.
- Builds the graph with `<binary> build` and verifies with `<binary> status`, with
  `CRG_HOME` fixed to `~/.code-review-graph` and git's fsmonitor and hooks disabled.
- Preserves pre-existing installs using manifest metadata. `nuke` removes
  `.code-review-graph/` only when agemon built it, and uninstalls the pipx package only as
  described in [Two Ledgers](#two-ledgers).
- `verify` skips `<binary> status` in a repository without `.code-review-graph/`, because
  `status` would create that directory.

### `daemon`

- Registers `agemon-crg-daemon-<slug>-<hash>.service` with `systemd --user`. `<slug>` is
  the repository directory's name and `<hash>` is the first 8 hex digits of the SHA-256 of
  its real path, so repos with the same name stay independent. No git command runs.
- Revert uses the unit name recorded in the ledger (validated against the agemon unit
  pattern), never a recomputed one. Before removing a unit it reads the unit's
  `WorkingDirectory`; a unit that now runs for another existing repository is kept.
- Units recorded under an old name are migrated by the next `agemon` run: the new unit is
  registered and recorded first, then each old unit this repo owns is removed.
- Linger is a shared resource (see [Two Ledgers](#two-ledgers)). It is disabled only by
  the repository that enabled it, once it is the last holder, and only while no other
  agemon daemon unit file (including the legacy `agemon-crg-daemon.service`) remains in
  the user unit directory. That file check is a safety net for units registered before
  agemon tracked linger. Linger that was already on is recorded `pre-existing`, even when
  a repository ledger claims agemon enabled it.
- Refuses to register when `.code-review-graph` exists but is not a real directory.
- Runs the `code-review-graph` binary that the crg plugin locates, with the same
  `CRG_HOME` and git safety settings as crg's own commands.
- Tries a `strict` unit first and falls back to `compat`. `strict` makes the system and
  home read-only, except for the repository (its `.git/` stays read-only) and
  `~/.code-review-graph`. A repository that is or contains your home directory, or
  `AGEMON_DAEMON_HARDENING=compat`, goes straight to `compat`. The profile used is
  printed and recorded in the ledger.
- Registration records its intent first. Under the shared-tools lock it reads linger and
  records the unit, `enabled-linger` (when linger is off) and the machine linger record.
  Only then does it enable linger and, for each profile, write the unit atomically, enable
  it and watch it until it has stayed `active` without restarts for 2 seconds (10-second
  limit). A failed attempt removes its own unit. Any later failure, or an interrupted run,
  is undone by the apply rollback or `agemon recover` from those entries, which also
  switches linger back off when this registration switched it on.
- Verifies service active; `verify`'s detail includes the resolved unit name.

### `skills`

- Runs a pinned `skills` CLI, never `npx`. On first use, agemon installs the shipped
  `assets/tools/package-lock.json` with `npm ci --ignore-scripts` into
  `<state>/agemon/tools/<lock hash>/`, so every package is checked against its lockfile
  integrity. It then runs `node <tools>/node_modules/skills/bin/cli.mjs` with the repo as
  `cwd`. A tools dir without the CLI is reinstalled. Dependabot bumps the lockfile, with
  a 7-day cooldown.
- Uses `skills list --json` to detect current skills.
- Installs skill bundle entries via `skills add <source> ...`. Vendored groups install
  from `assets/skills/`. Essentials installs from `<state>/agemon/skills-src/<commit>/`:
  agemon fetches that directory fresh before each install (`git fetch --depth 1 <url>
  <commit>`), requires `HEAD` to equal the pinned commit, and refuses any skill that
  contains a symlink.
- Removes only managed skill entries on uninstall.
- Tracks generated `skills-lock.json` when created by install, and adds
  `/skills-lock.json` to the repo `.gitignore` so it is never committed.

Current bundle (`src/plugins/skills/catalog.ts`):

- `web-design-guidelines`
- `writing-guidelines`

### `cli-tool`

- Detects tool binaries via `--version` checks.
- Installs missing tools globally through npm, at the pinned version and with
  `--ignore-scripts`.
- Installs each tool's binary through `ctx.verifiedBinaryInstaller`
  (`src/core/verified-binary-installer.ts`): it downloads the release archive for the
  platform (30 s timeout, 50 MiB cap) and checks it against the sha256 pinned in
  `src/plugins/pins.ts` before anything touches it. It then extracts the one named member
  inside the package dir, runs `--version` on it, and renames it into place. If the gnu
  build does not run on linux-x64, the musl build is tried. On any failure, the npm package
  is uninstalled and nothing is recorded.
- Under `AGEMON_FAKE_SUBPROCESS=1`, the installer is a fake that only records the request.
- Before `npm install --global`, it runs `npm root --global` and refuses to install when
  a global `agnix` entry already exists there (the binary is then just off your PATH or
  broken), so it never overwrites or uninstalls a user's own copy.
- Removes only tools installed by agemon, and only as described in
  [Two Ledgers](#two-ledgers). `detect` writes nothing; a repository that uses an agnix it
  did not install records that through a `use-shared` plan line.

Current bundle (`src/plugins/cli-tool/catalog.ts`):

- `agnix` (`npm install --global --ignore-scripts agnix@<pin>`, then the verified binary
  at `<npm root>/agnix/bin/agnix-binary`; linux-x64 and linux-arm64)

### `master-prompt`

- Consolidates rule files into canonical set.
- Writes:
  - `AGENTS.md`
  - `CLAUDE.md`
  - `GEMINI.md`
  - `.cursorrules`
  - `.windsurfrules`
- Backs up pre-existing files into `.agemon/backups/<resource>-<hash>.bak` (older installs:
  `<resource>.bak`, or `master-prompt/<file>.bak` from 1.x).
- On uninstall, restores a backup only when its checksum matches the recorded pre-install
  fingerprint and the file is unchanged since agemon wrote it; otherwise removes just the
  managed block, or keeps the file and saves the backup beside it as
  `<file>.agemon-original`.
- Never reads or writes a rule file through a symlink; such a file is planned as a
  conflict.

## Orchestrator Behavior

`src/core/orchestrator.ts`:

- Resolves dependency order with DFS and cycle detection.
- Supports `--only` selection.
- Install path, per plugin:
  - `detect`
  - not present: fresh install — `install` then `verify` (throws on failure)
  - present: `verify` runs regardless, surfacing what's currently there
    - healthy (`ok: true`): reported and left alone, no reinstalling on every run
    - unhealthy: reports the problem and calls `ctx.confirm(...)` to ask whether to
      rewrite/fix it; if confirmed, `install` runs again followed by a re-`verify`
      (throws if still unhealthy); if declined, reported and left as-is
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

### Untrusted state

`.agemon/` can be committed, so its plans, ledger and backups are treated as attacker
input:

- Every `.agemon/` directory is resolved with `resolveStateDirectory`
  (`src/core/repo-paths.ts`); a symlinked or non-directory component is refused.
- Every path that comes from a plan or a ledger entry goes through `resolveInsideRepo`: no
  absolute paths, no `..` escape, nothing inside `.git/` or `.agemon/`, and no symlinked
  parent directory.
- `readPlan` validates the plan id and every plan field; `reconcile` refuses a plan from
  another agemon version, one naming an unknown capability, or one asking a capability for
  a file action it never performs.
- Plugins act only on their own ledger targets: master-prompt on its five rule files,
  cli-tool on its bundle. Other entries are reported and dropped.
- `readRegularFileIfExists` refuses symlinks and special files and caps reads at 8 MiB.
- Ledger text is checked when the ledger loads (every version) and when agemon writes an
  entry: identifiers, ids, versions, fingerprints and details may not contain control,
  zero-width or bidi characters. `target` and `backup.path` may contain tabs, zero-width
  and bidi characters (real paths can), but no other control character. A ledger that
  fails names the entry and field. agemon never writes such an entry, so the fix is to
  restore `.agemon/state.json` from git or remove that entry.

## Two Ledgers

agemon keeps two ledgers with separate jobs:

| Ledger | Path | Owns |
|---|---|---|
| Repository ledger | `.agemon/state.json` | everything agemon changed inside this repository, and which shared tools this repository installed or uses |
| Shared-tools ledger | `${XDG_STATE_HOME:-~/.local/state}/agemon/machine.json` | which repositories use each machine-wide resource, and who installed it |

The repository ledger stays the source of truth for repository files. The shared-tools
ledger exists because code-review-graph (pipx), agnix (npm `-g`) and user linger (for
the daemon) exist once per machine but are used by many repositories. Linger is never
recorded `migrated`, so `--remove-shared` accepts only `code-review-graph` and `agnix`.

Each shared tool has one record:

- `origin: installed`, with `installedBy` and `ownerDirectoryId` (device, inode and birth
  time of that directory) — agemon installed it from that repository;
- `origin: migrated`, with `claimedBy` — that repository's ledger says agemon installed
  it, but the shared-tools ledger did not see the install (a ledger written before
  agemon tracked shared tools, a lost `machine.json`, or a forged ledger);
- `origin: pre-existing` — the tool was already there; agemon never removes it;
- `holders` — the repositories that use it.

Rules:

- A repository becomes a holder when agemon installs the tool there, or through a
  `use-shared` plan line ("record that this repository uses …") when the tool already
  exists. `use-shared` needs no consent: it records a fact and never installs. A stored
  plan may not mark any other action as needing no consent.
- `nuke` removes a tool only when this repository is its last holder **and** installed it
  (`installedBy`). A `migrated` tool also needs `nuke --remove-shared <tool>` from the
  claiming repository. Everything else is kept, and `nuke` prints the manual command.
- A repository that is not a holder removes nothing, whatever its ledger says, so a
  committed `state.json` cannot uninstall a tool on someone else's machine.
- Holders whose path no longer exists are dropped on the next change. If the installing
  (or claiming) directory is gone or was replaced — for example a different clone at the
  same path — the record is treated as `pre-existing`, so the new directory inherits no
  right to remove the tool.
- `machine.json` is changed only under `machine.lock`. The lock records the owner's pid,
  boot id and process start time. A lock left by a dead process is broken under a second
  lock, `machine.lock.break`.
- `<stateRoot>/agemon` must be a real directory owned by you. Others may not write to it:
  group write is allowed only for a user private group. It is tightened to `0700` when
  others could read it. `<stateRoot>` must not be writable by others unless it is sticky.
- `status` shows a "Shared tools" section with each tool's origin and users.
- Locks, all under `<stateRoot>/agemon`: `runs/<repo key>.lock` is held for a whole
  non-dry-run `agemon`, `apply`, `nuke` or `recover`, taken before the ledger is loaded,
  and a second run in the same repository fails at once. `skills-src.lock` is held while
  the pinned Essentials source is fetched and copied, `tools.lock` while the skills CLI is
  installed or repaired, and `machine.lock` while `machine.json` changes. The order is
  always run lock → `skills-src.lock` → `tools.lock`. `machine.lock` is never held while
  another lock is taken.
- Everything agemon writes outside repositories lives under `<stateRoot>/agemon/`
  (`tools/`, `skills-src/`, `journals/`, `runs/`, `machine.json`). That directory is the
  record of agemon-owned machine state: removing agemon itself means removing it after
  the per-repository `nuke`s.
- `plan`, `status` and `inspect` may install the pinned skills CLI (as they have since it
  was pinned), so they can create `<stateRoot>/agemon` and tighten its mode.

Accepted gaps (agemon keeps the tool, never removes one wrongly):

- A tool another repository was already using before agemon tracked shared tools is
  recorded `pre-existing` by whichever repository runs first, so agemon never removes it.
- If the installing (or claiming) repository was deleted, moved or renamed without `nuke`,
  the tool stays. A repository that only uses a tool never removes it.
- Holders that still exist but no longer use agemon (`.agemon/` deleted by hand) are not
  dropped. `status` lists them, and running `agemon` there repairs the record.
- A crash between recording an install in the repository ledger and in `machine.json`
  leaves the tool installed after `recover` or `nuke`; the manual command is printed.
- Each `XDG_STATE_HOME` has its own shared-tools ledger, so run agemon with one state
  root. `XDG_STATE_HOME` must be inside your own directory tree: agemon does not check its
  ancestors.
- The owner identity relies on the filesystem's birth time. Without one (ext2/3, NFSv3,
  many FUSE mounts), or where Node reports the change time instead, agemon never removes
  the tool. Re-cloning into the very same emptied
  directory keeps its identity, so that clone inherits the right to remove the tool.
- If agemon is interrupted right after recording that it will enable linger, and you then
  enable linger yourself before running `agemon recover`, `recover` turns it off again
  (this repository is still its recorded installer).
- Resource ids that agemon derives from file names come only from fixed names today; a
  derived id must keep passing the identifier check.
- A repository that registers its daemon while another repository is recorded as having
  enabled linger turns linger back on if it is off, but does not become its installer, so
  it never disables it.
- A holder on an unmounted drive looks missing and is dropped. A holder on a dead network
  mount can stall the run.
- Lock liveness needs `/proc`. Without it agemon falls back to `kill(pid, 0)` and accepts
  pid reuse. Containers that share one state directory across pid namespaces are not
  supported. A stalled or crashed breaker can, rarely, let two runs in at once; each holder
  re-checks its lock before every write and every install or uninstall.

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

## Update Checking

`src/core/update-check.ts`, invoked at the top of both `install` and `nuke` action
handlers in `src/cli/index.ts`:

- Skipped entirely when `--dry-run`, `AGEMON_DEV=1`, or `AGEMON_NO_UPDATE_CHECK=1`.
- Queries `GET /repos/Korak-997/agemon/releases/latest` (GitHub API), cached in
  `$XDG_CACHE_HOME/agemon/update-check.json` (or `~/.cache/...`) for 24h to avoid a
  network round-trip on every invocation and avoid rate-limiting.
- Network/cache failures are swallowed silently — never blocks the actual command.
- Non-interactive stdin/stdout (CI, piped output): prints a one-line notice only, never
  prompts.
- Interactive TTY with a newer version available: prompts to update; on yes, downloads
  `install.sh` and `SHA256SUMS` from that exact release (`releases/download/vX.Y.Z/`),
  writes the script to a private temp directory, re-hashes the file on disk, and runs it
  with `sh <path>` (no shell string, no pipe) and `AGEMON_VERSION` set, only when the hash
  matches. The installer then verifies the tarball's checksum itself; build-provenance
  attestations are checked only when `AGEMON_VERIFY_ATTESTATION=1` is exported, because the
  updater passes its environment through. The CLI returns `updated` so the
  caller stops instead of proceeding with code that was just replaced on disk.
- The tag from the API and the cached version must look like a release version
  (`X.Y.Z` with an optional `-alpha.N`/`-beta.N`/`-rc.N`); anything else is ignored.

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
`AGEMON_DEV=1`. The fake subprocess backends live in `src/core/fake-subprocess.ts`, which
the runner loads with a dynamic `import()` only when `AGEMON_FAKE_SUBPROCESS=1`.

## Operational Commands

Primary commands:

```bash
# install (plain `agemon` — there is no separate `install` subcommand)
agemon

# uninstall/reverse
agemon nuke
```

Local development:

```bash
npm run build
npm run typecheck
npm run lint
npm test
npm run sandbox -- run clean-repo --dry-run
npm run sandbox -- roundtrip clean-repo

# compare the pins in src/plugins/pins.ts with upstream releases that are 7+ days old
# (also run monthly by .github/workflows/pin-freshness.yml)
npm run check-pins
```

## Known Gaps

Current known gaps tracked in `improvements.md` include:

- integration fixture coverage is incomplete
- error handling edge cases in environment/platform bootstrap
- cross-platform assumptions still present in path parsing

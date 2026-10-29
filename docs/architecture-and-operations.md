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
- `binaries`: runtime checks for `python3`, `pip`, `pipx`, `uv`, `crg`.
- `dryRun`, `yes`.
- `run`: subprocess runner abstraction (`src/core/subprocess-runner.ts`). Calls without
  `timeoutMs` time out after 5 minutes; each output stream is capped at 10 Mi characters
  and marked `…[truncated]` beyond that.
  Every child gets `agemonSubprocessEnvironment()` as its base environment, and so do the
  two direct `execFile` calls (`inspect`'s `git ls-files` and the self-update's
  `sh install.sh`). That function always drops empty and relative `PATH` entries, which
  would make a bare `git` resolve inside the repository. When npm, pnpm, yarn or bun
  launched agemon (`npm_command`, `npm_execpath` or `npm_config_user_agent` is set), it
  also drops every `npm_*` variable (any case), `INIT_CWD`, `NODE`, and the
  `node_modules/.bin` and `node-gyp-bin` entries on `PATH`. That is the repository's npm
  configuration and bins, injected by the launcher. Every `npm` call agemon makes passes
  `--global` or `--prefix`, so npm never reads a `.npmrc` from the repository it runs in;
  the fake subprocess backend throws on any `npm` call without one of them.
- `manifest`: `.agemon/state.json` handler.
- `serviceManager`: platform-specific daemon manager, with a `kind`: `systemd-user`
  (`systemctl --user`, `loginctl` linger), `launchd` (`/bin/launchctl` in the `gui/<uid>`
  domain, no linger) or `none`. Without systemd it is an unavailable manager: reads
  answer "not active", and changes fail with a message naming the unit file to remove by
  hand.
- `confirm`: shared mid-run confirmation policy (`src/core/prompt.ts`) — resolves `true`
  immediately under `--yes`, `false` immediately with no TTY to prompt on, otherwise
  shows a real y/N prompt.

Platform detection lives in `src/platform/detect.ts`. `detectPlatformCapabilities`
returns the OS `family` (`linux`, `darwin`, `other`), the CPU `arch`, the
`serviceManager` (`systemd-user` when `/run/systemd/system` exists, otherwise `none`;
`launchd` on macOS) and
an `unsupportedReason`; `Context.platform` carries it to the plugins. Linux is supported
when `/etc/os-release` `ID` is `ubuntu` or `debian`, or `ID_LIKE` lists either; macOS is
always supported. On macOS, install, `apply`, `nuke`, `plan`, `recover`, `upgrade` and
`self-uninstall` refuse to run as root, because the agent, the state directory and the
tools all belong to one user (on Intel Macs Homebrew also makes `/usr/local`
user-writable). The CLI detects once per command: install, `apply` and `nuke` refuse an
unsupported platform before the update check, the state directory or the run lock;
`inspect`, `status`, `plan` and `recover` run everywhere. Without a service manager,
install, `apply` and `plan` skip the daemon as if `--skip-daemon` were passed (without
removing it from `agemon.toml`). They skip `cli-tool` the same way when agnix has no
pinned build for `<family>-<arch>`. `install.sh` applies the same platform rule before it
downloads anything, and refuses root on macOS.

agemon's machine state lives in `${XDG_STATE_HOME:-~/.local/state}/agemon` on Linux and in
`~/Library/Application Support/agemon` on macOS (`XDG_STATE_HOME` still wins there when
set). On macOS the pipx home is `PIPX_HOME`, else `~/.local/pipx` if it exists, else
`~/Library/Application Support/pipx`, as pipx itself resolves it. Lock liveness uses the
boot id (`/proc/sys/kernel/random/boot_id` on Linux, `sysctl kern.bootsessionuuid` on
macOS) and, on Linux only, the process start time; on macOS a pid reused within one boot
can make a crashed run's lock look held, and the error names the lock file. Repository
paths are compared after case folding and removing default-ignorable code points, so
`.GIT` and `.g<U+00AD>it` are refused like `.git` on case-insensitive filesystems.

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
4. `agents` (depends on `skills`)
5. `cli-tool`
6. `master-prompt`

`buildPlan` passes each plugin's `plan` the operations planned before it, so `agents` sees
the skill groups this run installs.

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
  lock. When pipx creates its shared venv, and on each 30-day refresh, it installs pip
  without hashes from the configured package index; the hash-locked crg install holds
  only if that pip is genuine (owner decision D11: a uv-based install, planned after
  P11).
- Reports whether the found install is hash-locked: `main_package.pip_args` must be
  exactly `--require-hashes`, `--only-binary=:all:`, `-c` and a
  `code-review-graph-constraints-<16 hex>.txt` directly in `<state>/agemon/tools/`. For
  an install agemon made (repo ledger `installed-binary`, or a shared-tools record of
  origin `installed`/`migrated`) that fails this, `verify` passes with an **attention**
  note that names the reinstall (`pipx uninstall code-review-graph`, then agemon; a
  PATH-only copy is told to remove it instead). `status` reports it as needing
  attention and exits 2; `apply` prints it and goes on. An adopted crg only gets
  "dependencies not hash-locked" in its detail. `pipx inject` adds packages without
  changing `pip_args`, which this check cannot see.
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

- Registers `agemon-crg-daemon-<slug>-<hash>.service` with `systemd --user`, or on macOS
  the launch agent `dev.agemon.crg.<slug>-<hash>.plist`. `<slug>` is the repository
  directory's name and `<hash>` is the first 8 hex digits of the SHA-256 of its real path,
  so repos with the same name stay independent. No git command runs.
- launchd: the plist (`ProgramArguments` array, `WorkingDirectory`, `RunAtLoad`,
  `KeepAlive`, `ProcessType=Background`, crg's environment plus `PATH` limited to system
  directories; the variables systemd unsets are set to `""`, because `launchctl setenv`
  values reach every agent) is written atomically with mode `0644`, then
  `launchctl bootstrap gui/<uid>`. Readiness comes from `launchctl print`: running with one
  run for 2 s is ready; a second run, a non-zero last exit code or a stopped job after it
  ran is a failure (the agent is booted out and the plist removed); anything else is
  pending for up to 10 s. `bootout` is confirmed by polling `print` until the job is gone
  (5 s). A plist that is binary, has no single `Label`/`WorkingDirectory`, or whose
  `Label` differs from its name is treated as not agemon's and kept. There is no
  hardening profile: the ledger records `launchd`, and agemon says so. Linger is never
  used or recorded under launchd.
- Ledger entries whose name belongs to the other service manager (a ledger carried from
  Linux to a Mac, or back) are never acted on and do not count as linger users; `nuke`
  fails and names them, so the entry stays until it is run on that OS.
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
- Uses `skills list --json` to detect current skills. `detect` never writes the ledger.
- `plan` emits one `install-package` operation per group (`skill-group:<id>`, or
  `custom-skill-group:<id>` for a group from `agemon.toml`) whose preview lists every
  skill and its source, plus one consent-requiring `skip` operation per group the user was
  shown and did not pick. The group question runs inside `plan`, before any consent gate,
  and only when the run is interactive and not a dry run. `apply` resolves each operation's
  group by its resource id from the catalog (never from the preview) and records declines
  as `offered-skill-group` + `declined-skill-group`.
- Every `skills add`/`skills remove` passes `--agent claude-code`, so the CLI touches only
  `.agents/skills/` and `.claude/skills/`. Before it runs, both must be real directories
  (no symlinked component; created for `add`, never for `remove`), `.agents/skills/<name>`
  must not be a symlink, and `skills-lock.json` must be absent or a regular file. After a
  managed skill is removed, agemon deletes a leftover `.agents/skills/<name>` itself.
- Custom local skills are read without following symlinks, copied into a private
  `<state>/agemon/skills-stage/run-*` directory, and installed from there; the content hash
  of the copy must equal the one in the plan. Custom GitHub skills use the same pinned
  fetch as Essentials, with `credential.helper=`, `GIT_CONFIG_GLOBAL=/dev/null` and
  `GIT_CONFIG_NOSYSTEM=1`.
- `agemon apply --plan <id>` rebuilds the plan (dry run, no `--yes`, no prompt) from the
  run's own options and applies the rebuilt operations only if their canonical content
  equals the stored plan's; otherwise it names the option that differs and stops.
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

### `agents`

- Installs the subagents of installed built-in skill groups (`SkillGroup.agents` in
  `src/plugins/skills/catalog.ts`) as `.claude/agents/<name>.md`, one `agent-file:<name>`
  operation each. Desired agents = groups in this plan's skills `install-package`
  operations ∪ groups recorded in the skills ledger (`skills/ledger-view.ts`, declined and
  custom groups excluded).
- An agent file is rendered from its catalog entry (`name`, `description`, `tools`) and the
  brief it names in agemon's own `assets/skills/` (never the repository's installed copy).
- States: absent → `create`; equal → nothing (or `adopt` when unrecorded); untouched since
  recorded → `replace`; changed or unrecorded and different → `conflict`; symlink, special
  file or symlinked directory → `conflict` that is never written.
- Own consent gate `install-subagents`; its summary and `--yes` announcement list each agent
  with the tools from the operation's own preview.
- Apply skips an agent whose group is not recorded after the skills capability ran. A
  conflict resolved as `replace` re-records the file as pre-existing with a backup, unless an
  earlier, different original is already backed up (then it is skipped with a message).
- Revert uses the shared `revertManagedFile` (`src/core/managed-file-revert.ts`), then
  removes `.claude/agents` if it is an empty real directory; `.claude` is never touched.
- Verify reports a missing or non-regular recorded agent as `attention`.

### `cli-tool`

- Detects tool binaries via `--version` checks. For an agnix agemon installed (repo
  ledger `installed-cli-tool`, or a shared-tools record of origin `installed`/`migrated`)
  it first inspects the installed files, at most once per run: a missing package is
  absent (the install is planned again), and a package that differs from the pins is
  not run at all.
- Installs everything through `ctx.verifiedBinaryInstaller`
  (`src/core/verified-binary-installer.ts`). It downloads the npm tarball from the fixed
  registry URL in `AGNIX_NPM_TARBALL`, checks its sha512 (`dist.integrity`) in memory,
  writes it into a private `mkdtemp` dir and runs
  `npm install --global --ignore-scripts --no-audit --no-fund --no-update-notifier
  <tarball>` there, so npm links only the `bin` entries of the verified `package.json`
  and fetches nothing else (agnix has no dependencies). Then it downloads the release archive for the
  platform (30 s timeout, 50 MiB cap) and checks it against the sha256 pinned in
  `src/plugins/pins.ts` before anything touches it. It then extracts the one named member
  inside the package dir, runs `--version` on it, and renames it into place. If the gnu
  build does not run on linux-x64, the musl build is tried. On any failure, the npm package
  is uninstalled and nothing is recorded.
- `inspect` hashes `package.json`, `bin/agnix` and `bin/agnix-binary` (streamed,
  `O_NOFOLLOW`, regular files only, 50 MiB cap) against `AGNIX_PACKAGE_FILE_SHA256` and
  `AGNIX_BINARY_SHA256`, refuses a symlinked package or `bin` dir, and checks that
  `agnix` on the cleaned PATH resolves to that package's `bin/agnix`. Any read error is
  reported as a difference. For an agemon-installed agnix that differs, `verify` passes
  with an attention note naming the reinstall (`npm uninstall --global agnix`, then
  agemon). An adopted agnix only gets "not the pinned … build" in its detail.
- Under `AGEMON_FAKE_SUBPROCESS=1`, the installer is a fake that records the request and
  marks the fake global package installed; its `inspect` reports that package as pinned.
  The fake npm refuses any `npm install --global <name>`.
- Before `npm install --global`, it runs `npm root --global` and refuses to install when
  a global `agnix` entry already exists there (the binary is then just off your PATH or
  broken), so it never overwrites or uninstalls a user's own copy.
- Removes only tools installed by agemon, and only as described in
  [Two Ledgers](#two-ledgers). `detect` writes nothing; a repository that uses an agnix it
  did not install records that through a `use-shared` plan line.

Current bundle (`src/plugins/cli-tool/catalog.ts`):

- `agnix` (the sha512-verified `agnix-<pin>.tgz` installed by `npm install --global
  --ignore-scripts`, then the verified binary at `<npm root>/agnix/bin/agnix-binary`;
  linux-x64 and linux-arm64)

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
  agents on `.claude/agents/<catalog name>.md` with the matching `agent-file:` resource id,
  cli-tool on its bundle. Other entries are reported and dropped.
- `readRegularFileIfExists` refuses symlinks and special files and caps reads at 8 MiB.
- Ledger text is checked when the ledger loads (every version) and when agemon writes an
  entry: identifiers, ids, versions, fingerprints and details may not contain control,
  zero-width or bidi characters. `target` and `backup.path` may contain tabs, zero-width
  and bidi characters (real paths can), but no other control character. A ledger that
  fails names the entry and field. agemon never writes such an entry, so the fix is to
  restore `.agemon/state.json` from git or remove that entry.

## Self-Uninstall

`src/core/self-uninstall.ts`, behind `agemon self-uninstall [--dry-run] [--yes]`:

- Refuses root with another user's environment, an install dir without a regular
  `.agemon-install` (or without `package.json` named `agemon` and `bin/agemon.js`), and a
  protected dir: the same list `install.sh` refuses (a test keeps both in sync), or any
  dir that contains a home directory.
- Plans everything before deleting anything: each target must be owned by the effective
  uid and sit in a writable parent, or nothing is removed and every reason is listed.
- Targets, in removal order: the `~/.local/bin/agemon` and `/usr/local/bin/agemon`
  links, only when they resolve to `<install dir>/bin/agemon.js`; `<install dir>.prev`,
  only when it is a marker'd install tree; the machine state dir; the update-check cache
  dir (only a private dir of this user under an absolute `XDG_CACHE_HOME` or
  `~/.cache`, holding nothing but `update-check.json`, which is deleted before the dir);
  and the install dir last.
- A recoverable interrupted apply (any file under `journals/`) refuses the whole
  uninstall, so `agemon recover` still exists to run.
- The machine state dir (from `resolveAgemonStateDirectory("check")`, so a symlinked or
  foreign dir is refused, not followed) is removed only when no shared tool in
  `machine.json` has a live holder, no `runs/*.lock` is held (each is try-acquired with
  no wait), and it holds only entries agemon creates (`machine.json`, `tools/`,
  `skills-src/`, `journals/`, `runs/` and their locks). A read error other than "missing"
  keeps it. This is checked again under `machine.lock`
  right before everything but the lock file is deleted; the dir itself is removed after
  the lock is released, and kept if anything reappeared.
- Shared tools whose holders are all gone get their manual uninstall command printed
  (`installed`, and `migrated` as "may have been installed by an older agemon").
- A partial failure lists every path still present and exits 1.
- Accepted window: a repository run that starts after the last run-lock probe and before
  the deletion loses its lock file and journal; its own `assertStillHeld` then stops it.
  The run-lock probe also holds each run lock for a moment, so a repository run that
  starts at that instant fails at once (run locks never wait) and can simply be re-run.

The skills plugin's tools install (under `tools.lock`) first removes
`<16-hex-hash>.tmp-*` siblings left in `tools/` by a killed install, and nothing else in
that directory.

## Two Ledgers

agemon keeps two ledgers with separate jobs:

| Ledger | Path | Owns |
|---|---|---|
| Repository ledger | `.agemon/state.json` | everything agemon changed inside this repository, and which shared tools this repository installed or uses |
| Shared-tools ledger | `<state directory>/agemon/machine.json` ([Runtime Context](#runtime-context)) | which repositories use each machine-wide resource, and who installed it |

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

## Install Methods

`src/core/install-method.ts` `resolveInstallMethod()` decides how the running copy was
installed, from the realpath of the nearest `package.json` named `agemon` above the
running module (`resolvePackageRoot()`; the CLI also reads its version from there):

1. `dev` — `AGEMON_DEV=1`, or the package root has `.git` or `src/` (a source checkout).
2. `install-script` — the package root holds a regular `.agemon-install` file, which
   `install.sh` writes (its content is the installed version).
3. `npx` — the package root is under npm's exec cache (a `_npx` path segment).
4. `npm-global` — the package root is `<npm root --global>/agemon` (both realpathed)
   and that root is `<prefix>/lib/node_modules`. `npm root --global` runs only for a
   package root directly inside a `node_modules` dir, through the shared
   `src/core/npm-global.ts` `resolveGlobalNpmRoot` (absolute, normalised, existing).
5. `unknown` — anything else, for example a project-local `npm install agemon`, Volta,
   or `pnpm dlx` / `bun x`.

## Update Checking

`src/core/update-check.ts`, invoked at the top of both `install` and `nuke` action
handlers in `src/cli/index.ts`:

- Skipped entirely when `--dry-run`, `AGEMON_DEV=1`, or `AGEMON_NO_UPDATE_CHECK=1`.
- Queries `GET /repos/Korak-997/agemon/releases/latest` (GitHub API), cached in
  `$XDG_CACHE_HOME/agemon/update-check.json` (only an absolute `XDG_CACHE_HOME`; otherwise `~/.cache/...`) for 24h to avoid a
  network round-trip on every invocation and avoid rate-limiting.
- Network/cache failures are swallowed silently — never blocks the actual command.
- Non-interactive stdin/stdout (CI, piped output): prints a one-line notice only, never
  prompts.
- Versions compare by release precedence (`compareReleaseVersions` in
  `src/core/github-release.ts`): a prerelease sorts below its release, and
  `alpha < beta < rc`.
- Interactive TTY with a newer version, for an `install-script` or `npm-global` copy
  (`resolveInstallMethod`, called only once a newer version is known): prompts to update;
  on yes it calls `installRelease` from `src/core/self-upgrade.ts`, the same path
  `agemon upgrade` uses. The prompt runs only after the command has finished, so no
  code runs after the copy on disk is replaced. Other methods, and root running with
  another user's environment, get a one-line hint instead.
- The tag from the API and the cached version must look like a release version
  (`X.Y.Z` with an optional `-alpha.N`/`-beta.N`/`-rc.N`); anything else is ignored.

## Self-Upgrade

`src/core/self-upgrade.ts`, behind `agemon upgrade [version]` and the update prompt:

- `installRelease` first refuses root with another user's environment
  (`HOME` not root's passwd home, or `XDG_STATE_HOME`/`XDG_CACHE_HOME` set) and an install
  whose owner is not the effective uid, or which (or whose parent) is not writable
  (`src/core/install-location.ts`).
- `install-script`: downloads `install.sh` and `SHA256SUMS` from the newer of the target
  and the latest release, writes the script to a private temp directory, re-hashes the
  file on disk, and runs `sh <path>` (no shell string, no pipe) with the cleaned
  subprocess environment, `AGEMON_VERSION=<target>`, any inherited `AGEMON_INSTALL_DIR`
  removed, and `AGEMON_INSTALL_DIR=<install dir>` only when the install dir is not the
  default for this uid (compared by realpath). The installer verifies the tarball itself
  and honours `AGEMON_VERIFY_ATTESTATION=1`.
- `npm-global`: downloads the target's `agemon.tgz` (20 MiB limit) and `SHA256SUMS`
  (1 MiB), checks the hash, runs `gh attestation verify` when
  `AGEMON_VERIFY_ATTESTATION=1`, then
  `npm install --global --ignore-scripts --prefix <prefix> <tarball>` and checks that
  `<prefix>/bin/agemon --version` reports the target.
- `--rollback` (install-script only) checks that `<install dir>.prev` is a real directory
  with a regular `.agemon-install`, a `package.json` named `agemon` and
  `bin/agemon.js`, and that it runs and reports the version its marker names. It then
  swaps the two directories with three renames in the same parent. A failed second rename
  puts the current install back. The swap is the last thing the process does, so no
  module of the other version is loaded.
- `install.sh` moves the replaced install to `<install dir>.prev` after a successful swap,
  but only when the replaced dir carries the marker. It replaces an existing `.prev` only
  when that is also a real, marker'd directory; otherwise it keeps none and says so.

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

# agemon

Bootstrap and reverse an AI coding agent environment in a repository with one CLI.

`agemon` installs a curated plugin bundle, tracks all managed actions in a state manifest,
and can cleanly reverse those actions with `nuke`.

## What It Does

Current v0.1 behavior is plugin-driven and runs in this order:

1. `crg`: installs and verifies `code-review-graph`.
2. `daemon`: registers `crg-daemon` autostart via `systemd --user`.
3. `skills`: installs bundled skills via `npx skills`.
4. `workflow-scaffolder`: writes bundled GitHub workflow files.
5. `cli-tool`: installs bundled global CLI tools.
6. `master-prompt`: consolidates agent rule files and pointer files.

Every mutating plugin action is recorded in `.agemon/state.json` and used by `nuke` for
targeted reversal.

## Requirements

- Linux with Ubuntu (`/etc/os-release` must report `ID=ubuntu`).
- Node.js `>=24` (used to run the installed CLI; no other Node tooling needed).
- `curl` and `tar` (used by the installer only).
- Binaries checked at runtime: `python3`, `pip`, `pipx`, `uv`, `crg`.

Notes:
- The CLI reports binary availability but does not auto-install missing dependencies.
- Unsupported platforms exit with a clear error message.

## Install

Install `agemon` system-wide with the installer script:

```bash
curl -fsSL https://raw.githubusercontent.com/Korak-997/agemon/master/install.sh | sh
```

This downloads the latest self-contained release build (no `node_modules` required),
and links it onto your `PATH` — as `/usr/local/bin/agemon` when run as root, or
`~/.local/bin/agemon` otherwise.

Or, from a local clone:

```bash
sh ./install.sh
```

Then run it in any repository you want to bootstrap:

```bash
agemon install
```

### Installer options

- `AGEMON_VERSION`: install a specific release tag instead of `latest` (e.g. `AGEMON_VERSION=0.1.0 sh install.sh`).
- `AGEMON_INSTALL_DIR`: override the install directory instead of the root/user default.

### Uninstalling agemon itself

`agemon nuke` reverses changes `agemon` made *inside a repository* — it does not remove
the `agemon` binary. To remove the CLI itself:

```bash
rm -rf ~/.local/share/agemon ~/.local/bin/agemon   # user install
sudo rm -rf /usr/local/lib/agemon /usr/local/bin/agemon   # root/system install
```

### Update checks

Each run of `agemon install`/`agemon nuke` (skipped for `--dry-run`) checks once a day
whether a newer GitHub Release exists:

- Interactive terminal: prompts to install the update now; on yes, re-runs `install.sh`
  in place and asks you to re-run your command against the new version.
- Non-interactive (CI, piped output): prints a one-line notice and continues — never
  blocks on a prompt.

Set `AGEMON_NO_UPDATE_CHECK=1` to disable this entirely.

## CLI Usage

`install` is the default command:

```bash
agemon [options]
```

Reverse managed changes:

```bash
agemon nuke [options]
```

### Global Options

- `--dry-run`: narrate actions without making changes.
- `--yes`: skip confirmation prompts.
- `--only <plugins>`: run only a comma-separated subset of plugins.
- `--skip-daemon`: skip daemon registration during install.
- `--no-color`: disable ANSI colors.
- `-v, --verbose`: show raw subprocess output beneath each step.
- `-q, --quiet`: reduce output to minimal step/final lines.

Examples:

```bash
# See planned actions only
agemon install --dry-run

# Install only skills and workflows
agemon install --only skills,workflow-scaffolder

# Reverse only specific plugins
agemon nuke --only skills,workflow-scaffolder
```

## Reversibility Guarantees

- `nuke` removes only agemon-managed artifacts tracked in `.agemon/state.json`.
- Pre-existing tools/files are detected and preserved.
- Master-prompt file edits are backed up in `.agemon/backups/master-prompt/` and restored
	on uninstall.

## Managed Outputs

By default, agemon may manage these paths:

- `.agemon/state.json`
- `.agemon/backups/master-prompt/*.bak`
- `.github/workflows/claude-code-security-review.yml`
- `.github/workflows/code-review-graph-action.yml`
- `AGENTS.md`
- `CLAUDE.md`
- `GEMINI.md`
- `.cursorrules`
- `.windsurfrules`

It also invokes external installers (`pipx`, `npm -g`, `npx skills`) when required.

## Local Development

```bash
npm install
npm run build
npm run typecheck
npm run lint
npm test
```

Development CLI entrypoint:

```bash
npm run dev -- --help
```

## Sandbox Harness

Use the sandbox harness for isolated, repeatable checks against fixtures in `test/fixtures`:

```bash
# One run
npm run sandbox -- run clean-repo

# Dry-run simulation
npm run sandbox -- run clean-repo --dry-run

# Install + nuke roundtrip integrity
npm run sandbox -- roundtrip clean-repo

# Watch mode
npm run sandbox -- watch clean-repo

# Reset sandbox artifacts
npm run sandbox -- reset
```

Useful sandbox flags:

- `--real`: execute real subprocesses/services instead of fake backends.
- `--trace`: map to verbose CLI output.
- `--quiet`: suppress captured terminal output.
- `--skip-daemon`: skip daemon plugin in the run.
- `--only <plugins>`: run selected plugins only.

## Detailed Docs

- Architecture and operations: `docs/architecture-and-operations.md`
- Release process: `docs/releasing.md`
- Audit and review report: `docs/review-2026-08-13.md`
- Historical implementation plan: `docs/implementation-plan.md`

## Roadmap Notes

Planned but not currently implemented:

- Dedicated `status` command.
- Dedicated `doctor` command.
- Native Windows/macOS platform support.

## License

MIT

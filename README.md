# agemon

Bootstrap and reverse an AI coding agent environment in a repository with one CLI.

`agemon` installs a curated plugin bundle, tracks all managed actions in a state manifest,
and can cleanly reverse those actions with `nuke`.

## What It Does

Current v0.1 behavior is plugin-driven and runs in this order:

1. `crg`: installs and verifies `code-review-graph`.
2. `daemon`: registers `code-review-graph watch` autostart via `systemd --user`, under a
   unit name derived from the current git repo (or plain directory, outside a repo) —
   see [Daemon naming](#daemon-naming).
3. `skills`: installs bundled skills via `npx skills`. Always installs the `essentials` group;
   additional groups (design, security, code quality, architecture, self-review, performance)
   are selected interactively, via `--skill-groups`, or skipped entirely in a non-interactive
   session — see [Skill Groups](#skill-groups).
4. `workflow-scaffolder`: writes bundled GitHub workflow files.
5. `cli-tool`: installs bundled global CLI tools.
6. `master-prompt`: consolidates agent rule files and pointer files.

Every mutating plugin action is recorded in `.agemon/state.json` and used by `nuke` for
targeted reversal.

### Re-running against an already-bootstrapped repo

Every plugin's `detect` + `verify` runs on each invocation, not just on first install:

- Not detected: fresh install, as above.
- Detected and healthy: reported and left alone — no reinstalling on every run.
- Detected but `verify` fails (e.g. a daemon stuck crash-looping): agemon reports what's
  currently there and asks whether to rewrite/fix it. `--yes` answers yes automatically;
  a non-interactive session (CI, piped output) answers no automatically and just reports
  the problem, matching the [update check](#update-checks)'s non-interactive behavior.

### Skill Groups

The `skills` plugin installs one always-on group plus whichever optional groups you select:

| Group | Skills | What it covers |
|---|---|---|
| `essentials` (always on) | `web-design-guidelines`, `writing-guidelines` | Vercel Labs' general web design and writing review guidelines. Not vendored/renamed — see note below. |
| `design` | `agemon-design` + 3 recipe variants (`agemon-design-minimal`, `agemon-design-editorial`, `agemon-design-dashboard`) | Design engineering: anti-slop rules, discovery, and outcome recipes (dashboard/landing/auth), covering both visual design and UI/UX. |
| `security` | `agemon-security` | Exploit-driven security review — no finding without a working proof-of-concept. |
| `code-quality` | `agemon-clean-code`, `agemon-house-rules` | Simplicity, DRY architecture, self-documenting naming, surgical scope control. |
| `architecture` | `agemon-architecture` | Clean Architecture review: dependency rule, layering, boundary crossing, SOLID. |
| `self-review` | `agemon-verify-before-done`, `agemon-review-intake`, `agemon-review-request`, `agemon-root-cause` | Verification before claiming completion, giving/receiving code review, root-cause debugging. |
| `performance` | `agemon-performance` | Algorithmic-complexity-first discipline: N+1 detection, hot-loop hygiene, when not to optimize. |

Selection order:

- `--skill-groups <ids>`: explicit, non-interactive. Comma-separated group ids, or the keywords
  `all` / `none`. Always includes `essentials` regardless of what you pass.
- No flag, interactive terminal: asks once per optional group.
- No flag, non-interactive (CI, piped output, or `--dry-run`): only `essentials` installs —
  pass `--skill-groups` explicitly to get optional groups without a prompt.

Re-running `agemon` in a repo only re-verifies the groups that repo already selected — it never
asks you to newly opt into groups you previously declined.

Every non-essential skill is vendored into agemon's own repo under `assets/skills/` and renamed
under an `agemon-*` identity, rather than fetched and installed under its original upstream name
at bootstrap time — so installs don't depend on GitHub being reachable, won't drift if an
upstream repo changes, and read as agemon's own rather than a third-party project name. See
[Vendored Skills](#vendored-skills--attribution) for sources and licenses.

`essentials` is the one exception: `vercel-labs/agent-skills` carries no detected license, so
agemon can't vendor (redistribute) a renamed copy of it — it's still fetched live from that repo
under its original names, exactly as before this skill-groups feature existed.

### Daemon naming

The daemon's systemd unit is named `agemon-crg-daemon-<slug>.service`, where `<slug>` is
derived from the current git repository's top-level directory name (or the plain working
directory name outside a repo). This keeps repos independent — without it, running
`agemon` in two different repos on the same machine would register the *same* systemd
user unit, and the second repo would silently overwrite and restart the first repo's
daemon on its own `WorkingDirectory`.

## Requirements

- Linux with Ubuntu (`/etc/os-release` must report `ID=ubuntu`).
- Node.js `>=24` (used to run the installed CLI; no other Node tooling needed).
- `curl` and `tar` (used by the installer only).
- Binaries checked at runtime: `python3`, `pip`, `pipx`, `uv`, `code-review-graph`.

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

Then run it in any repository you want to bootstrap — plain `agemon` *is* the install
command, there is no separate `install` subcommand:

```bash
agemon
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

Each run of `agemon`/`agemon nuke` (skipped for `--dry-run`) checks once a day
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
- `--skill-groups <groups>`: comma-separated skill group ids to install, or `all`/`none` — see
  [Skill Groups](#skill-groups).
- `--no-color`: disable ANSI colors.
- `-v, --verbose`: show raw subprocess output beneath each step.
- `-q, --quiet`: reduce output to minimal step/final lines.

Examples:

```bash
# See planned actions only
agemon --dry-run

# Install only skills and workflows
agemon --only skills,workflow-scaffolder

# Reverse only specific plugins
agemon nuke --only skills,workflow-scaffolder

# Install every skill group non-interactively (e.g. in CI)
agemon --yes --skill-groups all

# Install only the security and architecture groups on top of essentials
agemon --yes --skill-groups security,architecture
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

## Vendored Skills & Attribution

The `design`, `security`, `code-quality`, `architecture`, `self-review`, and `performance` skill
groups (see [Skill Groups](#skill-groups)) are vendored under `assets/skills/<group>/<skill>/`.
Each vendored skill directory carries a `NOTICE.md` (source repo, exact commit, retrieval date)
and a copy of its upstream `LICENSE`. Sources, all MIT-licensed:

Every vendored skill is renamed to an `agemon-*` identity (frontmatter `name` and directory) —
it should never be obvious from installing it that the content originated elsewhere. Original
upstream names are preserved only in each skill's `NOTICE.md`, for attribution.

| Renamed to | Originally | Source |
|---|---|---|
| `agemon-design`, `agemon-design-minimal`, `agemon-design-editorial`, `agemon-design-dashboard` | `ui-craft` + 3 recipe variants | [educlopez/ui-craft](https://github.com/educlopez/ui-craft) |
| `agemon-security` | `security-review` (also avoids colliding with Claude Code's own built-in skill of the same name) | [Dilaz/security-review-skill](https://github.com/Dilaz/security-review-skill) |
| `agemon-architecture` | `clean-architecture` | [nathankim0/clean-architecture-skills](https://github.com/nathankim0/clean-architecture-skills) |
| `agemon-verify-before-done`, `agemon-review-intake`, `agemon-review-request`, `agemon-root-cause` | `verification-before-completion`, `receiving-code-review`, `requesting-code-review`, `systematic-debugging` | [obra/superpowers](https://github.com/obra/superpowers) (cherry-picked; not a full vendor of that framework) |
| `agemon-clean-code` | `karpathy-guidelines` | [swarmclawai/andrej-karpathy-skills](https://github.com/swarmclawai/andrej-karpathy-skills) |
| `agemon-house-rules`, `agemon-performance` | — | Original — authored for this project, `agemon-house-rules` distilled from this repo's own `AGENTS.md`. |

`ui-craft`'s own reference files (33 files under `agemon-design/references/`) still mention
"ui-craft" by name in prose in a few places — they document that project's own separate CLI/MCP
tooling (`ui-craft-detect`, the `ui-craft` MCP server's `route_task`), which genuinely still goes
by that name and isn't part of what agemon ships. Rewriting 33 files of someone else's authored
guidance to scrub every mention was judged higher-risk than leaving a few internal citations
intact; the skill's own identity (what gets installed, listed, and invoked) is fully renamed.

## Roadmap Notes

Planned but not currently implemented:

- Dedicated `status` command.
- Dedicated `doctor` command.
- Native Windows/macOS platform support.

## License

MIT

# agemon

[![CI](https://github.com/Korak-997/agemon/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/Korak-997/agemon/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Korak-997/agemon)](https://github.com/Korak-997/agemon/releases/latest)
[![npm](https://img.shields.io/npm/v/agemon)](https://www.npmjs.com/package/agemon)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/Korak-997/agemon/badge)](https://scorecard.dev/viewer/?uri=github.com/Korak-997/agemon)

Bootstrap and reverse an AI coding agent environment in a repository with one CLI.

`agemon` installs a curated plugin bundle, tracks all managed actions in a state manifest,
and can cleanly reverse those actions with `nuke`.

Documentation, the skill library and the installer: <https://agemon.korak-kurani.com>.

![agemon installs the essentials bundle with --yes, agemon nuke removes everything it added, and git status --ignored shows the repository exactly as it was](docs/demo/agemon.gif)

## Why agemon

- **One command, the same setup everywhere.** Agent rules, skills, subagents, the code
  graph and its daemon land the same way in every repository, pinned to exact versions.
- **You approve every change first.** agemon shows a plan with diffs, asks before it
  writes, and rolls back the whole run if any step fails.
- **Fully reversible.** Every change is recorded, and `agemon nuke` removes exactly what
  agemon added, leaving your own files alone.

Want to help? Start with [CONTRIBUTING.md](CONTRIBUTING.md).

## What It Does

agemon is plugin-driven and runs its plugins in this order:

1. `crg`: installs and verifies `code-review-graph`.
2. `daemon`: registers `code-review-graph watch` autostart via `systemd --user` (Linux) or
   a launchd user agent (macOS), under a name derived from the repository's path — see
   [Daemon naming](#daemon-naming).
3. `skills`: installs bundled skills with a pinned copy of the `skills` CLI. Always installs the `essentials` group;
   additional groups (design, security, code quality, architecture, self-review, performance,
   team lead) are selected interactively, via `--skill-groups`, or skipped entirely in a
   non-interactive session — see [Skill Groups](#skill-groups).
4. `agents`: installs the Claude Code subagents that come with an installed skill group into
   `.claude/agents/` — see [Subagents](#subagents). It depends on `skills`, so `--only agents`
   also runs `skills`.
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
| `commit` | `agemon-commit` | Staging review, commit message structure, and splitting unrelated changes into separate commits. |
| `teamlead` | `agemon-plan-rfc`, `prd-generator`, `skill-headofit-audit`, `skill-incident-rca`, `skill-meeting-lifecycle`, `skill-obsidian-vault-sync`, `skill-prd-decomposer`, `skill-sec-check`, `skill-task-extractor`, `skill-techlead-reviewer`, `skill-tech-spike` | Team-lead workflows: RFC planning, PRD generation/decomposition, meeting lifecycle, task extraction, tech spikes, IT audits, incident RCA, security checks, tech-lead review, and Obsidian vault sync. |
| `geo-seo` | `geo` (`/geo audit <url>` and the other `/geo` commands), `geo-audit`, `geo-citability`, `geo-crawlers`, `geo-llmstxt`, `geo-brand-mentions`, `geo-platform-optimizer`, `geo-technical`, `geo-content`, `geo-report`, `geo-schema`, `geo-report-pdf` | GEO (generative engine optimization): audits how likely AI search (ChatGPT, Perplexity, Google AI Overviews) is to find and cite a website — citability, AI crawler access, llms.txt, schema, technical SEO, brand mentions — and writes client-ready reports. Upstream names kept; see [Vendored Skills](#vendored-skills--attribution). |

Selection order:

- `--skill-groups <ids>`: explicit, non-interactive. Comma-separated group ids, or the keywords
  `all` / `none`. Always includes `essentials` regardless of what you pass.
- No flag, `--yes`: every group installs, the same way `--yes` answers every other prompt.
- No flag, interactive terminal: one multiselect over the optional groups (space toggles, enter
  confirms), on top of `essentials`.
- No flag, non-interactive (CI, piped output, or `--dry-run`): only `essentials` installs —
  pass `--skill-groups` explicitly to get optional groups without a prompt.

The group question comes first, while agemon builds the plan, so every group you picked is a
separate row (`skill-group:<id>`, or `custom-skill-group:<id>` for a project-defined group) in
the plan, the consent screen and `agemon status`, with each skill and its
pinned source. Groups you were shown and did not pick are recorded as declined once you approve
the install gate. Ctrl-C at the question leaves the repository untouched.

Re-running `agemon` in a repo only re-verifies the groups that repo already selected — it never
asks you about, or installs, groups you previously declined, even when `--skill-groups` or
`skill_groups` names them. A group added later (to agemon or to `agemon.toml`) is installed
when `--skill-groups` or `skill_groups` names it; otherwise it is offered once in an
interactive run. A non-interactive run without `--yes` leaves it pending; a non-interactive
`--yes` run records new agemon groups as declined and leaves project-defined groups pending.

#### Subagents

Some groups come with Claude Code subagents, which the `agents` capability installs into
the project's `.claude/agents/` together with the group. Today only `geo-seo` has any: the
five audit agents `geo-audit-ai-visibility`, `geo-audit-platform`, `geo-audit-technical`,
`geo-audit-content` and `geo-audit-schema`, which `/geo audit` launches in parallel.

- Each agent file has only `name`, `description` and `tools`. `tools` is an allowlist:
  `WebFetch` for every agent, plus `Bash` (for one fixed, read-only `curl` you approve per
  run) for the technical and schema agents. Nothing is pre-approved, and no agent sets a
  permission mode, hooks or MCP servers.
- The agents have their own consent step, which names every agent with its tools. With
  `--yes`, agemon prints that list instead of asking.
- Agent files are handled like rule files: an agent you edited is a conflict and is never
  overwritten without a decision (`[conflict_decisions] "agent-file:<name>" = "keep"`,
  `"replace"` or `"skip"`); a replaced file is backed up first; `nuke` removes the agents
  agemon created and restores the files it replaced.
- An agent's group must be installed for the agent to be written; if you decline the group,
  its agents are skipped.
- `agemon status` shows one row per agent: managed, adopted (identical but not written by
  agemon on this machine), changed (your edit, kept), absent, or not a regular file. It
  needs attention (exit 2) when agemon has a newer version of an agent you didn't change,
  or when another file in `.claude/agents/` declares the same `name:` as one of agemon's
  agents — Claude Code identifies agents by that name and may load the other file instead.
- Claude Code picks up a new `.claude/agents/` directory in sessions started after it exists.

**Bundled skill updates.** agemon compares each bundled skill in `.claude/skills/` with
every version it has shipped. A skill still identical to an older version is updated to
the current one on the next run, behind the same consent step as installing a group (the
preview marks it "update (bundled content changed)"); `agemon status` shows "update
available" until then. A skill that differs from every shipped version — for example one
you edited — is never replaced: `status` shows it as changed, with the reason, and says how
to get agemon's version (delete `.claude/skills/<name>` and run `agemon`). An update that
fails halfway removes the half-written copy, so the next run reinstalls it; a rollback keeps
an update it already made and says so. This is also how an older `geo-seo` install picks up
the `geo-audit` that launches the installed subagents.

Skills recorded for a custom group that `agemon.toml` no longer defines are listed in one
"skills of removed groups" row.

#### Project-defined skill groups

A project can define its own groups in `agemon.toml`:

```toml
skill_groups = "essentials,house-style"

[custom_skill_groups.house-style]
label = "House style"
skills = [
  { source = "./tools/skills/house-rules" },
  { source = "github:acme/agent-skills", ref = "<40-character commit sha>", skill = "lint-rules" },
]
```

- A **local** source is a directory in this repository (`./…`, not under `.agents/`, `.claude/`,
  `.git/` or `.agemon/`, no symlinks anywhere in it, at most 200 entries and 8 MiB). The skill's
  name is the directory name.
- A **GitHub** source names `github:<owner>/<repository>`, a full 40-character commit `ref` (no
  branches, tags or short shas) and the `skill` to take from `skills/<skill>/` in that
  repository. agemon fetches exactly that commit without your git credentials.
- Each skill's `SKILL.md` must declare the same `name`.
- A group id must not reuse a built-in group id, or be `all`/`none`; a skill name must not
  reuse a built-in skill name or appear twice.

A custom group is installed only when you pick it in the interactive question or name it in
`--skill-groups` or `skill_groups`; `--yes` and `--skill-groups all` cover agemon's own groups
only. Custom groups get their own consent gate, which always prints every source (the local
content hash, or the GitHub repository and commit), even under `--yes`. A custom skill is
instructions for your agent from whoever wrote the repository's `agemon.toml`: review it like
code. A commit sha pins content, not origin — GitHub serves a commit from any fork under the
original repository's URL, so check the commit itself, not just the repository name.

Every non-essential skill is vendored into agemon's own repo under `assets/skills/`, rather than
fetched and installed under its original upstream name at bootstrap time — so installs don't
depend on GitHub being reachable and won't drift if an upstream repo changes. Vendored skills
sourced from a third-party project are renamed under an `agemon-*` identity so they read as
agemon's own; the `team-lead` skills beyond `agemon-plan-rfc` and `prd-generator` are original to
this project and keep their `skill-*` names, and `geo-seo` keeps its upstream `geo-*` names. See [Vendored Skills](#vendored-skills--attribution)
for sources and licenses.

`essentials` is the one exception: `vercel-labs/agent-skills` carries no detected license, so
agemon can't vendor (redistribute) a renamed copy of it. agemon fetches the skills under their
original names from one pinned commit of that repo, checks that the checkout really is that
commit, and installs from it.

### Daemon naming

The daemon's systemd unit is named `agemon-crg-daemon-<slug>-<hash>.service`. `<slug>` is
the repository directory's name, and `<hash>` is the first 8 hex digits of the SHA-256 of
the repository's real path. Two repositories with the same name therefore get separate
units, so one never overwrites and restarts the other's daemon.

The ledger records the unit name, and `nuke` removes the unit it recorded, even after the
repository was renamed or moved. A unit that now runs for another existing repository is
kept and reported. Units registered by older agemon versions (named without the hash) are
replaced on the next `agemon` run. User linger is shared by every repository: `nuke`
switches it off only in the repository that switched it on, once no other repository
uses it and no other agemon daemon unit is left.

On macOS the daemon is a launchd user agent, `~/Library/LaunchAgents/dev.agemon.crg.<slug>-<hash>.plist`
(mode `0644`), with the same `<slug>` and `<hash>`. It runs while you are logged in to the
desktop (launchd has no linger), so register it from a desktop session, not over SSH only.
launchd offers no per-service sandbox agemon can use, so the agent runs `code-review-graph
watch` with your normal user rights (like the Linux `compat` profile) and a `PATH` of system
directories only (`/usr/bin:/bin:/usr/sbin:/sbin`, so git is Apple's `/usr/bin/git`). An
entry registered on the other OS is never touched: `nuke` fails and names it, so run
`agemon nuke` on that machine.

### Daemon hardening and failures

On Linux, agemon first registers the unit with the `strict` profile: the system and your
home directory are read-only for code-review-graph, except the repository (its `.git/`
stays read-only) and `~/.code-review-graph`, and agemon's own state directory, which holds
its ledger key, is hidden. If the strict unit does not start, agemon falls back to
`compat`, which runs with your normal user rights. A repository that is or contains your
home directory goes straight to `compat`, and `AGEMON_DAEMON_HARDENING=compat` forces it.
The run prints the profile in use.

`strict` needs an unprivileged user namespace. On Ubuntu with
`kernel.apparmor_restrict_unprivileged_userns=1`, systemd can start the unit without the
sandbox. agemon checks for this once the unit runs and then prints
`daemon hardening: strict requested, not enforced on this host` (`status` and `inspect`
show the same). The daemon keeps running, without the sandbox.

A daemon that keeps crashing is stopped: systemd gives up after five starts within ten
minutes and the unit ends `failed`. `agemon status` reports it as failed, names
`journalctl --user -u <unit>` to see why, and exits 2; the next `agemon` run registers it
again. launchd has no such limit, so on macOS a crashing agent is restarted at most once a
minute.

agemon refuses to build the code graph or register the daemon when `.code-review-graph`
(or a root `.code-review-graph.db*` file) is tracked by git, is not a real directory, or
contains a symlink or special file, because code-review-graph would write through it to
wherever the link points. Remove it from the repository
(`git rm -r --cached .code-review-graph`) and run agemon again. On systemd the unit also
checks these paths each time it starts, so a link that arrives with a `git pull` stops the
daemon instead of being written through. launchd has no such start-time check; on macOS
only agemon's own checks at each run apply.

Daemon units registered before 6.0.0 get the start-time checks, the restart limit and the
current hardening only after `agemon nuke --only daemon` and a fresh `agemon` run.

## Requirements

- To install, apply or nuke: Ubuntu, Debian, a derivative whose `/etc/os-release`
  `ID_LIKE` lists `ubuntu` or `debian` (Linux Mint, Pop!_OS, …), or macOS 11 or later.
  On macOS, run agemon as your own user: it refuses to run as root there, because
  everything it installs belongs to one user. `inspect`, `status` and `plan` are
  read-only and run on any OS with Node.js.
- agnix (the `cli-tool` capability) has pinned builds for Linux x64, Linux arm64 and
  Apple Silicon Macs. On other machines (Intel Macs, x64 Node under Rosetta, other Linux
  architectures) agemon skips `cli-tool` and says so; `agemon.toml` keeps it.
- Without pipx, install it first: `sudo apt install pipx`, or on macOS
  `brew install pipx` with Homebrew's bin directory on `PATH`.
- The daemon needs systemd on Linux, or launchd on macOS. Without systemd (most
  containers, WSL without systemd), agemon skips the daemon and says so; `agemon.toml`
  still lists it for machines that have systemd.
- Node.js `>=22.12` (used to run the installed CLI; no other Node tooling needed).
- `curl` and `tar` (used by the installer script only).
- Binaries checked at runtime: `python3`, `pip`, `pipx`, `uv`, `code-review-graph`.

Notes:
- The CLI reports binary availability but does not auto-install missing dependencies.
- Unsupported platforms exit with a clear error message.

## Install

There are two install routes. Both install the same file: the release's `agemon.tgz`,
whose SHA-256 is listed in that release's `SHA256SUMS`. The npm package carries npm
provenance; the GitHub Release asset carries a GitHub build attestation. The package has
no runtime dependencies (they are bundled), so npm fetches nothing else.

**With npm:**

```bash
npm install --global agemon
```

**Without npm**, with the installer script:

```bash
curl --proto '=https' --tlsv1.2 -fsSL https://github.com/Korak-997/agemon/releases/latest/download/install.sh | sh
```

This downloads the latest self-contained release build (no `node_modules` required),
checks it against the release's `SHA256SUMS`, and links it onto your `PATH` — as
`/usr/local/bin/agemon` when run as root, or `~/.local/bin/agemon` otherwise.

The one-liner runs `install.sh` without checking it first. To verify the installer too:

```bash
cd "$(mktemp -d)"
curl --proto '=https' --tlsv1.2 -fsSLO https://github.com/Korak-997/agemon/releases/latest/download/install.sh
curl --proto '=https' --tlsv1.2 -fsSLO https://github.com/Korak-997/agemon/releases/latest/download/SHA256SUMS
grep ' install.sh$' SHA256SUMS | sha256sum -c -   # macOS: shasum -a 256 -c -
gh attestation verify install.sh --repo Korak-997/agemon \
  --signer-workflow Korak-997/agemon/.github/workflows/release.yml   # optional: build provenance
sh install.sh
```

Or, from a local clone:

```bash
sh ./install.sh
```

**Trying it once with `npx`:** `npx agemon` works, but only run it in a repository you
trust. npx resolves and starts agemon using the repository's own `.npmrc` and
`node_modules`, so a hostile checkout can run its code before agemon starts. agemon also
ignores npm's injected configuration for the programs it runs itself in that mode,
including an `NPM_CONFIG_PREFIX` you exported. Install it with one of the routes above
for everyday use.

Then run it in any repository you want to bootstrap — plain `agemon` *is* the install
command, there is no separate `install` subcommand:

```bash
agemon
```

### Installer options

- `AGEMON_VERSION`: install a specific release tag instead of `latest` (e.g. `AGEMON_VERSION=6.0.0 sh install.sh`).
  Releases up to 4.7.2 have no `SHA256SUMS` and can no longer be installed this way.
- `AGEMON_INSTALL_DIR`: override the install directory instead of the root/user default.
  It must be an absolute path to a new or empty directory, or to one a previous agemon
  install created. The installer refuses anything else (a symlink, your home directory, a
  source checkout, a directory with other files) and changes nothing.
- `AGEMON_VERIFY_ATTESTATION=1`: also verify the tarball's build-provenance attestation
  with `gh attestation verify`. This needs the GitHub CLI, logged in with `gh auth login`.

### What the installer verifies

- **Checksums** (always): the tarball must match the `SHA256SUMS` published with the same
  release. This catches truncated or corrupted downloads and a CDN serving files from two
  different releases. It does not catch a consistently stale `latest` alias (you would get
  an older, still verified release), and a checksum from the same place as the file proves
  nothing against an attacker who can replace both.
- **Attestations** (opt-in, above): prove the tarball was built by this repository's release
  workflow, so they catch a tampered or swapped asset.
- **Neither** helps if the release workflow itself, a dependency it builds with, or the
  maintainer's account is compromised: a tarball built from a poisoned dependency is still
  correctly checksummed and attested.
- The CLI's self-update checks `install.sh` against `SHA256SUMS`; it verifies attestations
  only if you export `AGEMON_VERIFY_ATTESTATION=1`, which the installer it runs honours.

### Upgrading and rolling back

```bash
agemon upgrade            # install the latest release
agemon upgrade 6.0.0      # install that release (asks before a downgrade)
agemon upgrade --rollback # switch back to the install the last upgrade replaced
```

`agemon upgrade` works out how the running copy was installed and upgrades it the same
way:

- **Install script:** it runs that release's `install.sh` after checking it against the
  release's `SHA256SUMS`, for the same install dir (a custom `AGEMON_INSTALL_DIR` is kept).
  The installer keeps the replaced install as `<install dir>.prev`, and
  `agemon upgrade --rollback` swaps the two (run it again to swap back). A downgrade
  always runs the newest release's installer, with the older version as its target.
- **npm (`npm install --global`):** it downloads the release's `agemon.tgz`, checks it
  against `SHA256SUMS` (and its attestation with `AGEMON_VERIFY_ATTESTATION=1`), and runs
  `npm install --global --ignore-scripts --prefix <the running copy's prefix>` on that
  file. `--print` prints these steps instead of running them. Upgrade with
  `agemon upgrade`, not `npm update -g`: npm records the install as coming from a local
  file. There is no `--rollback`; install the previous version by name.
- **npx:** npx runs the version you ask for (`npx agemon@6.0.0`).
- **A source checkout, Volta, `pnpm dlx`, `bun x` or a project-local install:** agemon
  says it can't tell how it was installed; update it the way you installed it.

`upgrade` without a version never downgrades: if the latest release is not newer, it
reports that agemon is up to date. It refuses to replace an install another user owns
(run it as that user: `sudo` for a root install, no `sudo` for your own), and refuses to
run as root with another user's environment (`sudo -E`). Don't run two upgrades or
rollbacks of the same install at once.

### Uninstalling agemon itself

`agemon nuke` reverses changes `agemon` made *inside a repository* — it does not remove
the `agemon` binary. Run `agemon nuke` in each repository first, then remove agemon
itself:

```bash
agemon self-uninstall --dry-run   # show what would be removed
agemon self-uninstall             # asks once; --yes skips the question
```

For an install-script copy it removes the install dir, its `.prev` rollback copy, the
`agemon` link that points into it, the update-check cache, and agemon's machine state
(`${XDG_STATE_HOME:-~/.local/state}/agemon`, on macOS `~/Library/Application Support/agemon`
unless `XDG_STATE_HOME` is set: shared-tools ledger and tool caches). It
keeps the machine state while a repository still uses a shared tool, an interrupted
apply can still be recovered, or agemon is running somewhere else, and says which. It
lists the repositories it knows still have agemon-managed files; agemon only knows
repositories that use a shared tool, so check any others yourself. It never changes
files inside repositories. Machine state is per user: run it as the user who installed
agemon (with `sudo` for a root install).

It refuses to start while an interrupted apply can still be recovered (run
`agemon recover` first). For an npm install it prints
`npm uninstall --global --prefix <prefix> agemon`. A copy run through npx has nothing to
remove, and a source checkout or an install agemon can't identify is refused.

### Update checks

`agemon`, `agemon apply` and `agemon nuke` check once a day whether a newer GitHub Release
exists. The check never slows a command down:

- the lookup starts in the background when the command starts, and its result is shown
  only **after** the command has finished and exited successfully. If the lookup has not
  finished by then, it is cancelled and tried again on a later run;
- in an interactive terminal (without `--yes`), for an install-script or npm install,
  agemon then asks whether to install the update. On yes, it upgrades exactly as
  `agemon upgrade` would (see above). Nothing runs if a check fails;
- with `--yes`, without a terminal, or for any other install method, it prints a one-line
  notice with the command to run instead of asking. A release candidate is offered its
  final release; an older release is never offered.

There is no check at all for `inspect`, `status`, `plan` or `recover`, with `--dry-run` or
`--quiet`, when `CI` is set (to anything other than `0` or `false`), or when
`AGEMON_NO_UPDATE_CHECK=1` is set.

## CLI Usage

`install` is the default command:

```bash
agemon [options]
```

Reverse managed changes:

```bash
agemon nuke [--yes] [--dry-run] [--only <plugins>] [--skip-daemon] [--remove-shared <tools>]
```

`nuke` first lists everything it will reverse, including machine-wide steps such as
uninstalling a global npm package or disabling user linger. It then asks once. Notes:

- `--yes` skips the list and the question;
- without a terminal and without `--yes`, it prints the list and stops (exit 0), the
  same way a first install previews. **Scripts that ran `agemon nuke` without `--yes`
  must now pass it;**
- it never removes something another installed capability still needs. With
  `--skip-daemon`, or when the daemon could not be removed, code-review-graph stays as
  long as the daemon is installed. The list shows each such line as `kept: …`;
- if one capability cannot be reversed, `nuke` still reverses the others, then exits 1
  and keeps the failed one's ledger entries so you can fix the cause and re-run;
- `agemon.toml` is deleted only when nothing failed and the ledger is empty afterwards. With
  `--only` or `--skip-daemon`, that run must also have reversed at least one entry, so a
  fresh clone's committed `agemon.toml` survives `nuke --only …`. Deleting it is always
  listed and asked about like any other reversal;
- `nuke --dry-run` changes nothing, not even `.agemon/`.
- code-review-graph and agnix are shared by every repository on the machine. `nuke`
  removes one only when this repository installed it and no other repository uses it
  (`agemon status` lists the users under "Shared tools"). A tool agemon installed before
  it tracked shared tools is kept unless you pass `--remove-shared code-review-graph,agnix`
  (or one of them); the kept line prints the manual uninstall command. See
  [Two Ledgers](docs/architecture-and-operations.md#two-ledgers).
- skills: `nuke` removes `.claude/skills/<name>` itself, without the skills CLI and
  without network access, and only when its content is a version agemon installed; an
  edited copy is kept and named. A custom group's skill counts as installed by agemon
  only if it matched its source at install time, which agemon recorded then; a copy with
  no such record is kept and named. It never deletes `.agents/skills/<name>`, which other
  tools may use, and removes only agemon's skills from `skills-lock.json`.
- `.gitignore` and directories: every `nuke` removes the `.claude`, `.claude/skills` and
  `.claude/agents` directories agemon created once they are empty (never their contents).
  When the last capability goes, it also removes the `/.agemon/` and `/skills-lock.json`
  lines agemon added (only the exact lines it appended and recorded; your own equivalent
  lines stay), even in a committed `.gitignore`, and deletes a `.gitignore` agemon created
  once it is empty. `/skills-lock.json` stays while `skills-lock.json` exists, and
  `/.agemon/` stays while `.agemon/` exists. Installs made before agemon recorded these
  lines keep them, and `nuke` says so.

> **Downgrading:** an older agemon's `nuke` does not know these records, so it keeps
> `agemon.toml` and `.agemon/`; a newer agemon's `nuke` then finishes the cleanup.

Restore the files an interrupted apply changed (see
[Interrupted applies](#interrupted-applies)):

```bash
agemon recover [--yes] [--dry-run]
```

### Global Options

- `--dry-run`: narrate actions without making changes.
- `--yes`: skip confirmation prompts.
- `--only <plugins>`: run only a comma-separated subset of plugins.
- `--skip-daemon`: skip daemon registration during install; keep the daemon during `nuke`.
- `--skill-groups <groups>`: comma-separated skill group ids to install, or `all`/`none` — see
  [Skill Groups](#skill-groups).
- `--no-color`: disable ANSI colors.
- `-v, --verbose`: print each subprocess's command line, exit code and the last 20 lines of
  its stdout/stderr beneath the step. Secrets that look like tokens, keys, passwords,
  `Authorization` values, credentials in URLs and PEM blocks are redacted; the environment
  is never printed. `--quiet` wins over `--verbose`.
- `-q, --quiet`: reduce output to minimal step/final lines.

Examples:

```bash
# See planned actions only
agemon --dry-run

# Install every skill group non-interactively (e.g. in CI)
agemon --yes --skill-groups all

# Install only the security and architecture groups on top of essentials
agemon --yes --skill-groups security,architecture
```

### Repository root

agemon works on the repository you are in, not on the directory you run it from. It looks
from the current directory upwards for the nearest `.git` (a directory, or a `gitdir:`
file as in a git worktree), and uses the directory that holds it for `agemon.toml`,
`.agemon/`, rule files and subprocesses. When that is not the current directory, it prints
`Using repository root <path> (not the current directory).` to stderr.

It falls back to the current directory, with a notice, when:

- there is no `.git` above it;
- the first `.git` it meets is something else (for example a symlink);
- that repository contains your home directory, e.g. a home directory tracked as a
  dotfiles repo. Run `git init` in the project, or run agemon from the repository root;
- that repository, or its `.git`, belongs to another user (e.g. a `/tmp/.git` someone else
  created).

agemon reads `.git` from the filesystem only, so git configuration (such as
`core.worktree`) cannot redirect where it writes.

> **Upgrading:** if you ran agemon from a subdirectory with an earlier release, its state
> is in that subdirectory. Before upgrading, run `agemon nuke` there with the earlier
> release, or delete that subdirectory's `.agemon/` and agemon-written files by hand.

### `agemon.toml`

The first successful run writes `agemon.toml` at the repository root; commit it so
teammates and CI reconcile the same way. It accepts exactly these keys. An unknown key, an
unknown capability id, or an empty `capabilities` list is an error, never a silent
fallback:

```toml
capabilities = ["crg", "daemon", "skills", "agents", "cli-tool", "master-prompt"]
known_capabilities = ["crg", "daemon", "skills", "agents", "cli-tool", "master-prompt"]
skill_groups = "essentials,security"   # optional

[custom_skill_groups.house-style]      # optional — see Project-defined skill groups
label = "House style"
skills = [{ source = "./tools/skills/house-rules" }]

[conflict_decisions]                   # optional
"rule-file:CLAUDE.md" = "keep"         # keep | replace | skip
```

`known_capabilities` lists the capabilities the agemon that wrote the file knew about. When
a later release adds a capability that existing repositories should get (so far only
`agents`, and only when `skills` is listed), agemon includes it in the run and then adds
it to `capabilities` once, rewriting `agemon.toml`. All values are kept, but comments and
layout are not; if anything like that would be lost, the original is saved under
`.agemon/backups/` and the message names the file. Each such rewrite keeps its own saved
original; a later one never overwrites an earlier one. The rewrite happens only in an
interactive or `--yes` run that did not roll back, and never with `--dry-run`, `--only` or
`agemon plan`. To opt out, remove the capability from `capabilities` afterwards; because it
is now in `known_capabilities`, agemon does not add it again. Older agemon releases reject a
file with `known_capabilities` or `agents`, so upgrade agemon in CI before committing it. The
rewrite is skipped while `/.agemon/` is not git-ignored, and a full `agemon nuke` deletes
`.agemon/`, including that saved original.

A conflict is a rule file that holds your own rules where agemon would write a pointer.
It needs a decision. `--yes` never picks one for you, so record it under
`conflict_decisions`:

- `keep` and `skip` apply in any session;
- `replace` applies with `--yes` (so a committed `replace` overwrites that pointer file in
  `--yes` runs; agemon backs up the original first), and is asked again in an
  interactive terminal;
- without a decision, a non-interactive run exits 2 (see below).

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Success, nothing to do, preview only (`--dry-run`, or a first run without consent), or you declined. |
| `1` | Error, or the apply failed and was rolled back. |
| `2` | Drift found, consent was missing (operations or conflicts pending in a non-interactive run), or the apply finished but verification found problems. |
| `130` / `143` / `129` | Interrupted by SIGINT / SIGTERM / SIGHUP (see [Interrupted applies](#interrupted-applies)). |

`agemon status` exits 2 when it finds a problem in a repository where agemon has state (a
ledger or an interrupted apply). In a repository agemon never touched, it reports what it
sees and exits 0. An invalid `agemon.toml` is always reported, and `status` then exits 2;
`inspect` reports it too (`configError` in `--json`) and still exits 0.

If `git ls-files` cannot run (git missing, or "dubious ownership" in a CI container),
`status`, `inspect` and install print `could not check whether .agemon/ is tracked by git`.
This is a warning only, and it does not change the exit code.

Whether `/.agemon/` is git-ignored is decided by git itself
(`git check-ignore --no-index .agemon/`), so a later `!.agemon` rule in `.gitignore` counts as
not ignored. Inside a repository where git cannot answer, agemon treats `.agemon/` as not
ignored: an interactive run asks before adding `/.agemon/` to `.gitignore`, a
non-interactive run without `--yes` stops, and the git error is printed as
`could not ask git whether .agemon/ is ignored: …` (in `inspect --json` it is part of
`isolation.trackingCheckError`).

Before installing code-review-graph or its daemon, agemon reads the repository's own git
configuration (`.git/config`, `config.worktree`, `.gitmodules`, and the same files of
populated submodules) and checks every key against a short allowlist of settings that
cannot name a program. If any key falls outside it, the install goes to a separate
**trust gate** that lists every such key and value (secrets redacted):

- interactively, you approve or decline that gate like any other;
- `--yes` alone does **not** approve it: the operations are skipped with the keys listed,
  and the run exits 2;
- `--yes --trust-repo-git-config` approves it for that run only (the keys are still
  printed). The flag is never read from `agemon.toml` or any file in the repository, so a
  repository cannot opt itself in; read the printed keys before you pass it.

More than 20 such keys, keys that cannot be shown safely, and a git configuration agemon
cannot read are always skipped, with no override. On an existing install, `status` shows
the keys as needing attention and exits 2, and a daemon unit written before these
safeguards is reported until you run `agemon nuke --only daemon`, then
`agemon --only daemon`.

### Agent Detection (`agemon inspect`)

`agemon inspect` reports, read-only, which coding-agent ecosystems the repo is set up for
and which are actually present on the machine. Three ecosystems are covered: **Claude
Code**, **Gemini CLI**, and **VS Code/GitHub Copilot**. For each, the report shows:

- **configured** — recognizable config exists in the repo (e.g. `CLAUDE.md`,
  `.claude/settings.json`, `GEMINI.md`, `.gemini/settings.json`, or Copilot instruction
  files), independent of anything installed on the machine.
- **installed** — a real executable resolved on `PATH` and reported a version via a
  `--version`-style probe. The report always shows the resolved absolute path, never just
  the bare command name, so it's clear exactly what agemon ran. Copilot has no standalone
  executable, so it never advances past `configured`.
- **usable** — opt-in only, never run by default. Pass `--check-agents-usable` to also run
  a non-mutating dry-run check (e.g. listing config) for adapters that define one.

Detection never executes an agent with a prompt or tool access — only version/dry-run
probes. The first time it looks for installed executables, agemon asks for one-time
confirmation ("May agemon look for AI coding agents installed on this machine?"); declining
still returns full `configured` results, just without the installed/usable checks.

```bash
# Table report, including the Agents section
agemon inspect

# Same, plus an opt-in non-mutating usability probe
agemon inspect --check-agents-usable

# Machine-readable report (agents included under `agents`)
agemon inspect --json
```

`agemon status` includes a one-line agent summary (counts configured/installed) alongside
its usual health/drift output.

## Reversibility Guarantees

- `nuke` removes only agemon-managed artifacts tracked in `.agemon/state.json`, and among
	those, it removes skills, subagents, shared tools, daemon units and the code graph only
	when this machine wrote the entry (each entry carries a receipt keyed by
	`${XDG_STATE_HOME:-~/.local/state}/agemon/ledger-key`). Entries from an agemon before
	receipts, from another machine or from a committed ledger are kept and reported, with
	what to remove by hand; `status` counts them. See
	[Ledger receipts](docs/architecture-and-operations.md#ledger-receipts).
- Pre-existing tools/files are detected and preserved.
- The `.gitignore` lines and empty directories agemon added are recorded too, so a full
	`nuke` leaves the repository as it was before agemon (see `nuke` above).
- Master-prompt file edits are backed up in `.agemon/backups/` and restored on uninstall,
	but only when the backup provably matches the file agemon found (checksum check).
- A managed file you edited after agemon wrote it is never overwritten or deleted: agemon
	removes only its own block, or leaves the file as is, saves the earlier contents beside it
	as `<file>.agemon-original`, and prints `manual cleanup needed: …`.
- agemon writes files atomically, keeps their permissions, and refuses to write through a
	symlink, a special file or a read-only file. A symlinked rule file (for example
	`CLAUDE.md -> AGENTS.md`) is reported as a conflict and left alone.
- A failed apply rolls back every file it touched; anything it could not restore is listed,
	and the apply's journal is kept so `agemon recover` can retry.
- `.agemon/` content (plans, the ledger, backups) is treated as untrusted, because it may
	have been committed by someone else. `agemon apply --plan <id>` accepts only a valid
	16-character plan id, refuses a malformed plan or one made by another agemon version, and
	never touches a path outside the repository, inside `.git/`, or under a symlinked
	directory. It also plans again with this run's options (`--only`, `--skip-daemon`,
	`--skill-groups`, `agemon.toml`) and refuses unless the result is identical to the stored
	plan, so it applies exactly what you reviewed — never an edited preview, risk class or
	operation. Pass the same options you gave `agemon plan`. agemon refuses to use `.agemon/` (or any directory in it) when it is a symlink.
- `inspect`, `status` and `plan` never follow a symlinked or special file and never read a
	file larger than 8 MiB; such a file is reported as present but unread.

### Interrupted applies

Before an apply changes anything, agemon writes a journal with the pre-apply contents of
every file it will write and a copy of the ledger. The journal lives outside the
repository, in `${XDG_STATE_HOME:-~/.local/state}/agemon/journals/` (macOS:
`~/Library/Application Support/agemon/journals/`; directory mode `0700`,
file mode `0600`), so repository contents cannot forge one. It is deleted when the apply
succeeds or rolls back cleanly.

- **Ctrl-C, `SIGTERM` or `SIGHUP` during an apply:** agemon finishes the current step, rolls
	back, and exits `130`, `143` or `129`. Press Ctrl-C a second time to stop at once.
- **The process was killed or the machine lost power:** the journal stays behind. Every
	later `agemon`, `agemon apply` and `agemon nuke` in that repository refuses to start and
	points to `agemon recover`.
- **`agemon recover`** shows what it will restore, then asks (or proceeds with `--yes`;
	`--dry-run` only shows). It restores files the apply wrote, reverts what the apply
	recorded in the ledger, and restores the ledger. A file you edited after the interruption
	is kept as is, with agemon's ledger entry for it, and its pre-apply contents are saved
	beside it as `<file>.agemon-original`. A failed apply treats a file edited during the run
	the same way.
- **Limit:** work a capability had started but not yet recorded when the process died is not
	undone; check `agemon status` afterwards. Interrupted writes can leave
	`<file>.tmp-<pid>-<id>` files next to their targets; delete them if present.

## Managed Outputs

By default, agemon may manage these paths:

- `.agemon/state.json`
- `.agemon/backups/*.bak`
- `<rule file>.agemon-original` (only when an edited file is preserved on uninstall)
- `AGENTS.md`
- `CLAUDE.md`
- `GEMINI.md`
- `.cursorrules`
- `.windsurfrules`
- `.claude/agents/<name>.md` (the subagents of installed skill groups)
- `agemon.toml` (written on the first run; rewritten once when a capability is added)

It also invokes external installers (`pipx`, `npm -g`, the pinned `skills` CLI) when required.
Every third-party tool and source is pinned to an exact version or commit
(`src/plugins/pins.ts`, `assets/tools/package-lock.json`). agnix is installed with
`npm install --global --ignore-scripts agnix@<pin>`, so its own download script never runs;
agemon then downloads the binary from the matching GitHub release itself and installs it only
if the archive matches a sha256 pinned in `src/plugins/pins.ts`.

Machine-level caches outside the repo, under `${XDG_STATE_HOME:-~/.local/state}/agemon/`
(macOS: `~/Library/Application Support/agemon/`), are
kept by `nuke` because every repo on the machine shares them:

- `tools/<hash>/`: the `skills` CLI, installed from `assets/tools/package-lock.json`
- `skills-src/<commit>/`: the pinned Essentials checkout that `skills add` installs from
- `machine.json`: which repositories use code-review-graph, agnix and user linger, and who
  installed or enabled them

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
- `--skill-groups <ids>`: pass skill groups through to the install run.

## Detailed Docs

- Architecture and operations: `docs/architecture-and-operations.md`
- Release process: `docs/releasing.md`
- Audit and review report: `docs/review-2026-08-13.md`
- Historical implementation plan: `docs/implementation-plan.md`

## Vendored Skills & Attribution

The `design`, `security`, `code-quality`, `architecture`, `self-review`, `performance`, `commit`,
`teamlead` and `geo-seo` skill groups (see [Skill Groups](#skill-groups)) are vendored under
`assets/skills/<group>/<skill>/`.
Each vendored skill directory carries a `NOTICE.md` (source repo, exact commit, retrieval date)
and a copy of its upstream `LICENSE`. Sources, all MIT-licensed:

Every skill vendored from a third-party project is renamed to an `agemon-*` identity (frontmatter
`name` and directory) — it should never be obvious from installing it that the content originated
elsewhere. Original upstream names are preserved only in each skill's `NOTICE.md`, for attribution.
The project-authored `team-lead` skills beyond `agemon-plan-rfc` and `prd-generator` have no
upstream to rename from and keep their original `skill-*` names — see the table below.
The `geo-seo` group is the one deliberate exception: its skills keep their upstream `geo-*` names
so `/geo audit` and the other commands match the upstream project's documentation.

| Renamed to | Originally | Source |
|---|---|---|
| `agemon-design`, `agemon-design-minimal`, `agemon-design-editorial`, `agemon-design-dashboard` | `ui-craft` + 3 recipe variants | [educlopez/ui-craft](https://github.com/educlopez/ui-craft) |
| `agemon-security` | `security-review` (also avoids colliding with Claude Code's own built-in skill of the same name) | [Dilaz/security-review-skill](https://github.com/Dilaz/security-review-skill) |
| `agemon-architecture` | `clean-architecture` | [nathankim0/clean-architecture-skills](https://github.com/nathankim0/clean-architecture-skills) |
| `agemon-verify-before-done`, `agemon-review-intake`, `agemon-review-request`, `agemon-root-cause` | `verification-before-completion`, `receiving-code-review`, `requesting-code-review`, `systematic-debugging` | [obra/superpowers](https://github.com/obra/superpowers) (cherry-picked; not a full vendor of that framework) |
| `agemon-clean-code` | `karpathy-guidelines` | [swarmclawai/andrej-karpathy-skills](https://github.com/swarmclawai/andrej-karpathy-skills) |
| `agemon-house-rules`, `agemon-performance`, `agemon-commit`, `agemon-plan-rfc`, `prd-generator`, `skill-headofit-audit`, `skill-incident-rca`, `skill-meeting-lifecycle`, `skill-obsidian-vault-sync`, `skill-prd-decomposer`, `skill-sec-check`, `skill-task-extractor`, `skill-techlead-reviewer`, `skill-tech-spike` | — | Original — authored for this project, `agemon-house-rules` distilled from this repo's own `AGENTS.md`. The `team-lead` skills beyond `agemon-plan-rfc` and `prd-generator` keep their original `skill-*` names rather than the `agemon-*` convention. |

`ui-craft`'s own reference files (33 files under `agemon-design/references/`) still mention
"ui-craft" by name in prose in a few places — they document that project's own separate CLI/MCP
tooling (`ui-craft-detect`, the `ui-craft` MCP server's `route_task`), which genuinely still goes
by that name and isn't part of what agemon ships. Rewriting 33 files of someone else's authored
guidance to scrub every mention was judged higher-risk than leaving a few internal citations
intact; the skill's own identity (what gets installed, listed, and invoked) is fully renamed.

`geo-seo` is vendored from [zubair-trabzada/geo-seo-claude](https://github.com/zubair-trabzada/geo-seo-claude)
(MIT, commit `989cae0`). It ships 12 of upstream's skills; the self-updater, the Python scripts,
the CRM/proposal skills and the examples are left out. These skills read untrusted website
content, so agemon's copy changes them in ways each skill's `NOTICE.md` lists in full:

- no skill pre-approves any tool, so every web fetch to a new domain, file write and shell
  command asks for your approval;
- every skill and subagent brief starts with an untrusted-content rule;
- the five audit subagents are installed as project agents (`geo-audit-*`, see
  [Subagents](#subagents)) whose system prompt is the brief in `geo-audit/references/`,
  with only the tools they need; without them, `geo-audit` falls back to general-purpose
  subagents given the same briefs;
- raw HTML and headers come from one fixed, read-only `curl` command that you approve per run;
- the PDF step builds its cover from checked values in a metadata file, runs pandoc sandboxed
  with raw HTML off, and prints with a sandboxed Chrome under a strict Content-Security-Policy.

If you installed upstream geo-seo-claude as personal skills (`~/.claude/skills/geo*`), run its
`uninstall.sh` first: Claude Code prefers personal skills over project skills of the same name,
so `/geo` would otherwise run that copy. `geo-report-pdf` needs pandoc 3.0+ and Chrome or
Chromium.

## Roadmap Notes

Shipped:

- Read-only agent detection (`agemon inspect`'s "Agents" section, `--check-agents-usable`)
  for Claude Code, Gemini CLI, and Copilot. Delegating work to a detected agent is not yet
  built.

Planned but not currently implemented:

- Dedicated `doctor` command.
- Native Windows support.
- Agent delegation (`agemon delegate`/`agemon handoff`).

## License

MIT

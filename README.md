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
- **Works with Claude.** Add agemon's skill groups to claude.ai or Claude Code as plugins, and
  check a repository is ready for Claude Code on the web. See [Use with Claude](#use-with-claude).

Want to help? Start with [CONTRIBUTING.md](CONTRIBUTING.md).

## What It Does

agemon is plugin-driven and runs its plugins in this order:

1. `crg`: installs and verifies `code-review-graph`.
2. `daemon`: registers `code-review-graph watch` autostart via `systemd --user` (Linux) or
   a launchd user agent (macOS), under a name derived from the repository's path — see
   [Daemon naming](#daemon-naming).
3. `skills`: installs bundled skills with a pinned copy of the `skills` CLI. Always installs the `essentials` group;
   additional groups (design, security, code quality, architecture, self-review, performance,
   commit, workflow, output style, founder, team lead, GEO) are selected interactively, via `--skill-groups`, or skipped entirely in a
   non-interactive session — see [Skill Groups](#skill-groups).
4. `agents`: installs a Haiku override of Claude Code's `Explore` agent, and the subagents that
   come with an installed skill group, into `.claude/agents/` — see [Subagents](#subagents). It
   depends on `skills`, so `--only agents` also runs `skills`.
5. `subagent-default`: behind consent, sets a default model in `.claude/settings.json` for
   Claude Code subagents that name none — see [Default subagent model](#default-subagent-model).
6. `delegation-guard`: opt-in, never installed by default. Hooks that, in a chat where you turn
   them on, cap searches in the main conversation and point Claude to `Explore` — see
   [How agemon routes subagents](docs/subagent-routing.md#opt-in-the-delegation-guard).
7. `cli-tool`: installs bundled global CLI tools.
8. `master-prompt`: consolidates agent rule files and pointer files.

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
| `essentials` (always on) | `web-design-guidelines`, `writing-guidelines` | Vercel Labs' web design and writing review guidelines, vendored as copies taken at one pinned upstream commit each. They keep their upstream names — see [Vendored Skills](#vendored-skills--attribution). |
| `design` | `agemon-design` | A staged UI workflow: it picks a track, reads your real brand and tokens, builds from the product's subject, checks objective facts, and reports what it could not verify. Choosing among three directions is opt-in (`/agemon-design build --directions`) until an eval supports it as a default. Dashboard, editorial and minimal looks are presets it uses when you name them. Limits: auto-triggering cannot be guaranteed, its gates are voluntary without hooks, and a passing run does not mean a good design. |
| `security` | `agemon-security`, `agemon-security-audit` | Exploit-driven security review — no finding without a working proof-of-concept — plus a multi-agent, multi-phase codebase audit with independently verified findings. |
| `code-quality` | `agemon-clean-code`, `agemon-house-rules`, `agemon-unused-code-check` | Simplicity, DRY architecture, self-documenting naming, surgical scope control, unused-code checks with the project's own Knip. |
| `architecture` | `agemon-architecture` | Clean Architecture review: dependency rule, layering, boundary crossing, SOLID. |
| `self-review` | `agemon-verify-before-done`, `agemon-review-intake`, `agemon-review-request`, `agemon-root-cause` | Verification before claiming completion, giving/receiving code review, root-cause debugging. |
| `performance` | `agemon-performance` | Algorithmic-complexity-first discipline: N+1 detection, hot-loop hygiene, when not to optimize. |
| `commit` | `agemon-commit` | Staging review, commit message structure, and splitting unrelated changes into separate commits. |
| `nuxt-vue` | `agemon-vue`, `agemon-nuxt`, `agemon-nitro`, `agemon-pinia`, `agemon-vite`, `agemon-vitest`, `agemon-unocss` | Vue 3, Nuxt, Nitro, Pinia, Vite, Vitest and UnoCSS reference skills, generated from each project's own docs at a pinned commit; they describe the versions current then (Nuxt 5), so check them against your project's versions. |
| `browser-testing` | `agemon-webapp-testing` | Tests a local web app in a real browser with Python Playwright scripts: starts the dev server, inspects the rendered page, captures screenshots and console logs. Needs Python 3 and Playwright (see [Requirements](#requirements)); the agent runs Python and your server commands, so expect permission prompts. |
| `workflow` | `agemon-brainstorming`, `agemon-writing-plans`, `agemon-executing-plans`, `agemon-subagent-driven-development`, `agemon-test-driven-development`, `agemon-using-git-worktrees`, `agemon-dispatching-parallel-agents`, `agemon-finishing-a-development-branch` | Structured feature delivery: brainstorming, written plans, test-driven development, subagent or inline execution, git worktrees, and branch finishing. Comes with the `agemon-scout` and `agemon-worker` [subagents](#subagents). Pairs with `self-review`. |
| `output-style` | `agemon-adhd` | On request (`/agemon-adhd`), replies lead with the next action, number their steps, restate progress, and skip preamble and tangents. |
| `founder` | `agemon-founder-board`, `agemon-founder-competitors`, `agemon-founder-consumer`, `agemon-founder-pricing`, `agemon-founder-offer`, `agemon-founder-cfo`, `agemon-founder-marketing`, `agemon-founder-brand`, `agemon-founder-ops`, `agemon-founder-launch`, `agemon-founder-plan` | Test a business idea before launch: board review, competitors, simulated buyer panel, pricing, offer, unit economics, marketing, brand, operations, launch, and a business plan with a computed verdict. The panel is simulated buyers, not customers. The scripts need Python 3.8 or newer. |
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
source. Groups you were shown and did not pick are recorded as declined once you approve
the install gate. Ctrl-C at the question leaves the repository untouched.

Re-running `agemon` in a repo only re-verifies the groups that repo already selected — it never
asks you about, or installs, groups you previously declined, even when `--skill-groups` or
`skill_groups` names them; `agemon add <group>` installs one. A group added later (to agemon or
to `agemon.toml`) is installed when `--skill-groups` or `skill_groups` names it; otherwise it is
offered once in an interactive run. A `--yes` or non-interactive run leaves it waiting and lists
it. See [What a new version brings to a repository](#what-a-new-version-brings-to-a-repository).

#### Subagents

The `agents` capability installs Claude Code subagents into the project's `.claude/agents/`.
One comes with every install:

- `Explore` (`.claude/agents/explore.md`): a Haiku override of Claude Code's built-in search
  agent, which otherwise runs on the Opus alias for subscription users. It needs no skill group.
  If another agent file already declares `name: Explore`, agemon leaves it alone and says so.

Two groups add their own, installed together with the group:

- `geo-seo`: the five audit agents `geo-audit-ai-visibility`, `geo-audit-platform`,
  `geo-audit-technical`, `geo-audit-content` and `geo-audit-schema`, which `/geo audit`
  launches in parallel.
- `workflow`: two role agents. `agemon-scout` runs on Haiku for read-only search, and
  `agemon-worker` runs on Sonnet for routine implementation and review.

[How agemon routes subagents](docs/subagent-routing.md) shows the files and when routing helps.

How they are set up:

- Each agent file has only `name`, `description`, `tools` and `model`, plus `effort` and
  `maxTurns` for `Explore` and the workflow role agents. `tools` is an allowlist. The GEO agents get `WebFetch`, plus `Bash` (for one fixed, read-only `curl` you
  approve per run) for the technical and schema agents. `agemon-scout` gets `Read`, `Grep` and
  `Glob`. `agemon-worker` also gets `Edit`, `Write` and `Bash`. Nothing is pre-approved, and no
  agent sets a permission mode, hooks or MCP servers.
- `model` is an alias, so agents follow new model releases. These agent files are written for
  Claude Code, and only Claude Code has been tested with them.
- The agents have their own consent step, which names every agent with its tools. With
  `--yes`, agemon prints that list instead of asking.
- Agent files are handled like rule files: an agent you edited is a conflict and is never
  overwritten without a decision (`[conflict_decisions] "agent-file:<name>" = "keep"`,
  `"replace"` or `"skip"`); a replaced file is backed up first; `nuke` removes the agents
  agemon created and restores the files it replaced.
- A group's agents are written only when the group is installed; if you decline the group,
  its agents are skipped.
- `agemon status` shows one row per agent: managed, adopted (identical but not written by
  agemon on this machine), changed (your edit, kept), absent, or not a regular file. It
  needs attention (exit 2) when agemon has a newer version of an agent you didn't change,
  or when another file in `.claude/agents/` declares the same `name:` as one of agemon's
  agents — Claude Code identifies agents by that name and may load the other file instead.
- Claude Code picks up a new `.claude/agents/` directory in sessions started after it exists.

#### Default subagent model

The `subagent-default` capability sets one key in `.claude/settings.json`. It shows you the diff and
asks first; with `--yes` it prints the diff and goes ahead:

```json
{ "env": { "CLAUDE_CODE_SUBAGENT_MODEL": "sonnet" } }
```

- **What it does.** A Claude Code subagent runs on the first of these that is set: the model named
  in the call, the agent file's `model`, this variable, the session's model. So this only changes
  subagents that would otherwise inherit the session's model. Pinned agents such as `agemon-scout`
  keep their model. The built-in `Explore` and `Plan` agents aren't affected. It applies to Claude
  Code only.
- **It can raise your cost.** In a Haiku session it moves those subagents up to Sonnet. In one test,
  a one-word subagent reply in a Haiku session cost $0.116 at list prices, $0.107 of it on Sonnet.
- **There is no measured saving yet.** agemon's routing eval started no subagents, so it didn't
  test this setting (see `evals/routing/README.md`). Use `agemon usage` to judge it from your own
  sessions.
- **It is shared with your team,** because the file is usually committed. agemon checks the Claude
  Code version only on the machine that runs it, and it writes nothing if that version is older
  than 2.1.251 or can't be read. On older versions this variable overrides pinned models, so an
  Opus review would silently run on Sonnet. Anyone on your team using an older version gets that
  behaviour from the committed file, so have them update first.
- **To change the tier,** edit the value in `.claude/settings.json`. agemon treats any other value
  as yours: it never overwrites it, `agemon status` shows it as changed, and `nuke` leaves it.
- **`nuke` removes the key** only if it still has the value agemon wrote, and deletes `env` if that
  leaves it empty. Everything else in the file stays byte for byte, except that an `"env": {}` you
  already had goes too, and an empty top-level object loses any whitespace inside it. agemon deletes the file only if agemon created it and nothing else is left.
- If the file isn't valid JSON or clean UTF-8, or is a symlink, agemon says so and leaves it alone. An existing
  repository is offered this capability once, like any new one; `--yes` alone doesn't add it there.

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

`agemon-design-minimal`, `agemon-design-editorial` and `agemon-design-dashboard` are retired; their
looks are now presets of `agemon-design`, used when you name one. Running `agemon` offers to remove
an unmodified copy behind consent. An edited copy is never touched, and `agemon status` reports it.

#### Project-defined skill groups

A project can define its own groups in `agemon.toml`. The first run writes that file; if you
create it by hand, `capabilities` is required:

```toml
capabilities = ["skills"]
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
- agemon does not reinstall a skill when its local source changes. `agemon status` reports an
  installed copy that no longer matches its source, or a source agemon can no longer read, and
  needs attention (exit 2) until they match. To install the new version, delete
  `.claude/skills/<name>` and run `agemon`.

A custom group is installed only when you pick it in the interactive question or name it in
`--skill-groups` or `skill_groups`; `--yes` and `--skill-groups all` cover agemon's own groups
only. Custom groups get their own consent gate, which always prints every source (the local
content hash, or the GitHub repository and commit), even under `--yes`. A custom skill is
instructions for your agent from whoever wrote the repository's `agemon.toml`: review it like
code. A commit sha pins content, not origin — GitHub serves a commit from any fork under the
original repository's URL, so check the commit itself, not just the repository name.

Every bundled skill is vendored into agemon's own repo under `assets/skills/`, rather than fetched at
bootstrap time (custom GitHub groups you add yourself are still fetched) — so installs don't depend on GitHub being reachable and won't drift if an
upstream repo changes. Vendored skills
sourced from a third-party project are renamed under an `agemon-*` identity so they read as
agemon's own; the `team-lead` skills beyond `agemon-plan-rfc` and `prd-generator` are original to
this project and keep their `skill-*` names, while `geo-seo` and `essentials` keep their upstream
names. See [Vendored Skills](#vendored-skills--attribution) for sources and licenses.

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

## Other coding agents

Skills install into `.claude/skills/`, which Claude Code, Cursor, Copilot and OpenCode read. Codex,
Gemini CLI, Antigravity and Devin read `.agents/skills/` instead. When agemon finds one of those
four (the executable on `PATH`, or a `.codex`, `.gemini` or `.devin` folder in the repository), it
offers to copy skills there too:

- **You decide once.** `agemon` asks, and remembers a no; `agemon --skill-groups <group>` asks
  again. `--yes` means yes unless you already said no. A run with neither a prompt nor `--yes`
  adds nothing, and `agemon status` says copies are available.
- **agemon owns only what it wrote.** It records each copy's path and hash. `agemon` updates and
  `agemon nuke` touch a copy only if its hash still matches that record.
- **Your copies stay yours.** A team's `.agents/skills/<name>`, or one you changed, is reported in
  `agemon status` and is never overwritten or deleted.
- **The copy differs slightly.** Keys outside the [Agent Skills standard](https://agentskills.io/specification)
  move into `metadata`, because other agents reject them or read them differently.
- **`agemon-adhd` is not copied.** It must run only when named, and not every agent honours the
  flag that says so.

| Agent | Run a skill by name |
|---|---|
| Claude Code, Cursor, Antigravity, Devin | `/agemon-design` |
| Codex | `$agemon-design` |
| Gemini CLI, Copilot, OpenCode | Ask in plain words, for example "use the agemon-design skill" |

**What is promised:** agemon puts skills in a folder that agent's docs say it reads, and the table
above gives by-name use where that agent's docs show it; for Gemini CLI, Copilot and OpenCode the
syntax is not confirmed, so plain words are the suggestion, not a tested path. **What is not:** that every agent loads a skill
on its own. Only Claude Code has been measured, and only Claude Code has been run. Cursor, Copilot
and OpenCode read both folders, so they may list a skill twice once copies exist. See the
[agent matrix](evals/design/agent-matrix.md), which leaves its gaps visible.

## Requirements

- To install, apply or nuke: Ubuntu, Debian, a derivative whose `/etc/os-release`
  `ID_LIKE` lists `ubuntu` or `debian` (Linux Mint, Pop!_OS, …), or macOS 11 or later.
  On macOS, run agemon as your own user: it refuses to run as root there, because
  everything it installs belongs to one user. `inspect`, `status` and `plan` are
  read-only and run on any OS with Node.js.
- The `cli-tool` capability installs agnix and gitleaks. agnix has pinned builds for
  Linux x64, Linux arm64 and Apple Silicon Macs; gitleaks also has one for Intel Macs.
  agemon offers each tool only where it has a build and names the ones it skips (on an
  Intel Mac, or x64 Node under Rosetta, that is agnix). Where neither has a build (other
  Linux architectures) agemon skips `cli-tool` and says so; `agemon.toml` keeps it.
- Without pipx, install it first: `sudo apt install pipx`, or on macOS
  `brew install pipx` with Homebrew's bin directory on `PATH`.
- The daemon needs systemd on Linux, or launchd on macOS. Without systemd (most
  containers, WSL without systemd), agemon skips the daemon and says so; `agemon.toml`
  still lists it for machines that have systemd.
- Node.js `>=22.12` (used to run the installed CLI; no other Node tooling needed).
- browser-testing group: Python 3 and the Playwright package with its browsers (pip install playwright && playwright install chromium); agemon does not install them.
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

## Upgrading agemon

Check which version you have:

```bash
agemon --version
```

Upgrade to the latest release:

```bash
agemon upgrade
```

Install a specific version, or go back to one. agemon asks before a downgrade:

```bash
agemon upgrade 6.0.0
```

Switch back to the install the last upgrade replaced. This works for install-script installs
only; for an npm install, install the previous version by name as above:

```bash
agemon upgrade --rollback
```

To run one version once without installing it, use `npx agemon@6.0.0`.

- **Use `agemon upgrade`, not `npm update -g`.** Once agemon has upgraded itself, npm records the
  install as coming from a local file.
- **Then run `agemon` in each repository.** Upgrading replaces the program and changes no
  repository. The next run shows what the new version brings, as described below.
- **To stay on a version,** set `AGEMON_NO_UPDATE_CHECK=1` to turn off the daily update prompt
  (see [Update checks](#update-checks)).

To decide whether to upgrade, read the [changelog](CHANGELOG.md): it lists what each release
changed. For example, 6.1.0 added the Claude plugin marketplace (see [Use with Claude](#use-with-claude)),
`agemon add` and `agemon usage`.

### How each install method upgrades

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

After an upgrade, agemon prints the link to the release notes and reminds you to run
`agemon` in each repository: upgrading replaces the program and changes no repository.

### What a new version brings to a repository

Added in 6.1.0. The next `agemon` run in a repository shows or asks about everything it could use but does not
have yet. Only skill groups and capabilities need a decision; an updated skill or subagent, or a
new skill in a group you already installed, appears at the usual consent step.

- **New** means this repository has not decided yet: a skill group it was never offered, or a
  capability `known_capabilities` does not name and whose dependencies are listed.
- **Declined** means it decided against: a skill group you did not pick, or a capability in
  `known_capabilities` that `capabilities` leaves out.

| Run | New | Declined |
|---|---|---|
| `agemon` or `agemon apply` in a terminal | Asks once | One-line reminder |
| With `--yes` or without a terminal | Lists it and leaves it waiting | One-line reminder |
| `agemon --dry-run`, `agemon plan` | Lists it | One-line reminder |
| `agemon status` | Listed under "Available" | Listed under "Available" |
| `--quiet` | Nothing | Nothing |

```text
New: skill group 'security', capability 'agents'. Run 'agemon' to choose.
Declined: skill group 'seo'. Run 'agemon add <name>' to install.
```

Neither changes the exit code, so a new release doesn't fail a CI job that runs `agemon status`.
A first install doesn't print the reminder, because you just made those choices.

Install anything listed with `agemon add`:

```bash
agemon add security agents
```

`add` takes skill group and capability names and shows the usual consent step. It changes
nothing else in the repository, apart from installing subagents for a group when `agents` is
on, and bringing skills up to date when it adds a group. A decline is cleared only after the
install succeeds. A capability
is added to `capabilities` in `agemon.toml` (see [`agemon.toml`](#agemontoml)) unless you refuse
it. It refuses a capability or group whose dependency is not enabled, and a repository with no
`agemon.toml`; run `agemon` there first.

Skill group declines are kept per clone in `.agemon/`, so a teammate is still asked. Capability
choices are in the committed `agemon.toml`, so they apply to the whole team.

### Update checks

`agemon`, `agemon apply` and `agemon nuke` check once a day whether a newer GitHub Release
exists. The check never slows a command down:

- the lookup starts in the background when the command starts, and its result is shown
  only **after** the command has finished and exited successfully. If the lookup has not
  finished by then, it is cancelled and tried again on a later run;
- in an interactive terminal (without `--yes`), for an install-script or npm install,
  agemon then asks whether to install the update. On yes, it upgrades exactly as
  `agemon upgrade` would (see [How each install method upgrades](#how-each-install-method-upgrades)).
  Nothing runs if a check fails;
- with `--yes`, without a terminal, or for any other install method, it prints a one-line
  notice with the command to run instead of asking. A release candidate is offered its
  final release; an older release is never offered.

There is no check at all for `inspect`, `status`, `plan` or `recover`, with `--dry-run` or
`--quiet`, when `CI` is set (to anything other than `0` or `false`), or when
`AGEMON_NO_UPDATE_CHECK=1` is set.

## Use with Claude

Yes, agemon works with Claude in three places, and each gets a different part of it:

- **Claude Code** on your machine (CLI or VS Code) gets everything when you run `agemon` in a
  repository. You can also add skill groups as plugins without running agemon.
- **Claude Code on the web** gets what you commit: run `agemon`, commit and push.
- **claude.ai** gets the skills, as plugins from agemon's marketplace.

| agemon installs | Claude Code | Claude Code on the web | claude.ai chat |
|---|---|---|---|
| Rules (`AGENTS.md`, `CLAUDE.md`) | Yes | Yes, once committed | No |
| Skills | Yes, or as plugins | Yes, once committed | Yes, as plugins |
| Subagents | Yes | Yes, once committed | No |
| Hooks and `.mcp.json` | Yes | Yes, once committed; the tools they run need installing | No |
| `code-review-graph` | Yes | Through a setup script | No |
| Daemon and global CLI tools | Yes, where systemd or launchd runs | No | No |

The plugin marketplace was added in agemon 6.1.0, but it doesn't need agemon installed at all.
See [Plugins vs. an agemon install](#plugins-vs-an-agemon-install).

In Claude Code, agemon also runs read-heavy subagent work on Haiku: it installs an `Explore`
override and role agents with pinned models, and `agemon usage` shows what each subagent type
cost and which model it ran on. See [How agemon routes subagents](docs/subagent-routing.md).

### claude.ai

1. In claude.ai, open **Customize** > **Plugins**.
2. Select **Add** > **Add marketplace** > **Add from a repository**.
3. Enter `Korak-997/agemon`.
4. Add the groups you want, such as `agemon-security` or `agemon-design`.

### Claude Code

Add the marketplace once:

```bash
claude plugin marketplace add Korak-997/agemon
```

Install a group by its [plugin name](#plugin-names):

```bash
claude plugin install agemon-security@agemon
```

Claude Code doesn't auto-update third-party marketplaces by default. Turn on auto-update under
`/plugin`, or refresh the marketplace and update the plugin yourself:

```bash
claude plugin marketplace update agemon
```

```bash
claude plugin update agemon-security@agemon
```

Remove one plugin:

```bash
claude plugin uninstall agemon-security@agemon
```

Or remove the marketplace together with every plugin you installed from it:

```bash
claude plugin marketplace remove agemon
```

### Claude Code on the web

The `agemon` CLI runs on your machine, so it can't install into a cloud session directly. A
cloud session clones your repository and reads its agent config, so run `agemon`, commit the
result and push it. It doesn't read `~/.claude`.

`agemon inspect` (6.1.0 and later) has a **Claude on the web** section that lists:

- agent config that is uncommitted or gitignored
- commits changing agent config that aren't pushed yet
- a setup script, if your hooks or MCP servers run `code-review-graph` directly

To use the setup script, open [claude.ai/code](https://claude.ai/code), select the
environment under the message box, open its settings, and paste the script into **Setup
script**. It installs the pinned version of `code-review-graph`, but unlike a local agemon
install, its dependencies are not hash-locked.

Cloud sessions in a project's threads are different: they don't use the repository's
`.claude/skills/` or run its hooks. They use the skills enabled on your claude.ai account.

### Plugin names

Each skill group is a plugin named `agemon-<group id>`, listed in
[`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json). Install one in Claude
Code with `claude plugin install agemon-<group id>@agemon`.

### Plugins vs. an agemon install

- **Any agemon version works, or none.** The marketplace doesn't depend on the agemon you have
  installed. You can stay on 6.0.0 and still add the plugins: they follow this repository's
  default branch, not your CLI or a release.
- **No agemon safety net.** Claude manages plugins, so there is no agemon plan, diff, rollback
  or `nuke`, and `agemon status` doesn't see them. Remove them where you added them.
- **Prefixed names.** A skill is named `<plugin>:<skill>`, such as
  `agemon-security:agemon-security`. In a repository that also has an `agemon` install, you
  would see both copies, so use one or the other there.
- **Skills and commands only in chat.** Subagents and hooks don't run there, and local tools
  can't. `geo-audit` expects subagents, so use it in Claude Code rather than chat.

### Troubleshooting the plugins

- **I don't see the plugins.** Check that you added the `Korak-997/agemon` marketplace and the
  group's plugin.
- **Claude doesn't use a skill on its own.** Claude picks a skill from its description, and that
  isn't guaranteed. Name it instead, such as `/agemon-security:agemon-security`.
- **I see every skill twice.** The repository has an `agemon` install and you added the plugin
  too. Use one of them in that repository.

## CLI Usage

`install` is the default command:

```bash
agemon [options]
```

Install a capability or skill group the repository doesn't have yet (see
[What a new version brings to a repository](#what-a-new-version-brings-to-a-repository)):

```bash
agemon add <names...> [--yes]
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
- gitleaks is shared the same way. agemon installs it under `~/.local/share/agemon-tools`
  and links it as `~/.local/bin/gitleaks` (`/usr/local/lib/agemon-tools` and
  `/usr/local/bin` as root). An existing `gitleaks` at that link path is never replaced
  or removed: agemon uses it if it runs and refuses otherwise. `nuke` removes only the
  link and directory agemon created.
- skills: `nuke` removes `.claude/skills/<name>` itself, without the skills CLI and
  without network access, and only when its content is a version agemon installed; an
  edited copy is kept and named. A custom group's skill counts as installed by agemon
  only if it matched its source at install time, which agemon recorded then; a copy with
  no such record is kept and named. In `.agents/skills/<name>`, it removes only a copy agemon
  recorded writing whose hash is unchanged; a changed copy is kept and named, and a copy agemon
  did not write is never touched. It removes only agemon's skills from `skills-lock.json`.
- `.gitignore` and directories: every `nuke` removes the `.claude`, `.claude/skills`,
  `.claude/agents`, `.agents` and `.agents/skills` directories agemon created once they are empty (never their contents).
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

### Checking what subagent models saved (`agemon usage`)

```bash
agemon usage [--since 30d] [--json]
```

`agemon usage` estimates what running subagents on cheaper models saved in this repository. There
is nothing to turn on: it reads the sessions Claude Code already saves under
`~/.claude/projects/` (or `CLAUDE_CONFIG_DIR`). It only reports on Claude Code, and it does not
call any model.

For each session it adds up what every response cost, then prices the subagents' same tokens at
the session's own model. The difference is the estimated saving. It also shows how many sessions
used subagents, how many subagent calls ran cheaper than the session's model, and how the cost
splits between the main session and its subagents. For each subagent type it lists the models it
ran on, its cost and its saving. If any `Explore` call ran on Opus or Fable, it says so and tells you to run `agemon`.

- **It is an estimate, not a bill.** It uses API list prices, so on a subscription a saving means
  less of your usage limit spent, not less money paid. It assumes standard speed and global routing.
  On this project's own sessions, its totals came within 2% of the CLI's figures.
- **It doesn't compare against doing the work inline.** That would use different tokens: no subagent
  startup cost, but a longer main conversation. It also can't tell whether the cheaper work was good
  enough, so note when you have to redo a subagent's work.
- **`--since` counts whole sessions.** A session active inside the window counts in full.
- **Models without a known price** are left out and counted in the report. Prices are built in, so
  check them after a price change.
- **Run it at least monthly.** Each run saves its numbers, so they outlive Claude Code deleting old
  transcripts. Only sessions still on disk at a run are captured. Sessions from another worktree are
  a separate project: run it there too.

The history is `usage/<repo key>.json` in agemon's state directory, readable only by you. It holds
numbers, models and agent type names, never prompts, code or task descriptions. `nuke` keeps it, and
`agemon self-uninstall` removes it with the rest of the machine state.

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
capabilities = ["crg", "daemon", "skills", "agents", "subagent-default", "cli-tool", "master-prompt"]
known_capabilities = ["crg", "daemon", "skills", "agents", "subagent-default", "cli-tool", "master-prompt"]
skill_groups = "essentials,security"   # optional

[custom_skill_groups.house-style]      # optional — see Project-defined skill groups
label = "House style"
skills = [{ source = "./tools/skills/house-rules" }]

[conflict_decisions]                   # optional
"rule-file:CLAUDE.md" = "keep"         # keep | replace | skip
```

`known_capabilities` lists the capabilities the agemon that wrote the file knew about. A
capability a later release adds is new to the file: an interactive `agemon` or `agemon apply`
asks about it once, when everything it depends on is listed. What you pick is installed and added to
`capabilities`, and everything agemon knows goes into `known_capabilities`, so what you
did not pick becomes a declined reminder instead of another question. `agemon add <name>`
installs a capability the same way, and `--yes` never decides for you.

Recording this rewrites `agemon.toml`. All values are kept, but comments and layout are not; if
anything like that would be lost, the original is saved under `.agemon/backups/` and the message
names the file. Each such rewrite keeps its own saved original; a later one never overwrites an
earlier one. It never happens with `--dry-run`, `--only` or `agemon plan`, or after a rollback. To
opt out later, remove the capability from `capabilities`; because it is in `known_capabilities`,
agemon does not ask again. The opt-in `delegation-guard` capability is left out of both lists
when the file is first written, so the next interactive run offers it once; see
[How agemon routes subagents](docs/subagent-routing.md#opt-in-the-delegation-guard). Older agemon releases reject a file with `known_capabilities` or
`agents`, so upgrade agemon in CI before committing it. The rewrite is skipped while `/.agemon/` is
not git-ignored, and a full `agemon nuke` deletes `.agemon/`, including that saved original.

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

`agemon inspect` also reports what stops a repository working with Claude Code on the web,
under `cloud` in the JSON report. See [Use with Claude](#use-with-claude).

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
- `env.CLAUDE_CODE_SUBAGENT_MODEL` in `.claude/settings.json` (only this key; see
  [Default subagent model](#default-subagent-model))
- `agemon.toml` (written on the first run; rewritten once when a capability is added)

It also invokes external installers (`pipx`, `npm -g`, the pinned `skills` CLI) when required.
Every third-party tool is pinned to an exact version
(`src/plugins/pins.ts`, `assets/tools/package-lock.json`), and every vendored skill records the
upstream commit it was copied from in its `NOTICE.md`. agnix is installed with
`npm install --global --ignore-scripts agnix@<pin>`, so its own download script never runs;
agemon then downloads the binary from the matching GitHub release itself and installs it only
if the archive matches a sha256 pinned in `src/plugins/pins.ts`. gitleaks comes straight from
its GitHub release archive, checked against a sha256 pinned there too.

Machine-level caches outside the repo, under `${XDG_STATE_HOME:-~/.local/state}/agemon/`
(macOS: `~/Library/Application Support/agemon/`), are
kept by `nuke` because every repo on the machine shares them:

- `tools/<hash>/`: the `skills` CLI, installed from `assets/tools/package-lock.json`
- `skills-src/<commit>/`: the pinned checkout of a custom skill group's GitHub source that `skills add` installs from
- `usage/<repo key>.json`: the numbers `agemon usage` has saved for a repository
- `machine.json`: which repositories use code-review-graph, agnix, gitleaks and user linger, and who
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

The `essentials`, `design`, `security`, `code-quality`, `architecture`, `self-review`, `performance`, `commit`, `nuxt-vue`, `browser-testing`,
`workflow`, `output-style`, `founder`, `teamlead` and `geo-seo` skill groups (see [Skill Groups](#skill-groups)) are vendored under
`assets/skills/<group>/<skill>/`.
Each vendored skill directory carries a `NOTICE.md` (source repo, exact commit, retrieval date)
and a copy of its upstream `LICENSE`. Sources, MIT-licensed except where noted. Some `agemon-design` text is Apache-2.0: `references/tells-2026-11.md` and the plan-and-review steps of `references/stage-build.md` are adapted from Anthropic's `frontend-design` skill (https://github.com/anthropics/skills), with the licence text in `references/third-party-licenses.md`:

Every skill vendored from a third-party project is renamed to an `agemon-*` identity (frontmatter
`name` and directory) — it should never be obvious from installing it that the content originated
elsewhere. Original upstream names are preserved only in each skill's `NOTICE.md`, for attribution.
The project-authored `team-lead` skills beyond `agemon-plan-rfc` and `prd-generator` have no
upstream to rename from and keep their original `skill-*` names — see the table below.
The `geo-seo` group keeps its upstream `geo-*` names so `/geo audit` and the other commands match
the upstream project's documentation. The `essentials` group keeps its upstream names too, so repositories
that already have those skills recognise them and can update them.

| Renamed to | Originally | Source |
|---|---|---|
| `agemon-design` | `ui-craft` + 3 recipe variants, now presets (open fork; see its `NOTICE.md`) | [educlopez/ui-craft](https://github.com/educlopez/ui-craft) |
| `agemon-security` | `security-review` (also avoids colliding with Claude Code's own built-in skill of the same name) | [Dilaz/security-review-skill](https://github.com/Dilaz/security-review-skill) |
| `agemon-security-audit` | `security-audit` | [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill) |
| `agemon-brainstorming`, `agemon-writing-plans`, `agemon-executing-plans`, `agemon-subagent-driven-development`, `agemon-test-driven-development`, `agemon-using-git-worktrees`, `agemon-dispatching-parallel-agents`, `agemon-finishing-a-development-branch` | the same names without `agemon-` | [obra/superpowers](https://github.com/obra/superpowers) |
| `web-design-guidelines` | `command.md` of `web-interface-guidelines`, with a wrapper that reads it instead of fetching it | [vercel-labs/web-interface-guidelines](https://github.com/vercel-labs/web-interface-guidelines) |
| `writing-guidelines` | `command.md` of `writing-guidelines`, with a wrapper that reads it instead of fetching it | [vercel-labs/writing-guidelines](https://github.com/vercel-labs/writing-guidelines) |
| `agemon-adhd` | `i-have-adhd` | [ayghri/i-have-adhd](https://github.com/ayghri/i-have-adhd) |
| `agemon-founder-board` and the other `agemon-founder-*` skills | `founder-board` and the other `founder-*` skills | [Jakeschincariol/founder-skill](https://github.com/Jakeschincariol/founder-skill) |
| `agemon-architecture` | `clean-architecture` | [nathankim0/clean-architecture-skills](https://github.com/nathankim0/clean-architecture-skills) |
| `agemon-verify-before-done`, `agemon-review-intake`, `agemon-review-request`, `agemon-root-cause` | `verification-before-completion`, `receiving-code-review`, `requesting-code-review`, `systematic-debugging` | [obra/superpowers](https://github.com/obra/superpowers) (cherry-picked; not a full vendor of that framework) |
| `agemon-vue`, `agemon-nuxt`, `agemon-nitro`, `agemon-pinia`, `agemon-vite`, `agemon-vitest`, `agemon-unocss` | the same names without `agemon-` | [antfu/skills](https://github.com/antfu/skills) (generated from each project's docs; the Vue docs are CC-BY-4.0) |
| `agemon-webapp-testing` | `webapp-testing` | [anthropics/skills](https://github.com/anthropics/skills) (Apache-2.0) |
| `agemon-clean-code` | `karpathy-guidelines` | [swarmclawai/andrej-karpathy-skills](https://github.com/swarmclawai/andrej-karpathy-skills) |
| `agemon-house-rules`, `agemon-unused-code-check`, `agemon-performance`, `agemon-commit`, `agemon-plan-rfc`, `prd-generator`, `skill-headofit-audit`, `skill-incident-rca`, `skill-meeting-lifecycle`, `skill-obsidian-vault-sync`, `skill-prd-decomposer`, `skill-sec-check`, `skill-task-extractor`, `skill-techlead-reviewer`, `skill-tech-spike` | — | Original — authored for this project, `agemon-house-rules` distilled from this repo's own `AGENTS.md`. The `team-lead` skills beyond `agemon-plan-rfc` and `prd-generator` keep their original `skill-*` names rather than the `agemon-*` convention. |

`agemon-design`'s reference files still say "ui-craft" in two places: an older project's
`.ui-craft/` directory, which the skill reads but never rewrites (new files go in `.design/`), and
a few "clashes with ui-craft rules" headings in `references/stack.md`. Commands, tools and agents that agemon does not ship are
gone, and `npm run lint-skills` fails if one comes back in `agemon-design` or a link in the skill points at a missing
file; the skill's own identity (what gets installed, listed, and invoked) is fully renamed.

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

# agemon — Build Plan & Dry-Run Harness

**Status:** Ready to start Phase 0
**Input:** [`implementation-plan.md`](implementation-plan.md) (architecture/design — unchanged, still canonical for *what* to build)
**This document:** *how* to build it, in what order, and how to see every step actually working before moving to the next — nothing here overrides `implementation-plan.md`; it operationalizes it.

---

## 1. Review of `implementation-plan.md`

The architecture is sound and unusually well-specified for a pre-implementation doc: the plugin interface, manifest-driven reversibility, format-preserving patchers, and the service-manager abstraction all follow the same "single source of truth, never guess, never glob" discipline consistently. That discipline is worth preserving exactly as-is. Six gaps are worth closing *before* or *during* Phase 0 rather than discovering them mid-build:

1. **No dev-time verification loop exists until Phase 10.** Integration tests ("install → nuke → diff empty") are specified as the Phase 10 deliverable, but that means the first 9 phases are built without a fast way to *see* a plugin's effect on a filesystem. This document's main addition is making that loop exist from Phase 0 onward — every phase below has a "dry-run checkpoint" that reuses the same harness, so round-trip safety is a continuous property, not a gate discovered at the end.
2. **Two subprocess-heavy plugins have no fast inner loop.** `crg` (pipx install + build) and `skills`/`cli-tool` (`npx skills add`, `npm install -g`) are slow and network-dependent. Iterating on their logic shouldn't require a real pipx install every save. §2.4 below specifies a fake-subprocess mode for exactly this.
3. **The CI matrix assumption needs verifying, not assuming.** §10 of the architecture doc states CI "directly exercises the real systemd service-manager." GitHub Actions' `ubuntu-latest` runners don't have a logind user session by default (`systemctl --user` needs `XDG_RUNTIME_DIR` + a D-Bus user session, neither guaranteed present). This must be spiked and confirmed in Phase 4, with a documented fallback (e.g. `dbus-run-session`, or a scoped `sudo loginctl enable-linger` + session bring-up step) rather than discovered as a broken CI run.
4. **Two "confirm before implementation" items in §12 are blockers, not footnotes.** Node version floor and the lint/format tool choice gate `package.json` and `tsconfig.json` in Phase 0. They're resolved below in §3, Phase 0, before any scaffolding.
5. **Manifest write atomicity is asserted as a test target but not designed.** A process killed mid-write to `.agemon/state.json` must never leave it corrupt — `nuke`'s entire safety model depends on that file being trustworthy. Phase 1 must specify write-temp-then-rename (or equivalent) as part of the manifest module's design, not just verify it after the fact.
6. **This repo is already the reference output of the `master-prompt` plugin.** `AGENTS.md` here is the canonical rule file; `CLAUDE.md`/`.cursorrules`/`.windsurfrules`/`GEMINI.md` are already thin pointers into it. That's exactly the shape Phase 9 needs to produce against a *messy* target repo. Use this repo's own rule-file layout as the literal acceptance fixture for `master-prompt` — it removes all ambiguity about what "correct output" means for that plugin.

Everything else in the architecture doc is adopted as-is: repo layout, plugin interface, manifest schema, patcher block-delimiter format, trust/safety principles, and command surface.

---

## 2. The Dry-Run Harness

This is the mechanism the rest of the plan hangs off. It exists so that at any point during development you can run one command and *see*, concretely, whether a plugin does what you expect — without touching your real `$HOME`, your real systemd user units, or the real network.

### 2.1 Why the built-in `--dry-run` flag alone isn't enough

`Context.dryRun` (architecture §5.1) is a **product feature** — it makes agemon itself narrate "would install X" instead of installing it. It's necessary but not sufficient for development, because:
- It doesn't tell you whether the *real* mutation path is correct — only whether the narration path is.
- It gives you no isolated place to let the real mutation path run and inspect the result.

So the harness has two distinct jobs, and keeps them distinct:
- **Exercise `--dry-run`** against a fixture, to check the narration/messaging path.
- **Exercise a real run** against a disposable, isolated sandbox, to check the actual mutation path — then diff the result.

### 2.2 Sandbox: an isolated `$HOME` + fake repo per run

New script: `scripts/sandbox.ts`, driven by `npm run sandbox`. It never touches your real machine.

```
.sandbox/                       (gitignored — scratch space, recreated on demand)
  runs/<timestamp-or-label>/
    home/                       fake $HOME — systemd units, agemon config, etc. land here
    repo/                       fake cwd — a copy of one test/fixtures/* repo
```

Mechanics:
- Copies a chosen fixture from `test/fixtures/<name>/` into `.sandbox/runs/<label>/repo`.
- Invokes the CLI in-process via `tsx src/cli/index.ts` (no build step — instant iteration) with `HOME` and `cwd` overridden to the sandbox paths, and `AGEMON_FAKE_SUBPROCESS` / `AGEMON_FAKE_SERVICES` set per flags (§2.4).
- Never shells out to the *real* `systemctl`/`pipx`/`npx` unless explicitly asked to (`--real`).

```bash
npm run sandbox -- run clean-repo --dry-run          # narration path, no mutation at all
npm run sandbox -- run clean-repo                     # real mutation path, fully isolated
npm run sandbox -- run existing-claude-md --trace     # + raw subprocess output
npm run sandbox -- run clean-repo --real              # opt-in: real pipx/npx/systemctl calls
npm run sandbox -- roundtrip clean-repo               # install → nuke → assert byte-identical
npm run sandbox -- reset                              # wipe .sandbox/
```

### 2.3 Fixture repos — `test/fixtures/*`

Small, checked-in seed repos, one per scenario a plugin needs to branch on:

| Fixture | Exercises |
|---|---|
| `clean-repo/` | No `CLAUDE.md`/`AGENTS.md` at all — the pure happy path |
| `existing-claude-md/` | Hand-written `CLAUDE.md` with real content — patcher must add exactly one delimited block and touch nothing else |
| `preexisting-crg/` | `code-review-graph` already present before agemon runs — `preExisting: true` must block `uninstall` from removing it |
| `colliding-workflow/` | A `.github/workflows/` file that happens to share a name with a bundle entry — `workflow-scaffolder` must refuse to clobber it |
| `non-ubuntu/` | A fake `/etc/os-release` with `ID=fedora` (read via an injectable path in `platform/detect.ts`, never a hardcoded `/etc/os-release`) — must exit clean with the v2-deferred message |
| `messy-agent-rules/` | Modeled on what this repo looked like *before* its own AGENTS.md consolidation — the acceptance fixture for `master-prompt` (§1, point 6) |

Each fixture is a few files, not a real project — just enough structure for the plugin under test to branch on.

### 2.4 Fake backends for expensive or host-coupled operations

Two env-var-gated swaps, wired through the exact seams the architecture already defines (`ctx.run` and the `service-manager` interface) — no plugin code branches on "am I in dev mode," so production code paths stay identical to what ships:

- **`AGEMON_FAKE_SUBPROCESS=1`** — `core/subprocess-runner.ts` returns canned success output instead of shelling out to `pipx`/`npx`/`npm`. Used by default in `npm run sandbox` for anything other than `--real`. Every phase's exit criteria (§3) requires at least one `--real` run in addition to faked ones, so the fake is never the only evidence a plugin works.
- **`AGEMON_FAKE_SERVICES=1`** — swaps in `platform/service-manager/fake.ts`, which writes a marker file describing what unit *would* be registered/enabled instead of calling `systemctl`/`loginctl`. This is what makes the `daemon` plugin (Phase 4) iterable without a real logind session, and is also the answer to review point 3 above for local dev — CI still needs the real backend exercised at least once, per Phase 4's exit criteria.

Both are asserted at the top of `main()` to only ever activate outside a `NODE_ENV=production`-equivalent check — belt-and-suspenders against ever shipping a build where these are silently on.

### 2.5 Snapshot + diff — the actual "see it work" output

Before running, the sandbox script hashes every file under `repo/` and `home/`. After running, it re-hashes and prints:

```
+ repo/.agemon/state.json
+ repo/.github/workflows/claude-code-security-review.yml
~ repo/CLAUDE.md            (+1 block: agemon:crg-daemon, 0 lines outside markers touched)
+ home/.config/systemd/user/agemon-crg-daemon.service
```

Plus the manifest contents (`repo/.agemon/state.json`) pretty-printed, and — unless `--quiet` — the exact terminal UI output the run produced, so you're checking the same thing a real user would see. `roundtrip` runs `install` then `nuke` against a fresh fixture copy and asserts the final tree hashes match the pre-install snapshot exactly, failing loudly with the diff if not.

### 2.6 Watch mode

`npm run sandbox:watch -- clean-repo` — re-runs the sandbox against a fresh fixture copy on every save under `src/`. This is the moment-to-moment inner loop while writing a plugin: save → see the diff → adjust.

### 2.7 What the harness deliberately does *not* replace

- **Vitest unit tests** — manifest atomicity, patcher idempotency, plugin dependency ordering. The harness is for *seeing* behavior during development; unit tests are for *pinning* it so it can't silently regress.
- **Real CI on `ubuntu-latest`** — the harness's fake backends are a dev-speed convenience. At least one un-faked, real-subprocess, real-systemd run must pass in CI before any phase touching `crg`/`daemon`/`skills`/`cli-tool` is considered done.
- **`install.sh` testing** — a thin shell script has nothing for the Node-based sandbox to isolate; it's tested manually against a small Docker matrix (Node absent / below floor / sufficient) in Phase 11, per that phase's checkpoint.

---

## 3. Phased Plan

Every phase ends with a **dry-run checkpoint** — the concrete `npm run sandbox …` invocation (or Vitest command) that proves the phase's milestone, taken from `implementation-plan.md` §11, is actually true. Do not start the next phase until the checkpoint passes.

### Pre-Phase-0 — Resolve the two open decisions

Both gate `package.json`/`tsconfig.json`, so they're resolved as a decision, not deferred again:
- **Node version floor:** confirmed 2026-08-13 against nodejs.org's release schedule — **Node ≥ 24**. Node 24 is Active LTS (through Oct 2026, when Node 26 takes over); Node 22 has moved to Maintenance LTS. (Node 22 was the assumption in the original doc — superseded by the schedule moving on since that draft was written.)
- **Lint/format tool:** confirmed 2026-08-13 — Biome, as assumed in the architecture doc. Single tool, single config, no ESLint/Prettier duality to keep in sync.

*Checkpoint:* both values written into `implementation-plan.md` §3/§12 as confirmed (no longer "assumed") — done. Decision log stays the single source of truth.

### Phase 0 — Repo scaffolding + the harness itself

**Tasks:**
- `package.json`, `tsconfig.json`, `tsup` build config, Biome config, `engines.node` pinned to the resolved floor.
- `bin/agemon.js` entry point; empty `Commander` program wired to `src/cli/index.ts`.
- `ui/` layer: `theme.ts` (picocolors wrapper), `spinner.ts` (ora + non-TTY fallback), `table.ts`, `banner.ts` (boxen) — built first because every later phase renders through it.
- `plugins/index.ts` as an empty, statically-ordered array (no plugins registered yet).
- **The harness (§2):** `scripts/sandbox.ts`, `test/fixtures/clean-repo/`, snapshot/diff util, `AGEMON_FAKE_SUBPROCESS`/`AGEMON_FAKE_SERVICES` env-var seams stubbed (even with nothing to fake yet), `npm run sandbox`/`sandbox:watch`/`sandbox:roundtrip`/`reset` scripts.

*Checkpoint:* `npx agemon --help` renders through the theme/spinner layer. `npm run sandbox -- run clean-repo --dry-run` executes end-to-end against the empty plugin list and prints a clean "nothing to do" summary with zero filesystem writes (verified by the snapshot diff showing no changes).

### Phase 1 — Core orchestrator + state manifest

**Tasks:**
- `Context` object, orchestrator walking `plugins/index.ts`, `dependsOn` resolution.
- `.agemon/state.json` reader/writer — **write-temp-then-rename**, so a killed process never leaves a half-written manifest (closes review point 5).
- One no-op `test-plugin` (dev-only, not in the shipped bundle) that logs a fake action, purely to exercise the orchestrator end-to-end.

*Checkpoint:* `npm run sandbox -- run clean-repo` shows the no-op plugin's step in the spinner output, and the resulting `.agemon/state.json` (visible in the diff) contains its logged action, re-readable on a second invocation. `npm run sandbox -- roundtrip clean-repo` passes with only this no-op plugin registered — establishing the round-trip safety net *now*, not at Phase 10.

### Phase 2 — Platform layer: detection, subprocess runner, binary checks

**Tasks:**
- `platform/detect.ts` — reads `/etc/os-release` via an **injectable path** (not a hardcoded constant), so `test/fixtures/non-ubuntu/` can override it without any OS-level mocking.
- `core/subprocess-runner.ts` (`ctx.run`) + its `AGEMON_FAKE_SUBPROCESS` swap (§2.4) — built here, since every plugin from Phase 3 onward depends on it.
- Binary presence checks (`python3`, `pip`, `pipx`, `uv`, `crg`).

*Checkpoint:* `npm run sandbox -- run non-ubuntu` exits non-zero with the clear v2-deferred message and makes zero writes. `npm run sandbox -- run clean-repo` (real Ubuntu fixture) reports accurate presence/absence of each binary — cross-check by hand against what's actually on the dev machine.

### Phase 3 — `crg` plugin

**Tasks:** install/build/verify/uninstall `code-review-graph` via pipx.

*Checkpoint:* `npm run sandbox -- run clean-repo --only crg --real` produces a working graph against the fixture repo (confirm with a real `code-review-graph` query, not just "the process exited 0"). `npm run sandbox -- run preexisting-crg --only crg` (faked) confirms `preExisting: true` is recorded and that a subsequent `nuke` on that fixture leaves the pre-existing install untouched.

### Phase 4 — `service-manager` + `daemon` plugin

**Tasks:**
- `platform/service-manager/index.ts` (interface) + `linux.ts` (systemd `--user` unit + `loginctl` linger).
- `platform/service-manager/fake.ts` (§2.4).
- `daemon` plugin, calling only the interface.
- **Spike:** confirm whether GitHub Actions `ubuntu-latest` has a usable logind user session for `systemctl --user`; document the finding and, if absent, the workaround (`dbus-run-session` or an explicit session bring-up step) directly in `ci.yml`'s comments (closes review point 3).

*Checkpoint:* `npm run sandbox -- run clean-repo --only daemon` (faked) shows the marker file describing exactly what unit *would* be registered. Separately, on a real Ubuntu machine or CI once the spike lands: `npm run sandbox -- run clean-repo --only daemon --real`, reboot (or simulate via `loginctl terminate-user` + re-login), confirm the daemon is running with no manual step, then `nuke --only daemon --real` and confirm linger is disabled *only if* agemon was the one who enabled it (check the manifest's `lingerEnabledByAgemon` flag against reality).

### Phase 5 — Config patchers

**Tasks:** `markdown-block.ts`, `json-merge.ts`, `yaml-frontmatter.ts`.

*Checkpoint:* `npm run sandbox -- run existing-claude-md` — the diff output must show *only* the new delimited block added; running it a second time against the already-patched result must produce an empty diff (idempotency). This is also the moment to add the Vitest idempotency unit test the architecture doc specifies in §10, not defer it.

### Phase 6 — `skills` plugin

**Tasks:** wraps `npx skills add/remove/list`.

*Checkpoint:* `npm run sandbox -- run clean-repo --only skills` (faked, fast) for logic; `npm run sandbox -- run clean-repo --only skills --real` at least once to confirm every `kind:skill` bundle entry actually lands and shows up in a real `npx skills list`.

### Phase 7 — `workflow-scaffolder` plugin

**Tasks:** writes `.github/workflows/*.yml` for `kind:workflow` bundle entries; must refuse to overwrite a same-named pre-existing file.

*Checkpoint:* `npm run sandbox -- run clean-repo --only workflow-scaffolder` — all bundle workflow files land, non-colliding. `npm run sandbox -- run colliding-workflow --only workflow-scaffolder` must **fail loudly and write nothing**, not silently skip or overwrite — check this is a hard `detect()`-level invariant per review point 8, not just an aspiration.

### Phase 8 — `cli-tool` plugin (agnix)

**Tasks:** installs `kind:cli-tool` bundle entries.

*Checkpoint:* `npm run sandbox -- run clean-repo --only cli-tool --real`, then run `agnix lint` against agemon's *own* repo (the dogfooding step already called out in the architecture doc's §10) and confirm it's clean.

### Phase 9 — `master-prompt` plugin

**Tasks:** renders + writes the one-time rule-consolidation Directive.

*Checkpoint:* `npm run sandbox -- run messy-agent-rules --only master-prompt` — the fixture is modeled on this repo's pre-consolidation state (review point 6), so the acceptance bar is concrete: the output should be structurally equivalent to this repo's actual `AGENTS.md` + pointer-file layout, not just "produces *some* consolidated file."

### Phase 10 — `agemon nuke`

**Tasks:** manifest-driven reversal of every action type from Phases 3–9.

*Checkpoint:* `npm run sandbox -- roundtrip clean-repo` (now with the full plugin set registered, not just the Phase-1 no-op) and `npm run sandbox -- roundtrip existing-claude-md --real` — both must report a byte-identical tree, confirming the harness's continuous round-trip net (built in Phase 1) still holds with everything wired in.

### Phase 11 — Distribution

**Tasks:** `install.sh` preflight-and-delegate, npm publish dry run (`npm publish --dry-run`), quickstart README.

*Checkpoint:* manual Docker matrix for `install.sh` — no Node, Node below floor, Node sufficient — each producing the correct one of "install guidance," "version too low," or delegation to `npx agemon@latest install`. This is the one checkpoint the sandbox harness doesn't cover (§2.7) — call it out explicitly when running it so it isn't mistaken for something already automated.

### Phase 12 — OSS polish

**Tasks:** CONTRIBUTING.md (must document `npm run sandbox` as the expected way to verify a change — this plan's harness *is* the contribution workflow, not an internal-only convenience), issue/PR templates, Changesets, green CI matrix.

*Checkpoint:* a fresh clone, `npm install`, `npm run sandbox -- run clean-repo`, works with zero additional setup — that's the actual test of whether the harness achieved its goal of being a real development mechanism and not just documentation.

---

## 4. Sequencing

Same dependency structure as `implementation-plan.md` §11: Phases 3 and 4 need 1–2; Phases 6–9 can proceed in parallel once 1, 2, and 5 exist. The one addition: **Phase 0 now includes the harness itself**, so "parallel" work in 6–9 is only safe to hand to multiple people/sessions because each can verify independently via their own `.sandbox/runs/<label>/` without stepping on each other or on a shared real machine state.

## 5. Definition of done (applies to every phase)

A phase is not done until all four hold:
1. The phase's dry-run checkpoint (§3) passes.
2. At least one checkpoint run used `--real` (or the CI spike, for Phase 4) — faked runs alone never close a phase.
3. `npm run sandbox -- roundtrip <fixture>` still passes with the phase's plugin(s) registered.
4. Relevant Vitest unit tests exist for anything the harness can't assert on its own (manifest atomicity, patcher idempotency diffing, dependency-order resolution).

# agemon — Automated & Hardened Release Pipeline Plan

**Status:** proposed
**Author:** prepared 2026-09-09
**Scope:** replace the tag-and-hand-written-changelog release process with a fully
automated, supply-chain-hardened pipeline driven by
[release-please](https://github.com/googleapis/release-please), triggered by merges to
`master`, producing verifiable release artifacts, and consumed by a self-verifying
`install.sh`.

This plan does **not** touch the reconciler, the CLI surface, or anything in
[`plan.md`](../plan.md) (the Reconciler Hardening & CLI Design Plan). It only rebuilds the
release machinery: `.github/`, `install.sh`, `tsup.config.ts`, `scripts/`, and the release
docs.

---

## 0. Goals, non-goals, and the shape of the result

### 0.1 What we want

1. **No manual version bumps, no hand-written `CHANGELOG.md`.** A human writes
   Conventional-Commit messages; the pipeline derives the version and the changelog.
2. **Release on merge to `master`.** No separate "tag and push" step. The only human
   action after normal development is clicking **Merge** on a bot-maintained release PR.
3. **Every published artifact is verifiable.** A consumer (and `install.sh` itself) can
   prove the `agemon.tgz` they downloaded was built by this repo's workflow from a specific
   commit, and was not modified afterwards.
4. **Minimal blast radius if something is compromised.** The release job holds the fewest
   possible secrets (ideally only the automatic `GITHUB_TOKEN`), third-party code in the
   pipeline is pinned and minimal, and a hijacked dependency cannot silently exfiltrate or
   tamper.
5. **`master` is write-restricted.** Only explicitly allowed accounts can merge to
   `master`; everything else lands through a pull request that must pass CI.
6. **The pipeline refuses to ship a broken build.** The `smol-toml` incident
   (a runtime dependency left out of the bundle, producing a `agemon.tgz` that throws
   `ERR_MODULE_NOT_FOUND` on every invocation) must be impossible to release again.

### 0.2 Non-goals (explicitly excluded)

| Excluded | Reason |
| --- | --- |
| PR **reviews / required approvals** | Solo maintainer. We restrict *who can merge*, but do not require a second reviewer. |
| **npm publishing** / npm provenance / `npm publish --provenance` | Out of scope by request. Distribution stays GitHub Releases + `curl \| sh` only. |
| **`alpha` / `beta` prerelease channels** | Counter-productive under "release automatically on merge to `master`": release-please would either cut a prerelease on every merge or need a second long-lived branch and manual channel selection, which defeats the automation goal. Stable-only. Appendix D describes how to add prereleases later if ever needed. |
| **GPG / cosign signing keys** | Keyless Sigstore attestation (OIDC, no stored key) covers the integrity requirement with nothing to leak. A detached signature can be added later (Appendix A) but is not needed for the stated goal. |
| **Self-hosted runners** | GitHub-hosted ephemeral runners only. |

### 0.3 Target architecture (end state)

```
 ┌─────────────────────────────────────────────────────────────────────────┐
 │  Developer                                                               │
 │    feature branch  ──(Conventional Commit messages)──▶  Pull Request     │
 └─────────────────────────────────────────────────────────────────────────┘
                                   │  CI (ci.yml): lint · typecheck · test ·
                                   │  build · smoke · commitlint            (must pass)
                                   ▼
 ┌─────────────────────────────────────────────────────────────────────────┐
 │  master  (branch ruleset: PR required, status checks required,          │
 │           push restricted to allowed accounts, linear history)          │
 └─────────────────────────────────────────────────────────────────────────┘
                                   │  push to master
                                   ▼
 ┌─────────────────────────────────────────────────────────────────────────┐
 │  release.yml   (single workflow, permissions: contents:read by default) │
 │                                                                         │
 │   job: release-please                                                   │
 │     └─ googleapis/release-please-action                                 │
 │          • no release pending  → opens/updates "release PR"             │
 │            (version bump in package.json + CHANGELOG.md regenerated)    │
 │          • release PR merged   → creates git tag vX.Y.Z +              │
 │            GitHub Release (notes), sets outputs.release_created=true    │
 │                                                                         │
 │   if steps.rp.outputs.release_created == 'true':   (same job)          │
 │     permissions elevated: contents:write id-token:write attestations:write │
 │     ├─ checkout the tag                                                 │
 │     ├─ npm ci --ignore-scripts                                          │
 │     ├─ lint · typecheck · test · build · smoke   (re-run on the tag)   │
 │     ├─ npm pack  → agemon.tgz                                          │
 │     ├─ sha256sum agemon.tgz > agemon.tgz.sha256                        │
 │     ├─ actions/attest-build-provenance (agemon.tgz)  → SLSA prov.      │
 │     └─ gh release upload vX.Y.Z agemon.tgz agemon.tgz.sha256           │
 └─────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
 ┌─────────────────────────────────────────────────────────────────────────┐
 │  GitHub Release vX.Y.Z                                                   │
 │    assets:  agemon.tgz  ·  agemon.tgz.sha256                            │
 │    attestation: build provenance (queryable via `gh attestation verify`)│
 └─────────────────────────────────────────────────────────────────────────┘
                                   │  curl | sh
                                   ▼
 ┌─────────────────────────────────────────────────────────────────────────┐
 │  install.sh                                                             │
 │    1. resolve real latest tag via GitHub API (not the CDN alias)       │
 │    2. download version-pinned agemon.tgz  +  agemon.tgz.sha256         │
 │    3. verify SHA-256                                                    │
 │    4. if `gh` present: `gh attestation verify` (soft-fail w/ warning,  │
 │       hard-fail if AGEMON_REQUIRE_ATTESTATION=1)                       │
 │    5. extract to staging, run staged binary --version == expected      │
 │    6. atomic swap into place, re-verify, PATH-shadow check             │
 └─────────────────────────────────────────────────────────────────────────┘
```

### 0.4 Secrets inventory (end state)

| Secret | Where | Why | Risk if leaked |
| --- | --- | --- | --- |
| `GITHUB_TOKEN` (automatic, per-run, expires at job end) | every workflow | checkout, release-please PR, `gh release`, upload assets | scoped to this repo; expires in minutes; cannot trigger other workflows |
| **(none else)** | — | attestation signing is keyless via OIDC; no PAT, no App key, no GPG key | — |

This is the headline security property: **there is no long-lived release credential to
steal.** Appendix B (GitHub App token) is optional and only needed if the release PR must
trigger `pull_request`-typed CI *and* we choose not to use the `push`-trigger approach in
Phase 4.

---

## 1. Phase 1 — Conventional Commits foundation

**Objective:** make every commit that reaches `master` parseable by release-please, so it
can compute the next semver and the changelog with no human input.

**Why:** release-please derives the release entirely from commit message *prefixes*
(`feat:` → minor, `fix:` → patch, `feat!:` / `BREAKING CHANGE:` → major, `chore:` /
`docs:` / `refactor:` / `test:` / `ci:` → no release on their own). If messages are
free-form, release-please produces empty or wrong releases.

### 1.1 Steps

1. **Adopt the spec.** Use [Conventional Commits 1.0.0](https://www.conventionalcommits.org/).
   Allowed types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`,
   `chore`, `revert`. Breaking changes: `type!:` in the subject or a `BREAKING CHANGE:`
   footer.

2. **Local guard (no new npm dependency).** Add a committed git hook rather than
   husky/lefthook, to keep the dependency surface at zero:

   - `.githooks/commit-msg` — a POSIX `sh` script that checks the first line against
     `^(feat|fix|perf|refactor|docs|test|build|ci|chore|revert)(\([a-z0-9/_-]+\))?!?: .+`
     and rejects otherwise (with a one-paragraph explainer and an example).
   - Document `git config core.hooksPath .githooks` in `CONTRIBUTING.md` as a one-time
     setup step. The hook is advisory; CI is the enforced gate.

3. **CI enforcement (the real gate).** In `ci.yml`, add a job `commitlint`:

   - On `pull_request`: lint every commit in the PR range with
     `wagoid/commitlint-github-action` (SHA-pinned) using `@commitlint/config-conventional`.
   - Config file `commitlint.config.js`:
     ```js
     module.exports = { extends: ["@commitlint/config-conventional"] };
     ```
   - Add `@commitlint/config-conventional` to `devDependencies` (it is pure JS, no
     install scripts).

4. **Squash-merge only + PR-title lint.** Because the branch ruleset (Phase 6) enforces
   linear history and we squash-merge, the *PR title* becomes the commit subject on
   `master`. Add a second check: `amannn/action-semantic-pull-request` (SHA-pinned) on
   `pull_request` events (`opened`, `edited`, `synchronize`) validating the PR title as a
   Conventional Commit. Set the repo default merge method to **Squash** and the squash
   commit message to **"Pull request title and description"**.

5. **`docs/` and `.github/` etc.** `chore:`/`docs:`/`ci:` commits are fine — they simply
   do not, by themselves, trigger a release. A release happens when at least one
   `feat:`/`fix:`/`perf:` (or breaking) commit has accumulated since the last tag.

### 1.2 Verification

- Open a throwaway PR titled `chore: test commit lint`; the `commitlint` and PR-title
  checks pass. Change the title to `nonsense`; both fail and block merge.
- `git commit -m "bad message"` on a branch with the hook installed is rejected locally.

### 1.3 Files

| File | Action |
| --- | --- |
| `.githooks/commit-msg` | new (POSIX sh, executable) |
| `commitlint.config.js` | new |
| `package.json` | add `@commitlint/config-conventional` to `devDependencies` |
| `.github/workflows/ci.yml` | add `commitlint` + PR-title jobs (details in Phase 4) |
| `CONTRIBUTING.md` | document the commit convention + `core.hooksPath` |

---

## 2. Phase 2 — release-please configuration

**Objective:** install release-please in "manifest" mode, bootstrapped at the current
version, configured for a single Node package that is **not** published to npm.

**Why manifest mode:** it is release-please's current recommended mode, keeps all state in
two committed files (auditable, diffable), and does not depend on release-please reading
GitHub Release history.

### 2.1 Steps

1. **`.release-please-manifest.json`** — bootstrap at the version currently in
   `package.json`:
   ```json
   { ".": "3.0.0" }
   ```
   release-please will take over bumping this file from here.

2. **`release-please-config.json`:**
   ```json
   {
     "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
     "release-type": "node",
     "bump-minor-pre-major": false,
     "bump-patch-for-minor-pre-major": false,
     "include-v-in-tag": true,
     "include-component-in-tag": false,
     "changelog-type": "default",
     "packages": {
       ".": {
         "package-name": "agemon",
         "changelog-path": "CHANGELOG.md"
       }
     },
     "pull-request-title-pattern": "chore: release ${version}",
     "pull-request-header": "Release PR — review the version bump and changelog, then merge to publish.",
     "changelog-sections": [
       { "type": "feat",     "section": "Features" },
       { "type": "fix",      "section": "Bug Fixes" },
       { "type": "perf",     "section": "Performance" },
       { "type": "revert",   "section": "Reverts" },
       { "type": "refactor", "section": "Refactors", "hidden": true },
       { "type": "docs",     "section": "Documentation", "hidden": true },
       { "type": "build",    "section": "Build System", "hidden": true },
       { "type": "ci",       "section": "CI", "hidden": true },
       { "type": "test",     "section": "Tests", "hidden": true },
       { "type": "chore",    "section": "Chores", "hidden": true }
     ]
   }
   ```
   Notes:
   - `release-type: node` makes release-please bump `package.json` **and**
     `package-lock.json`'s `version`, and prepend to `CHANGELOG.md`.
   - It does **not** run `npm publish` — that only happens if we add an npm step, which we
     will not.
   - `include-v-in-tag: true` keeps the existing `vX.Y.Z` tag format, matching the current
     tag ruleset target and `install.sh`'s URL construction.

3. **First release-please run will want to reconcile `CHANGELOG.md`.** The existing
   `CHANGELOG.md` uses `## 3.0.0` headings; release-please's `default` changelog also uses
   `## [x.y.z]` style. Two options:
   - **Recommended:** leave history as-is; release-please only prepends new entries above
     the existing content. Its first entry (e.g. `## [3.0.1]`) sits on top; older
     hand-written sections remain untouched.
   - Optional cosmetic pass later to normalize old headings — not required, not in this
     plan's critical path.

4. **Version trajectory.** The working tree already contains the `smol-toml`/tsup fix and
   the bundle smoke test (currently uncommitted). Commit those as
   `fix: bundle every runtime dependency so the release tarball runs standalone` and
   `ci: smoke-test the packaged bundle`. The first release-please PR after this pipeline is
   live will therefore propose **`3.0.1`** — the first genuinely working v3 artifact.

### 2.2 Verification

- After merging the pipeline, push a trivial `fix:` commit to `master`. Within ~1 min a
  PR titled `chore: release 3.0.1` appears, changing `package.json`, `package-lock.json`,
  `.release-please-manifest.json`, and `CHANGELOG.md`. Do **not** merge yet — Phase 3 must
  be in place first.

### 2.3 Files

| File | Action |
| --- | --- |
| `.release-please-manifest.json` | new |
| `release-please-config.json` | new |

---

## 3. Phase 3 — The consolidated, hardened release workflow

**Objective:** one workflow, `release.yml`, that runs on push to `master`, lets
release-please manage the release PR, and — **in the same job, only when a release was
actually created** — builds, verifies, attests, and uploads the artifacts.

**Why one job instead of tag-triggered publish:** a tag or Release created with the
automatic `GITHUB_TOKEN` **does not trigger** other workflows (GitHub's loop-prevention
rule). A separate `on: push: tags` publish workflow would silently never run. Doing the
publish steps conditionally in the same job sidesteps this entirely and needs **no PAT or
App token**.

### 3.1 Workflow structure

```yaml
name: Release

on:
  push:
    branches: [master]

# Serialize: never two releases in flight.
concurrency:
  group: release
  cancel-in-progress: false

# Least privilege by default; the publish steps elevate explicitly.
permissions:
  contents: read

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write        # release-please: bump files, create tag + Release
      pull-requests: write    # release-please: open/update the release PR
      id-token: write         # attestation: OIDC token for keyless signing
      attestations: write     # attestation: upload the provenance record
    steps:
      - name: Harden runner
        uses: step-security/harden-runner@<SHA>   # egress-policy: audit (Phase 5)
        with:
          egress-policy: audit

      - name: release-please
        id: rp
        uses: googleapis/release-please-action@<SHA>
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          config-file: release-please-config.json
          manifest-file: .release-please-manifest.json

      # ---- everything below runs ONLY when the release PR was just merged ----

      - name: Checkout release tag
        if: ${{ steps.rp.outputs.release_created == 'true' }}
        uses: actions/checkout@<SHA>
        with:
          ref: ${{ steps.rp.outputs.tag_name }}
          persist-credentials: false

      - name: Setup Node
        if: ${{ steps.rp.outputs.release_created == 'true' }}
        uses: actions/setup-node@<SHA>
        with:
          node-version: 24.x
          cache: npm

      - name: Install (no lifecycle scripts)
        if: ${{ steps.rp.outputs.release_created == 'true' }}
        run: npm ci --ignore-scripts

      - name: Quality gates on the tagged tree
        if: ${{ steps.rp.outputs.release_created == 'true' }}
        run: |
          npm run lint
          npm run typecheck
          npm test
          npm run build
          npm run smoke        # packaged bundle runs with no node_modules

      - name: Package
        if: ${{ steps.rp.outputs.release_created == 'true' }}
        run: |
          npm pack --pack-destination . --loglevel=warn
          mv agemon-*.tgz agemon.tgz

      - name: Checksum
        if: ${{ steps.rp.outputs.release_created == 'true' }}
        run: sha256sum agemon.tgz | tee agemon.tgz.sha256

      - name: Attest build provenance
        if: ${{ steps.rp.outputs.release_created == 'true' }}
        uses: actions/attest-build-provenance@<SHA>
        with:
          subject-path: agemon.tgz

      - name: Upload release assets
        if: ${{ steps.rp.outputs.release_created == 'true' }}
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: gh release upload "${{ steps.rp.outputs.tag_name }}" agemon.tgz agemon.tgz.sha256
```

### 3.2 Design notes / rationale

- **`smoke` re-run on the tag.** release-please's PR was already green in CI, but CI ran on
  the PR *branch*. Re-running `lint/typecheck/test/build/smoke` against the actual tag
  commit closes the (small) gap between "PR was green" and "this exact tree is what
  ships". This is the guard that makes the `smol-toml` class of bug unreleasable: `smoke`
  packs the tarball and runs it with no `node_modules`.
- **`npm ci --ignore-scripts`.** Blocks `pre`/`post`-install script execution — the
  vector used by the 2025 "Shai-Hulud" npm worm to scrape CI tokens. Safe here: every
  runtime dependency (`boxen`, `commander`, `ora`, `picocolors`, `smol-toml`, `yaml`) is
  pure JS with no native build step. Add a comment saying so, so a future native dep
  triggers a conscious decision.
- **Attestation (`actions/attest-build-provenance`).** Produces an in-toto SLSA build
  provenance statement for `agemon.tgz`, signed with a short-lived Sigstore certificate
  via the job's OIDC identity. Gets us **SLSA Build Level 2** (link between artifact and
  build instructions). No key is stored anywhere. Free for public repos. Consumers verify:
  ```
  gh attestation verify agemon.tgz --repo Korak-997/agemon
  ```
- **`persist-credentials: false`** on the tag checkout so the `GITHUB_TOKEN` is not left
  in `.git/config` for later steps that run `npm`/build code.
- **`concurrency: release`, `cancel-in-progress: false`.** If two merges land quickly, the
  second run waits rather than racing on tag creation / asset upload.
- **No `pull_request` / `pull_request_target` trigger.** This workflow only ever runs on
  trusted `master` commits.

### 3.3 Retire the old release path

| File | Action | Why |
| --- | --- | --- |
| `.github/workflows/release.yml` (current, tag-triggered) | **replace** with the above | one blessed path; the tag-format/changelog/version guards it performed are now enforced by release-please + the branch ruleset |
| `scripts/deploy.ts` | **delete** | manual bump/changelog/tag flow is fully replaced; leaving it invites a second, unaudited release route |
| `package.json` `"deploy"` script | **remove** | — |
| `docs/releasing.md` | **rewrite** (Phase 8) | currently documents the manual + `alpha/beta` flow that no longer exists |

### 3.4 Verification

- Merge the Phase-2 `chore: release 3.0.1` PR. The workflow: release-please creates tag
  `v3.0.1` + a GitHub Release with generated notes; the conditional steps then build,
  smoke-test, pack, checksum, attest, and upload `agemon.tgz` + `agemon.tgz.sha256`.
- `gh attestation verify agemon.tgz --repo Korak-997/agemon` succeeds against the uploaded
  asset.
- `gh release view v3.0.1` shows exactly two assets.

---

## 4. Phase 4 — CI workflow (`ci.yml`) changes

**Objective:** make CI (a) gate the release PR correctly, (b) enforce Conventional
Commits, (c) share the same hardening as `release.yml`.

### 4.1 Trigger change (critical for release-please + `GITHUB_TOKEN`)

release-please opens its PR using `GITHUB_TOKEN`. PRs opened by `GITHUB_TOKEN` **do not
fire `on: pull_request` workflows** — so if the branch ruleset requires status checks,
the release PR could never satisfy them. Fix without introducing an App token:

```yaml
on:
  pull_request:
    branches: [master]
  push:
    branches:
      - master
      - "release-please--**"     # the branch release-please pushes its PR to
```

A `push`-triggered CI run on the release-please branch head posts commit statuses / check
runs on that SHA, which the ruleset's "require status checks" reads. Add
`concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }` to avoid double
runs on normal PRs (push + pull_request on the same SHA).

> If this dual-trigger proves awkward, Appendix B swaps release-please's token for a
> GitHub App token, which makes the PR fire `pull_request` normally. That costs two stored
> secrets (App ID + private key). The `push`-trigger approach costs nothing and is the
> default in this plan.

### 4.2 Jobs

| Job | Runs on | Steps |
| --- | --- | --- |
| `quality` (matrix: Node 24, 26) | pull_request, push | harden-runner (audit) → checkout → setup-node → `npm ci --ignore-scripts` → `npm audit --omit=dev --audit-level=high` → `lint` → `typecheck` → `test` → `build` → `smoke` |
| `sandbox` | pull_request, push | harden-runner (audit) → checkout → setup-node → `npm ci --ignore-scripts` → `npm run sandbox -- run clean-repo --dry-run` → `npm run sandbox -- roundtrip clean-repo` |
| `commitlint` | pull_request | `wagoid/commitlint-github-action@<SHA>` over the PR commit range |
| `pr-title` | pull_request (opened, edited, synchronize) | `amannn/action-semantic-pull-request@<SHA>` |

`build` + `smoke` are already added to `quality` in the current working tree — keep them.

### 4.3 Required status checks (wired in Phase 6)

The branch ruleset will require: `quality (node 24.x)`, `quality (node 26.x)`,
`sandbox checks`, `commitlint`. `pr-title` is advisory-but-blocking via its own failure;
it need not be a named required check because it only exists on PRs.

### 4.4 Files

| File | Action |
| --- | --- |
| `.github/workflows/ci.yml` | edit: triggers, `--ignore-scripts`, harden-runner, `commitlint` + `pr-title` jobs, concurrency |

---

## 5. Phase 5 — Workflow-wide hardening

**Objective:** apply the GitHub-published hardening guidance to *both* workflows.

### 5.1 Least-privilege `permissions`

- Every workflow gets a top-level `permissions: contents: read`.
- Only `release.yml`'s `release` job elevates, and only to what it needs
  (`contents: write`, `pull-requests: write`, `id-token: write`, `attestations: write`).
- `ci.yml` needs no write permissions at all.

### 5.2 Pin every third-party action to a full commit SHA

Rationale: the March 2025 `tj-actions/changed-files` compromise moved a *tag* to malicious
code that dumped `GITHUB_TOKEN` and secrets into build logs across thousands of repos.
A full 40-char commit SHA is immutable.

| Action | Pin | Notes |
| --- | --- | --- |
| `actions/checkout` | SHA | first-party |
| `actions/setup-node` | SHA | first-party |
| `actions/attest-build-provenance` | SHA | first-party |
| `googleapis/release-please-action` | SHA | Google-maintained; still pin |
| `step-security/harden-runner` | SHA | |
| `wagoid/commitlint-github-action` | SHA | |
| `amannn/action-semantic-pull-request` | SHA | |

Record the human-readable version in a trailing comment: `uses: actions/checkout@<sha>  # v4.2.2`.

### 5.3 `step-security/harden-runner` — audit, then block

1. **Now:** add with `egress-policy: audit` to every job. It records all outbound network
   from the runner and annotates the run.
2. **After 2–3 green releases:** inspect the recorded destinations (expected: GitHub API,
   `objects.githubusercontent.com`, `registry.npmjs.org`, Sigstore/Fulcio/Rekor for
   attestation). Switch to `egress-policy: block` with an explicit `allowed-endpoints`
   list. From then on, a hijacked dependency that tries to phone home during
   `build`/`pack` fails the job loudly.

### 5.4 Script-injection safety

- No workflow interpolates `${{ github.event.* }}`, `${{ github.head_ref }}`, PR titles,
  or `${{ inputs.* }}` directly into a `run:` block.
- Any such value that is needed goes through `env:` and is referenced as `"$VAR"` with
  quotes.
- `release.yml` has no user-controlled inputs at all (it is `push`-triggered), which
  removes the class entirely for the release path.

### 5.5 Dependabot

`.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: "/"
    schedule: { interval: weekly }
    groups:
      actions: { patterns: ["*"] }
  - package-ecosystem: npm
    directory: "/"
    schedule: { interval: weekly }
    groups:
      dev-dependencies:
        dependency-type: development
      runtime-dependencies:
        dependency-type: production
```

Keeps pinned action SHAs and npm deps current via PRs (which themselves must pass CI +
commitlint — use `commit-message.prefix: "chore"` / `"build"` so they parse).

### 5.6 Repo Actions settings (Settings → Actions → General)

| Setting | Value | Why |
| --- | --- | --- |
| Actions permissions | "Allow `<owner>`, and select…" → allowlist `actions/*`, `googleapis/*`, `step-security/*`, `wagoid/*`, `amannn/*` | blocks arbitrary third-party actions even if a workflow edit slips through |
| Workflow permissions | **Read repository contents and packages permissions** (default read) | least privilege; workflows opt into more |
| Allow GitHub Actions to create and approve pull requests | **On** | release-please must be able to open its PR |
| Fork pull request workflows | require approval for first-time contributors (default) | — |

### 5.7 Files

| File | Action |
| --- | --- |
| `.github/dependabot.yml` | new |
| `.github/workflows/*.yml` | edit: permissions, SHA pins, harden-runner |
| `CODEOWNERS` (`.github/CODEOWNERS`) | new — assign `/.github/`, `/install.sh`, `/tsup.config.ts`, `/scripts/`, `/release-please-config.json` to the owner. Even solo, this documents ownership and auto-applies if a collaborator is ever added. |

---

## 6. Phase 6 — Repository rulesets & branch protection

**Objective:** `master` is only writable through a passing PR, and only designated
accounts can merge. Tags matching `v*` can only be created by the release automation / the
owner.

### 6.1 `master` branch ruleset (Settings → Rules → Rulesets → New branch ruleset)

- **Target:** `refs/heads/master` (default branch).
- **Enforcement:** Active.
- **Bypass list:** the owner account only (or a `maintainers` team). This is the
  "only allowed persons can accept and merge" control — accounts not on this list and not
  holding a bypass cannot push to or merge into `master`; they can only open PRs.
- **Rules:**
  | Rule | Setting |
  | --- | --- |
  | Require a pull request before merging | **on**; Required approvals: **0** (solo dev); "Dismiss stale approvals": n/a; "Require review from Code Owners": **off** |
  | Require status checks to pass | **on** → add `quality (node 24.x)`, `quality (node 26.x)`, `sandbox checks`, `commitlint`; "Require branches to be up to date": **on** |
  | Require linear history | **on** (pairs with squash-merge; keeps release-please's parsing clean) |
  | Block force pushes | **on** |
  | Restrict deletions | **on** |
  | Require signed commits | optional — see 6.4 |

  > "Required approvals: 0" + "Require a pull request" means: everything goes through a PR
  > and must be green, but *you* can merge your own PR without a second person. Non-bypass
  > accounts cannot merge at all.

### 6.2 Tag ruleset (Settings → Rules → Rulesets → New tag ruleset)

- **Target:** `refs/tags/v*`.
- **Bypass list:** the owner + (implicitly) the Actions bot that release-please runs as —
  i.e. allow the `GITHUB_TOKEN`/`github-actions` actor to create tags. In practice
  release-please creates the tag *as* `github-actions[bot]`; add "Repository admin" and
  "GitHub Actions" to bypass, or set the rule to only restrict *update*/*delete* and allow
  *create* by admins + Actions.
- **Rules:**
  | Rule | Setting |
  | --- | --- |
  | Restrict creations | **on** — only bypass actors create `v*` tags |
  | Restrict updates | **on** |
  | Restrict deletions | **on** |
  | Require tag name pattern | `^v[0-9]+\.[0-9]+\.[0-9]+$` (stable only — no `-alpha`/`-beta`, matching the non-goal) |

### 6.3 Collaborator permissions

- Base role for any future collaborator: **Write** (can push branches + open PRs) — never
  **Maintain**/**Admin** unless they should also be able to merge to `master` and cut
  releases.
- The bypass lists in 6.1 / 6.2 are the actual merge/release gate, independent of role.

### 6.4 Optional: require signed commits

If enabled in 6.1, `github-actions[bot]` commits from release-please are **verified**
automatically (GitHub signs commits it creates via the API), so release-please still
works. Local developer commits then need a configured signing key. Reasonable to turn on;
not required for the stated goals. Decide at rollout.

### 6.5 Verification

- From a non-bypass account (or a test), attempt `git push origin master` directly →
  rejected.
- Open a PR with a failing test → merge button disabled ("Required statuses must pass").
- `git tag v9.9.9 && git push origin v9.9.9` from the owner's machine outside the pipeline
  → allowed only if owner is on the tag bypass list; `git push origin foo` (bad pattern)
  → rejected.

---

## 7. Phase 7 — `install.sh` integrity verification

**Objective:** the installer proves the bytes it runs, not just that a download
succeeded. This builds on the hardening already in the working tree (API version
resolution, version-pinned URL, staged run-check, atomic swap, PATH-shadow detection).

### 7.1 Add: SHA-256 verification (blocking)

1. After resolving `EXPECTED_VERSION` / `DOWNLOAD_URL`, also fetch
   `…/releases/download/v<version>/agemon.tgz.sha256`.
2. Recompute the tarball hash locally with whichever of `sha256sum` / `shasum -a 256` /
   `openssl dgst -sha256` is present (fall back across them; if none, hard-fail with a
   clear message — a security tool should not silently skip integrity checks).
3. Compare against the published value (parse the first 64 hex chars from the `.sha256`
   file). Mismatch → abort **before** extraction, message: *"checksum mismatch — the
   download is corrupt or tampered; nothing was changed on your machine."*
4. This runs in addition to the existing "does the staged binary report the expected
   version" check, not instead of it.

### 7.2 Add: build-provenance verification (best-effort, opt-in-strict)

1. If `gh` is on `PATH`:
   `gh attestation verify "<tarball>" --repo Korak-997/agemon` (needs `gh auth` or works
   unauthenticated for public repos via the `--repo` form).
   - Success → print `provenance: verified (built by Korak-997/agemon release workflow)`.
   - Failure → if `AGEMON_REQUIRE_ATTESTATION=1`, abort; else print a warning and
     continue (checksum already gave integrity; attestation adds provenance).
2. If `gh` is absent → print a one-line hint on how to verify manually, continue.
3. Document `AGEMON_REQUIRE_ATTESTATION=1` in `README.md` for users who want the strict
   gate.

### 7.3 Keep (already implemented, do not regress)

- Resolve the real latest tag via the GitHub API; download the **version-pinned** asset
  URL, never the `releases/latest/download/…` CDN alias.
- `Cache-Control: no-cache`, bounded `--connect-timeout`, `--retry`.
- Extract to a staging dir; run the staged binary; only then atomically swap into place —
  a broken or truncated release never destroys a working install.
- Post-swap re-verification + PATH-shadow warning + `hash -r` reminder.

### 7.4 Files

| File | Action |
| --- | --- |
| `install.sh` | edit: add checksum verification (blocking) + attestation verification (best-effort) |
| `README.md` | document verification behavior + `AGEMON_REQUIRE_ATTESTATION` |

---

## 8. Phase 8 — Supporting docs & housekeeping

| File | Action | Content |
| --- | --- | --- |
| `docs/releasing.md` | **rewrite** | New model: "commit with Conventional Commits → merge to `master` → merge the `chore: release X.Y.Z` PR → pipeline publishes." Remove all manual-bump / `alpha`/`beta` / `npm run deploy` content. Document how to read the release PR, how to skip a release (nothing to do — just don't merge the PR), and how release types map (`feat`→minor, `fix`→patch, `!`/`BREAKING CHANGE`→major). |
| `CONTRIBUTING.md` | edit | Conventional Commit types + examples; `git config core.hooksPath .githooks`; note that PR title becomes the squash commit and must be a Conventional Commit; remove "add a `## X.Y.Z` entry to CHANGELOG.md" (release-please owns the changelog now). |
| `SECURITY.md` | **new** | Supported versions; how to report a vulnerability (private advisory / email); statement that releases are built by GitHub Actions with SLSA build provenance and how to verify (`gh attestation verify`, `agemon.tgz.sha256`); `install.sh`'s verification behavior. |
| `README.md` | edit | "Verifying your download" section: `agemon.tgz.sha256`, `gh attestation verify …`, `AGEMON_REQUIRE_ATTESTATION=1`, and a manual (non-`curl \| sh`) install path for the security-conscious. |
| `CHANGELOG.md` | leave | release-please prepends; do not hand-edit going forward. |
| `.gitignore` | check | `plan.md` is ignored; add `docs/release-pipeline-plan.md`? **No** — this plan should be tracked. Leave `docs/` tracked as it is today. |

---

## 9. Phase 9 — Rollout order, first-release runbook, verification, rollback

### 9.1 Order of operations (each step is independently safe to land)

1. **Land the bundle fix + smoke test** (already in the working tree) as a normal PR:
   commits `fix: bundle every runtime dependency into the release tarball` and
   `ci: smoke-test the packaged bundle`. Merge via the *current* process. This makes the
   next release runnable regardless of pipeline timing.
2. **Phase 1** — commit convention: `.githooks/commit-msg`, `commitlint.config.js`,
   `@commitlint/config-conventional` dep, `ci.yml` `commitlint` + `pr-title` jobs,
   `CONTRIBUTING.md`. (`ci:` / `chore:` commits.)
3. **Phase 5 hardening + Phase 4 CI triggers** — `permissions`, SHA pins, harden-runner
   (audit), `--ignore-scripts`, `dependabot.yml`, `CODEOWNERS`, CI `push` trigger for
   `release-please--**`.
4. **Phase 2** — `release-please-config.json`, `.release-please-manifest.json` (bootstrap
   `3.0.1` or `3.0.0` depending on whether step 1 already shipped a `3.0.1`).
5. **Phase 3** — replace `release.yml` with the consolidated workflow; delete
   `scripts/deploy.ts` + the `deploy` npm script.
6. **Phase 6** — create the `master` branch ruleset and the `v*` tag ruleset; set repo
   Actions settings; set default merge method = Squash.
7. **Phase 7** — `install.sh` checksum + attestation verification.
8. **Phase 8** — rewrite `docs/releasing.md`, add `SECURITY.md`, update `README.md` /
   `CONTRIBUTING.md`.
9. **Cut the first pipeline release** (runbook below).
10. **After 2–3 clean releases** — flip harden-runner to `egress-policy: block` with the
    observed allowlist.

### 9.2 First-release runbook

1. Ensure Phases 1–8 are merged to `master`.
2. Push any `fix:` or `feat:` commit (the bundle fix counts if not already released).
3. Wait for the `chore: release X.Y.Z` PR from `github-actions[bot]`. Confirm its diff:
   `package.json` + `package-lock.json` + `.release-please-manifest.json` version bump,
   and a new `CHANGELOG.md` section built from the commit subjects since `v3.0.0`.
4. Confirm CI is green on that PR (via the `push`-triggered run on the
   `release-please--branches--master` branch).
5. **Merge the release PR** (squash).
6. Watch `release.yml`: `release-please` step creates `vX.Y.Z` + the GitHub Release;
   the conditional steps build → smoke → pack → checksum → attest → upload.
7. Verify (9.3).

### 9.3 Post-release verification checklist

- [ ] `gh release view vX.Y.Z` shows notes + exactly two assets: `agemon.tgz`,
      `agemon.tgz.sha256`.
- [ ] `gh attestation verify agemon.tgz --repo Korak-997/agemon` → PASS.
- [ ] `sha256sum -c agemon.tgz.sha256` (after downloading both) → OK.
- [ ] Fresh box / container: `curl -fsSL …/install.sh | sh` → installs `X.Y.Z`,
      `agemon --version` prints `X.Y.Z`, `agemon --help` runs.
- [ ] `AGEMON_REQUIRE_ATTESTATION=1 … | sh` on a box with `gh` → still succeeds.
- [ ] Tamper test: edit a byte of a downloaded `agemon.tgz`, point `install.sh` at it
      (local `file://` or a fork) → checksum step aborts, nothing installed.
- [ ] GitHub "Latest release" points at `vX.Y.Z` (not a prerelease — there are none).
- [ ] `install.sh`'s API-based resolver returns `X.Y.Z` immediately (no CDN-alias lag).

### 9.4 Rollback

| Failure | Rollback |
| --- | --- |
| release-please proposes a wrong version | close the release PR; fix commit types on `master` (a follow-up `fix:`/`feat:` or a `chore:` correction); release-please recomputes. Nothing is published until the PR merges. |
| `release.yml` publish steps fail *after* the tag/Release exist | the Release exists with **no assets** → `install.sh` will refuse it (its staged run-check / checksum fetch fails → "nothing changed"). Fix the workflow, then re-run the failed job, or `gh release delete vX.Y.Z --cleanup-tag` and let the next merge re-cut. |
| bad artifact shipped | `gh release delete vX.Y.Z --cleanup-tag`; `git revert` the offending commit on `master`; next merge cuts `X.Y.(Z+1)`. `install.sh`'s API resolver immediately points users at the new good version. |
| pipeline wedged | the deleted `scripts/deploy.ts` can be restored from git history for a one-off manual release; treat as break-glass only. |

---

## Appendix A — Optional later hardening (not in scope now)

- **Detached signature** in addition to attestation: keyless `cosign sign-blob` (OIDC,
  no stored key) producing `agemon.tgz.sig` + `agemon.tgz.pem`; `install.sh` verifies with
  `cosign verify-blob`. Adds a second, tooling-independent integrity proof. Skipped now
  because attestation + checksum already meet the goal.
- **SLSA Build Level 3**: move the signing/attestation into a separate reusable workflow
  invoked with `id-token` so signing is isolated from the build. Marginal benefit for a
  single-maintainer repo.
- **`npm publish --provenance`** as a secondary channel — explicitly excluded by request;
  revisit only if npm distribution is ever wanted.
- **Reproducible build verification**: a CI job that builds twice and diffs `dist/` to
  catch nondeterminism, making the provenance stronger.

## Appendix B — GitHub App token alternative (only if the Phase 4 `push` trigger is unsatisfactory)

Instead of triggering CI on `push` to `release-please--**`:

1. Create a GitHub App (owner-only), permissions: `contents: read/write`,
   `pull_requests: read/write`. Install on this repo only.
2. Store `APP_ID` (variable) + `APP_PRIVATE_KEY` (secret).
3. In `release.yml`, before release-please:
   ```yaml
   - uses: actions/create-github-app-token@<SHA>
     id: apptoken
     with: { app-id: ${{ vars.APP_ID }}, private-key: ${{ secrets.APP_PRIVATE_KEY }} }
   - uses: googleapis/release-please-action@<SHA>
     with: { token: ${{ steps.apptoken.outputs.token }}, ... }
   ```
   The release PR is now opened by the App identity, so it fires `pull_request` CI
   normally, and a tag it pushes *can* trigger tag-based workflows (not needed here since
   publish is in-job).

**Cost:** two stored secrets and an App to maintain. **Benefit:** cleaner PR semantics.
The plan's default (`push` trigger, `GITHUB_TOKEN` only) is preferred for a solo repo
because it keeps the secrets inventory empty.

## Appendix C — Control → threat mapping

| Threat | Control(s) |
| --- | --- |
| Broken artifact shipped (`smol-toml` class) | `smoke` in CI **and** re-run on the tag in `release.yml`; `tsup` `noExternal` derived from `dependencies` |
| Stale CDN alias serves an old tarball | `install.sh` resolves the real tag via GitHub API + version-pinned asset URL; checksum verification |
| Tampered download in transit / at rest | `agemon.tgz.sha256` verification (blocking) in `install.sh` |
| Fake artifact from a non-repo builder | `actions/attest-build-provenance` + `gh attestation verify` |
| Hijacked third-party GitHub Action (`tj-actions` class) | all actions pinned to full commit SHA; Actions allowlist; Dependabot updates SHAs |
| Malicious npm dependency (`Shai-Hulud` class) | `npm ci --ignore-scripts`; `npm audit --omit=dev --audit-level=high`; harden-runner egress `block` (after audit); deps bundled & reviewed; Dependabot |
| Secret exfiltration from the release job | no long-lived secrets (OIDC keyless signing, `GITHUB_TOKEN` only); least-privilege `permissions`; `persist-credentials: false`; harden-runner |
| Unauthorized code reaching `master` | branch ruleset: PR required, status checks required, push restricted to bypass list |
| Unauthorized / malformed release tag | tag ruleset: creation restricted, `^v\d+\.\d+\.\d+$` pattern |
| Rogue workflow edit | `CODEOWNERS` on `.github/`; branch ruleset applies to workflow files too; Actions allowlist |
| Recursion / double release | `concurrency: release`; `GITHUB_TOKEN` cannot trigger further workflows; tag-exists is a no-op for release-please |
| `master` compromise silently changing what everyone `curl`s | `install.sh` also shipped as a versioned release asset; documented manual verified-install path; attestation pins builds to specific commits |

## Appendix D — Re-introducing prereleases later (if ever needed)

release-please supports it via a dedicated branch (e.g. `next`) with its own
`release-please-config.json` setting `"prerelease": true` and `"prerelease-type": "beta"`,
plus a second workflow trigger on that branch. The `release.yml` publish steps would gate
prerelease tags to `gh release create --prerelease`. The tag ruleset pattern would widen
to `^v\d+\.\d+\.\d+(-(alpha|beta)\.\d+)?$`. Deliberately omitted now: it reintroduces a
manual "which channel" decision and a second maintained branch, which is exactly the
overhead the "automatic on merge to master" goal is trying to remove.

---

## File change summary

**New**

- `.github/workflows/release.yml` (replaces the current one)
- `.github/dependabot.yml`
- `.github/CODEOWNERS`
- `release-please-config.json`
- `.release-please-manifest.json`
- `commitlint.config.js`
- `.githooks/commit-msg`
- `SECURITY.md`
- `docs/release-pipeline-plan.md` (this file)

**Changed**

- `.github/workflows/ci.yml` (triggers, `--ignore-scripts`, harden-runner, `commitlint` + `pr-title` jobs)
- `install.sh` (checksum + attestation verification on top of existing hardening)
- `tsup.config.ts` (already changed in the working tree: `noExternal` from `dependencies`)
- `package.json` (add `@commitlint/config-conventional`; remove `deploy` script)
- `README.md`, `CONTRIBUTING.md`, `docs/releasing.md`

**Removed**

- `scripts/deploy.ts`
- the tag-triggered logic in the old `release.yml`

**Untouched**

- `plan.md` and everything it governs (reconciler, CLI design)
- `src/**`, `test/**`, `assets/**`

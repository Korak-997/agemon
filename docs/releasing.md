# Releasing agemon

This document describes the complete release process for this repository, including:

- prerelease channels (`alpha`, `beta`, `rc`)
- stable releases (`vX.Y.Z`)
- manual `CHANGELOG.md` maintenance
- automated GitHub Release publishing through GitHub Actions
- CI guards that prevent incomplete releases

`agemon` is distributed as a self-contained tarball attached to GitHub Releases and
installed via `install.sh` (`curl | sh`). It is **not** published to the npm registry.

## Release model

This repository releases only from Git tags. Merging to `master` alone does not release.

Allowed tag formats:

- `vX.Y.Z-alpha.N`
- `vX.Y.Z-beta.N`
- `vX.Y.Z-rc.N`
- `vX.Y.Z`

Examples:

- `v0.2.0-alpha.0`
- `v0.2.0-beta.1`
- `v0.2.0`

Channel mapping to GitHub Release flags:

- `*-alpha.*` / `*-beta.*` / `*-rc.*` -> marked as a **prerelease** on GitHub
- stable (`X.Y.Z`) -> a regular (latest) release

## Tooling in this repo

- GitHub workflow: `.github/workflows/release.yml`
- `npm pack` (packages `bin/`, `dist/`, `package.json`, `LICENSE`, `README.md` per the
  `"files"` field in `package.json`) — this produces the tarball, it does not publish
  anywhere.
- `gh release create` (GitHub CLI, preinstalled on GitHub-hosted runners) — attaches the
  release assets to a GitHub Release for the pushed tag.
- `actions/attest-build-provenance` — signs a build-provenance attestation for every file
  listed in `SHA256SUMS`.

The Release workflow runs in two jobs so that no repository or dependency code ever runs
with a write token:

- **`build`** (`contents: read`) — `npm ci`, lint, typecheck, test, build, smoke, the tag
  and changelog guards, then `npm pack`. It writes `SHA256SUMS` for `agemon.tgz` and
  `install.sh` and hands the three files to `publish` as an artifact, with the digest of
  `SHA256SUMS` as a job output.
- **`publish`** (`contents: write`, `id-token: write`, `attestations: write`) — no checkout
  and no `npm`. It checks the artifact against the build job's digest, runs
  `sha256sum -c`, attests, and creates the release.

`release.yml` is the trust anchor for attestations: `install.sh` and the README accept only
attestations signed by that workflow. A change to it deserves the same review as a change
to `install.sh`.

## How the changelog is maintained

There is no changelog-generation tool in this repo — `CHANGELOG.md` is maintained by hand.

Flow:

1. When you make a user-facing change, add or extend a `## X.Y.Z` section at the top of
   `CHANGELOG.md` describing it.
2. Bump `package.json`'s `"version"` to match when you're ready to release.
3. Commit both together.
4. Tag and push.
5. CI builds, verifies, and creates the GitHub Release from that tag.

Important:

- If `CHANGELOG.md` has no entry matching the tagged version, CI blocks the release.

## Maintainer release workflow

### Easiest path: one-click from GitHub Actions

For a stable `patch`/`minor`/`major` release, run the **Cut release** workflow
(`.github/workflows/cut-release.yml`) — nothing local required:

- GitHub UI: **Actions -> Cut release -> Run workflow**, pick `patch`/`minor`/`major`.
- CLI: `gh workflow run cut-release.yml -f bump=patch`

It runs in three jobs:

1. **`tag`** (`contents: read`, no credentials) checks out `master`, installs dependencies
   with `npm ci --ignore-scripts`, bumps `package.json`, drafts a `## X.Y.Z`
   `CHANGELOG.md` entry from the commit subjects since the last tag, then commits and tags
   (`npm run deploy -- … --no-push`). It hands the commit and tag to the next job as a
   `git bundle`.
2. **`push`** (`contents: write`) runs only `git`, in a fresh repository. It refuses the
   bundle unless it holds exactly one commit on top of the current `master`, the tag points
   at that commit, and the commit changes nothing but `package.json`, `package-lock.json`
   and `CHANGELOG.md`. Then it pushes both.
3. **`publish`** chains into the `Release` workflow to build, verify, and publish the
   GitHub Release.

No step that runs dependency code ever holds the write token.

Add a `## X.Y.Z` entry to `CHANGELOG.md` yourself beforehand if you want curated notes —
the workflow only auto-drafts one when the entry is missing.

Requires that `master` accepts pushes from `GITHUB_TOKEN` (no branch protection blocking
Actions). Prereleases (`alpha`/`beta`/`rc`) still use the manual steps below.

### Fast path: `npm run deploy`

For a stable `patch`/`minor`/`major` release, `npm run deploy` automates everything below:
it verifies you're on `master` with a clean working tree, syncs with `origin`, runs
`lint`/`typecheck`/`test`/`build`, prompts for the bump type (or takes it as an argument),
bumps `package.json`, checks `CHANGELOG.md` has a matching `## X.Y.Z` entry (reverting the
bump if not), then commits, tags, and pushes after a final confirmation.

```bash
npm run deploy                       # prompts for patch/minor/major
npm run deploy -- patch              # skip the prompt
npm run deploy -- patch --yes        # also skip the final confirmation
npm run deploy -- patch --skip-checks # skip local lint/typecheck/test/build (CI still runs them)
npm run deploy -- patch --no-push    # commit and tag locally, push yourself
```

Add the `CHANGELOG.md` entry for the version you intend to release *before* running this
— it aborts and reverts the version bump if the entry is missing.

This only covers stable releases from `master`. For `alpha`/`beta`/`rc` prereleases, use the
manual steps below.

### Manual steps (prereleases, or if you'd rather do it by hand)

#### 1. Sync and verify

```bash
git checkout master
git pull --ff-only
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

#### 2. Update version and changelog

Edit `package.json`'s `"version"` and add a matching `## X.Y.Z` section to the top of
`CHANGELOG.md` by hand. Then commit:

```bash
git add package.json CHANGELOG.md
git commit -m "release: X.Y.Z"
```

#### 3. Create release tag

Choose one of these paths. Tags must be **annotated** (`git tag -a`) — a lightweight tag
(`git tag v0.2.0` with no `-a`) is not pushed by `git push --follow-tags`, so the release
workflow would never see it. Push the tag explicitly by name rather than relying on
`--follow-tags` alone.

Alpha:

```bash
npm version 0.2.0-alpha.0 --no-git-tag-version
git add package.json
git commit -m "release: 0.2.0-alpha.0"
git tag -a v0.2.0-alpha.0 -m v0.2.0-alpha.0
git push origin master v0.2.0-alpha.0
```

Beta and release candidates: same as above with `0.2.0-beta.0` / `v0.2.0-beta.0` or
`0.2.0-rc.0` / `v0.2.0-rc.0`.

Stable:

```bash
npm version 0.2.0 --no-git-tag-version
git add package.json
git commit -m "release: 0.2.0"
git tag -a v0.2.0 -m v0.2.0
git push origin master v0.2.0
```

Note:

- The release workflow runs, and creates the GitHub Release, only when a matching tag is
  pushed.

## CI release guards

The release workflow validates all of the following before creating the GitHub Release:

1. Tag format is allowed: `vX.Y.Z`, `vX.Y.Z-alpha.N`, `vX.Y.Z-beta.N`, `vX.Y.Z-rc.N`.
2. Tag version equals `package.json` version.
3. `CHANGELOG.md` exists and contains an entry for the release version.
4. `lint`, `typecheck`, `test`, and `build` all pass.

If any check fails, the release is blocked and no GitHub Release is created.

## What gets published where

- **GitHub Release**: the tag, generated release notes, and three assets:
  - `agemon.tgz` — the package `install.sh` downloads;
  - `install.sh` — the installer for this exact release (the README one-liner and the
    CLI's self-update download it from here, not from `master`);
  - `SHA256SUMS` — SHA-256 of both, which `install.sh` and the self-update check before
    using either.
- **Build provenance attestations** for `agemon.tgz` and `install.sh`
  (`gh attestation verify`).

- **Nothing goes to the npm registry.** `npm pack` only builds a local tarball file; it
  never talks to `registry.npmjs.org`.

`install.sh` refuses a release that has no `SHA256SUMS`, so releases up to 4.7.2 can no
longer be installed with it.

## Rolling out installer changes

`master/install.sh` is still what clients up to 4.7.2 run when they self-update, and the
new installer refuses releases without `SHA256SUMS`. When a change to `install.sh` or the
release assets reaches `master`, run **Cut release** straight after the merge. Until that
release is published, installs and self-updates abort with a clear message instead of
installing. The new README URL (`releases/latest/download/install.sh`) also needs that
first release to exist.

## Troubleshooting

### Error: unsupported tag format

Cause:

- Tag does not match allowed patterns.

Fix:

- Use `vX.Y.Z`, `vX.Y.Z-alpha.N`, `vX.Y.Z-beta.N`, or `vX.Y.Z-rc.N`.

### Error: tag version does not match package.json version

Cause:

- Tag and version drifted.

Fix:

- Align `package.json`'s `"version"` with the tag you intend to push, or retag to match
  the committed version.

### Error: missing changelog entry

Cause:

- `CHANGELOG.md` was not updated with a `## X.Y.Z` section before tagging.

Fix:

```bash
# add the missing "## X.Y.Z" section to CHANGELOG.md, then:
git add CHANGELOG.md
git commit -m "release: update changelog for X.Y.Z"
# delete the bad tag locally/remotely if it was already pushed, then re-tag and push
```

## Optional: verify a release

```bash
gh release view vX.Y.Z --repo Korak-997/agemon
cd "$(mktemp -d)"
gh release download vX.Y.Z --repo Korak-997/agemon
sha256sum -c SHA256SUMS
gh attestation verify agemon.tgz --repo Korak-997/agemon \
  --signer-workflow Korak-997/agemon/.github/workflows/release.yml --deny-self-hosted-runners
```

## Quick checklist

Before pushing a release tag:

1. Quality checks pass (`lint`, `typecheck`, `test`, `build`).
2. `package.json` version bumped and `CHANGELOG.md` updated by hand.
3. Both committed.
4. Correct tag/channel selected (`alpha`, `beta`, or stable).

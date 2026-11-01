# Releasing agemon

This document describes the complete release process for this repository, including:

- prerelease channels (`alpha`, `beta`, `rc`)
- stable releases (`vX.Y.Z`)
- manual `CHANGELOG.md` maintenance
- automated GitHub Release publishing through GitHub Actions
- CI guards that prevent incomplete releases

`agemon` is distributed as one self-contained tarball. It is attached to each GitHub
Release (installed by `install.sh`) and the same file is published to the npm registry
as `agemon` (installed by `npm install --global agemon`).

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
- `scripts/pack-release.sh` — runs `npm pack` (packages `bin/`, `dist/`, `assets/`,
  `package.json`, `LICENSE`, `README.md` per the `"files"` field in `package.json`), then
  removes `dependencies` from the packed `package.json`. tsup already bundles them, so
  `npm install agemon` fetches nothing beyond the checksummed tarball. `npm run smoke`
  packs through the same script and fails if the manifest still declares dependencies or
  install scripts.
- `gh release create` (GitHub CLI, preinstalled on GitHub-hosted runners) — attaches the
  release assets to a GitHub Release for the pushed tag.
- `actions/attest-build-provenance` — signs a build-provenance attestation for every file
  listed in `SHA256SUMS`.

The Release workflow runs in three jobs so that no repository or dependency code ever runs
with a write token:

- **`build`** (`contents: read`) — `npm ci`, lint, typecheck, test, build, smoke, the tag
  and changelog guards, then `npm pack`. It writes `SHA256SUMS` for `agemon.tgz` and
  `install.sh` and hands the three files to `publish` as an artifact, with the digest of
  `SHA256SUMS` as a job output.
- **`publish`** (`contents: write`, `id-token: write`, `attestations: write`) — no checkout
  and no `npm`. It checks the artifact against the build job's digest, runs
  `sha256sum -c`, attests, and creates the release.
- **`npm`** (`contents: read`, `id-token: write`, environment `npm`) — no checkout and no
  dependency install. It downloads `agemon.tgz` and `SHA256SUMS` **from the GitHub
  Release**, checks `SHA256SUMS` against the build job's digest and the tarball against
  `SHA256SUMS`, requires npm ≥ 11.5.1, picks the dist-tag (`next` for `-alpha/-beta/-rc`,
  otherwise `latest`), refuses to move `latest` backwards, and runs
  `npm publish ./agemon.tgz` with npm trusted publishing (OIDC, no token; provenance is
  generated automatically). Because it reads from the Release, not from the one-day
  workflow artifact, a failed npm publish can be re-run with **Re-run failed jobs** at any
  time.

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

Before a stable release, re-record the website's terminal recordings so they show the
release's output: run `sh website/recordings/record.sh` and commit the new media, the
recorded ledger and `website/recordings/recordings.sha256` (see
[website/recordings/README.md](../website/recordings/README.md)).

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
2. **`push`** (`contents: write`) runs only `git` and `jq`, in a fresh repository. It
   refuses the bundle unless all of these hold:
   - it is a valid bundle with exactly one single-parent commit on top of the current
     `master`, and the tag points at that commit;
   - the commit modifies only `package.json`, `package-lock.json` and `CHANGELOG.md`, all
     still regular files;
   - the two manifests are identical apart from their `version` fields, and the version
     matches the tag;
   - `CHANGELOG.md` only gains lines.

   Then it pushes the commit and the tag.
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

### Bundled skill fingerprints

`src/plugins/skills/bundle-fingerprints.ts` lists the content fingerprint of every version
of a bundled skill agemon has shipped, so `status` can tell an unmodified older copy from a
user's edit. After changing a skill under `assets/skills/` or bumping the Essentials pin,
run `npm run skills:fingerprints` and commit the result in the same pull request:

- a unit test fails while a vendored skill's current fingerprint, or the pinned Essentials
  fingerprints, are missing;
- the `sandbox` CI job runs `npm run skills:fingerprints -- --check`, which recomputes the
  fingerprints of `assets/skills` at every `v*` tag and fails if any is missing.

The script only adds fingerprints; never remove one by hand, or users with that version
stop getting updates. Bumping the Essentials pin needs network access: the script uses the
cached `skills-src/<commit>` checkout only when its `HEAD` is exactly the pinned commit and
`git status --porcelain --ignored` is empty, and otherwise fetches the commit into a fresh
temporary directory. The pinned fingerprints are trusted as they are at generation time
(CI cannot re-check them without the network); the real-mode Docker check compares a real
Essentials install with them.

## What gets published where

- **GitHub Release**: the tag, generated release notes, and three assets:
  - `agemon.tgz` — the package `install.sh` downloads;
  - `install.sh` — the installer for this exact release (the README one-liner and the
    CLI's self-update download it from here, not from `master`);
  - `SHA256SUMS` — SHA-256 of both, which `install.sh` and the self-update check before
    using either.
- **Build provenance attestations** for `agemon.tgz` and `install.sh`
  (`gh attestation verify`).

- **npm**: `agemon@<version>` — the same `agemon.tgz` — under `latest`, or `next` for
  prereleases, with an npm provenance statement. If the `latest` guard refuses (a newer
  version already holds `latest`), that version stays off npm; an older version never
  takes `latest` after a newer one, and the GitHub Release stays the source of truth.

- **Website** (stable releases only): `release.yml` calls `website.yml`, which builds
  <https://agemon.korak-kurani.com> from the release tag and deploys it to GitHub Pages.
  The site serves that release's `install.sh` byte for byte. The build job checks the file
  against `SHA256SUMS` and its attestation before building. A separate verify job runs no
  npm and checks the built site again (the served `install.sh`, the displayed checksum,
  the install commands and every page's Content-Security-Policy) before deploying. To
  redeploy the latest release by hand, run the **Website** workflow from `master`.

`install.sh` refuses a release that has no `SHA256SUMS`, so releases up to 4.7.2 can no
longer be installed with it.

## One-time npm setup (owner)

Do this once, before the first release that publishes to npm. All values are
case-sensitive.

1. **GitHub environment `npm`** (Settings → Environments → New environment, name `npm`):
   - Required reviewers: the owner. GitHub enforces this whatever a workflow file says, so
     a modified workflow on a pushed tag or a dispatched branch still stops here.
   - Deployment branches and tags: "Selected branches and tags" → branch `master` (the
     **Cut release** caller) and tag pattern `v*` (tag pushes from `npm run deploy` or by
     hand).
2. **Tag ruleset** (Settings → Rules → Rulesets → New tag ruleset): target `v*`, restrict
   creation to the owner (and the Actions bot that **Cut release** pushes as).
3. **npm trusted publishers** (npmjs.com → `agemon` → Settings → Trusted publishing),
   two entries, both GitHub Actions with direct `npm publish` allowed:
   - organization/user `Korak-997`, repository `agemon`, workflow `cut-release.yml`,
     environment `npm`. npm checks the *calling* workflow's filename, and **Cut release**
     calls `release.yml` as a reusable workflow.
   - organization/user `Korak-997`, repository `agemon`, workflow `release.yml`,
     environment `npm`, for tags pushed by `npm run deploy` or by hand.
4. On npmjs.com, set the package's publishing access to "Require two-factor
   authentication and disallow tokens", so only the two workflows can publish.
5. Add `quality (node 22.x)` to the required status checks of the `master` branch ruleset.
6. After the first npm release, deprecate the old placeholder:
   `npm deprecate agemon@0.1.0 "use the latest agemon"`.

## One-time website setup (owner)

Do this before the first stable release that carries `website/` (v6). Until then the
website job fails at its first step that needs Pages, after npm has already published.

1. **Pages source** (Settings → Pages → Build and deployment): "GitHub Actions".
2. **`github-pages` environment** (created by step 1): deployment branches and tags →
   branch `master` (manual redeploys and **Cut release**) and tag pattern `v*` (tag pushes).
   Prereleases are kept off the site by the workflow itself.
3. **Custom domain**: verify `korak-kurani.com` under your account's Settings → Pages →
   Verified domains, so no other account can claim the subdomain. Add a DNS `CNAME`
   record `agemon` → `korak-997.github.io`, then set `agemon.korak-kurani.com` as the
   repository's custom domain and turn on "Enforce HTTPS".
4. **Domain hygiene** at the registrar: registrar lock, auto-renew, and a CAA record that
   allows only the CA GitHub Pages uses (`letsencrypt.org`).

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
2. Website recordings re-recorded for a stable release (`sh website/recordings/record.sh`).
3. `package.json` version bumped and `CHANGELOG.md` updated by hand.
4. All three committed.
5. Correct tag/channel selected (`alpha`, `beta`, or stable).

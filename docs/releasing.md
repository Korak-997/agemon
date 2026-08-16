# Releasing agemon

This document describes the complete release process for this repository, including:

- prerelease channels (`alpha`, `beta`)
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
- `vX.Y.Z`

Examples:

- `v0.2.0-alpha.0`
- `v0.2.0-beta.1`
- `v0.2.0`

Channel mapping to GitHub Release flags:

- `*-alpha.*` / `*-beta.*` -> marked as a **prerelease** on GitHub
- stable (`X.Y.Z`) -> a regular (latest) release

## Tooling in this repo

- GitHub workflow: `.github/workflows/release.yml`
- `npm pack` (packages `bin/`, `dist/`, `package.json`, `LICENSE`, `README.md` per the
  `"files"` field in `package.json`) — this produces the tarball, it does not publish
  anywhere.
- `gh release create` (GitHub CLI, preinstalled on GitHub-hosted runners) — attaches the
  tarball to a GitHub Release for the pushed tag.

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

### 1. Sync and verify

```bash
git checkout master
git pull --ff-only
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

### 2. Update version and changelog

Edit `package.json`'s `"version"` and add a matching `## X.Y.Z` section to the top of
`CHANGELOG.md` by hand. Then commit:

```bash
git add package.json CHANGELOG.md
git commit -m "release: X.Y.Z"
```

### 3. Create release tag

Choose one of these paths.

Alpha:

```bash
npm version 0.2.0-alpha.0 --no-git-tag-version
git add package.json
git commit -m "release: 0.2.0-alpha.0"
git tag v0.2.0-alpha.0
git push origin master --follow-tags
```

Beta: same as above with `0.2.0-beta.0` / `v0.2.0-beta.0`.

Stable:

```bash
npm version 0.2.0 --no-git-tag-version
git add package.json
git commit -m "release: 0.2.0"
git tag v0.2.0
git push origin master --follow-tags
```

Note:

- The release workflow runs, and creates the GitHub Release, only when a matching tag is
  pushed.

## CI release guards

The release workflow validates all of the following before creating the GitHub Release:

1. Tag format is allowed: `vX.Y.Z`, `vX.Y.Z-alpha.N`, `vX.Y.Z-beta.N`.
2. Tag version equals `package.json` version.
3. `CHANGELOG.md` exists and contains an entry for the release version.
4. `lint`, `typecheck`, `test`, and `build` all pass.

If any check fails, the release is blocked and no GitHub Release is created.

## What gets published where

- **GitHub Release**: the tag, generated release notes, and the `agemon.tgz` asset that
  `install.sh` downloads.
- **Nothing goes to the npm registry.** `npm pack` only builds a local tarball file; it
  never talks to `registry.npmjs.org`.

## Troubleshooting

### Error: unsupported tag format

Cause:

- Tag does not match allowed patterns.

Fix:

- Use `vX.Y.Z`, `vX.Y.Z-alpha.N`, or `vX.Y.Z-beta.N`.

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
curl -fsSL https://github.com/Korak-997/agemon/releases/download/vX.Y.Z/agemon.tgz -o /tmp/agemon.tgz
```

## Quick checklist

Before pushing a release tag:

1. Quality checks pass (`lint`, `typecheck`, `test`, `build`).
2. `package.json` version bumped and `CHANGELOG.md` updated by hand.
3. Both committed.
4. Correct tag/channel selected (`alpha`, `beta`, or stable).

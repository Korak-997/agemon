# Website recordings

The home page's "See it run" videos (`website/public/media/*.webm`, with a `.png` poster
each), the ledger panel's data (`website/src/data/recorded-ledger.json`) and the README's GIF
(`docs/demo/agemon.gif`, written by the roundtrip recording) are recorded from the real agemon
CLI with [vhs](https://github.com/charmbracelet/vhs):

```bash
sh website/recordings/record.sh                     # all three recordings
sh website/recordings/record.sh failure-and-rollback # just one
```

Re-record before every stable release (`docs/releasing.md`), then review the videos and
commit them together with `recordings.sha256`.

## What runs

- Each recording runs in the sandbox (`npm run sandbox -- prepare`): a copy of
  `test/fixtures/clean-repo` with the fake backends. The files agemon writes in the repository
  are real; pipx, npm, the skills CLI and the background service are simulated, so nothing on
  your machine changes.
- `record.sh` builds the CLI, then builds the image in `Dockerfile`: the digest-pinned vhs
  image plus one exact git version from the Debian snapshot that image was built from. That
  build is the only step that needs the network.
- The recording container runs as your user, with no network, no capabilities, a read-only
  root file system and memory and process limits. The repository's `bin/`, `dist/`, `assets/`
  and `package.json`, your Node installation and the tapes are mounted read-only. The only
  writable mounts are the run directory and the output directory, both under
  `${XDG_CACHE_HOME:-~/.cache}/agemon-recordings/`, outside the repository; that directory is
  deleted afterwards.
- A tape fails when a hidden setup step fails or a check after a visible command does not
  hold (for example, `git status` not empty after `agemon nuke`). Its own media are then not
  copied, but recordings that finished before it already were, and `recordings.sha256` is not
  rewritten, so `npm test` fails until every recording succeeds in one run.
- Only regular files (no symlinks) with the right WebM/PNG/GIF signature and under the size
  cap (3 MiB per video, 512 KiB per poster, 4 MiB for the GIF, 1 MiB for the ledger) are copied
  out, and never onto a symlink.

## Requirements

Docker, and a self-contained Node 22.12+ on the host (nvm or the official tarball; a
distro-packaged `/usr/bin/node` is refused because the container mounts Node's install
directory).

## `recordings.sha256`

`record.sh` writes the hash of every input (`Dockerfile`, `record.sh`, the tapes) and every
output. `npm test` fails when one of them changes without a new recording. This is a drift
check, not proof of where the media came from: only maintainers re-record, and media from
outside contributors is not merged.

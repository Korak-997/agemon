#!/usr/bin/env sh
# The published tarball carries no "dependencies": tsup already inlines them, and leaving
# them in would make `npm install agemon` fetch unpinned code the release checksums
# and attestation don't cover.
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: sh scripts/pack-release.sh <output.tgz>" >&2
  exit 1
fi
OUTPUT_PATH="$1"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

npm pack --loglevel=warn --pack-destination "$WORK_DIR" >/dev/null
tar -xzf "$WORK_DIR"/agemon-*.tgz -C "$WORK_DIR"
rm "$WORK_DIR"/agemon-*.tgz

(
  cd "$WORK_DIR/package"
  npm pkg delete dependencies optionalDependencies peerDependencies bundleDependencies bundledDependencies
  npm pack --loglevel=warn --ignore-scripts --pack-destination "$WORK_DIR" >/dev/null
)
mv "$WORK_DIR"/agemon-*.tgz "$OUTPUT_PATH"

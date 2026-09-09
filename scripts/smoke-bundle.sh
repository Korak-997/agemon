#!/usr/bin/env sh
set -eu

EXPECTED_VERSION="$(node -p "require('./package.json').version")"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

npm pack --pack-destination "$WORK_DIR" >/dev/null
tar -xzf "$WORK_DIR"/agemon-*.tgz -C "$WORK_DIR" --strip-components=1

ACTUAL_VERSION="$(cd "$WORK_DIR" && node bin/agemon.js --version)"

if [ "$ACTUAL_VERSION" != "$EXPECTED_VERSION" ]; then
  echo "Bundle smoke test FAILED: packaged CLI reported '${ACTUAL_VERSION}', expected '${EXPECTED_VERSION}'." >&2
  echo "dist/index.js likely has an unbundled bare import — confirm every package.json dependency is inlined by tsup." >&2
  exit 1
fi

echo "Bundle smoke test passed: packaged CLI runs standalone and reports ${ACTUAL_VERSION}."

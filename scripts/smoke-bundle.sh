#!/usr/bin/env sh
set -eu

EXPECTED_VERSION="$(node -p "require('./package.json').version")"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
export XDG_STATE_HOME="$WORK_DIR/state"

npm pack --pack-destination "$WORK_DIR" >/dev/null
tar -xzf "$WORK_DIR"/agemon-*.tgz -C "$WORK_DIR" --strip-components=1

ACTUAL_VERSION="$(cd "$WORK_DIR" && node bin/agemon.js --version)" || ACTUAL_VERSION="<crashed>"

if [ "$ACTUAL_VERSION" != "$EXPECTED_VERSION" ]; then
  echo "Bundle smoke test FAILED: packaged CLI reported '${ACTUAL_VERSION}', expected '${EXPECTED_VERSION}'." >&2
  echo "dist/index.js likely has an unbundled bare import — confirm every package.json dependency is inlined by tsup." >&2
  exit 1
fi

rm -rf "$WORK_DIR/assets/skills"
VERSION_WITHOUT_ASSETS="$(cd "$WORK_DIR" && node bin/agemon.js --version)" || VERSION_WITHOUT_ASSETS="<crashed>"

if [ "$VERSION_WITHOUT_ASSETS" != "$EXPECTED_VERSION" ]; then
  echo "Bundle smoke test FAILED: 'agemon --version' broke once assets/skills was removed (reported '${VERSION_WITHOUT_ASSETS}')." >&2
  echo "Vendored skill paths must resolve only when a skill group is installed, not at import." >&2
  exit 1
fi

echo "Bundle smoke test passed: packaged CLI runs standalone and reports ${ACTUAL_VERSION}, with or without assets/skills."

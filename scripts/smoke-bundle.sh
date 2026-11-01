#!/usr/bin/env sh
set -eu

EXPECTED_VERSION="$(node -p "require('./package.json').version")"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
export XDG_STATE_HOME="$WORK_DIR/state"

sh scripts/pack-release.sh "$WORK_DIR/agemon.tgz"
tar -xzf "$WORK_DIR/agemon.tgz" -C "$WORK_DIR" --strip-components=1

INSTALL_TIME_FIELDS="$(node - "$WORK_DIR/package.json" <<'NODE'
const manifest = require(process.argv[2]);
const fetchedFields = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "bundleDependencies",
  "bundledDependencies",
];
const installScripts = ["preinstall", "install", "postinstall", "prepare"];
const declared = [
  ...fetchedFields.filter((field) => manifest[field]),
  ...installScripts.filter((name) => manifest.scripts?.[name]),
];
process.stdout.write(declared.join(" "));
NODE
)"

if [ -n "$INSTALL_TIME_FIELDS" ]; then
  echo "Bundle smoke test FAILED: the packed package.json still declares: ${INSTALL_TIME_FIELDS}." >&2
  echo "npm would fetch or run that at install time, outside what the release checksums cover; pack with scripts/pack-release.sh." >&2
  exit 1
fi

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

DEV_SWITCH_OUTPUT="$(cd "$WORK_DIR" && AGEMON_DEV=1 AGEMON_FAKE_SUBPROCESS=1 node bin/agemon.js --version 2>&1)" || true

case "$DEV_SWITCH_OUTPUT" in
  *"must never be set outside the sandbox harness"*) ;;
  *)
    echo "Bundle smoke test FAILED: the packaged CLI did not refuse AGEMON_DEV=1 with AGEMON_FAKE_SUBPROCESS=1 (output: '${DEV_SWITCH_OUTPUT}')." >&2
    echo "Dev-only switches must apply only in a source checkout (.git or src/ next to package.json)." >&2
    exit 1
    ;;
esac

echo "Bundle smoke test passed: packaged CLI runs standalone, declares no install-time dependencies, reports ${ACTUAL_VERSION} with or without assets/skills, and refuses the dev-only switches."

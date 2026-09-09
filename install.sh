#!/usr/bin/env sh
set -eu

MIN_NODE_MAJOR=24
REPO="Korak-997/agemon"
BIN_NAME="agemon"
LATEST_RELEASE_API_URL="https://api.github.com/repos/${REPO}/releases/latest"

STAGE_SIBLING=""
WORK_DIR=""

print_error() {
  printf '%s\n' "$1" >&2
}

print_info() {
  printf '%s\n' "$1"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    print_error "$1 is required but was not found on PATH."
    exit 1
  fi
}

fetch() {
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    curl -fsSL --connect-timeout 15 --retry 2 --retry-delay 1 \
      -H 'Cache-Control: no-cache' -H 'Pragma: no-cache' \
      -H "Authorization: Bearer ${GITHUB_TOKEN}" "$@"
  else
    curl -fsSL --connect-timeout 15 --retry 2 --retry-delay 1 \
      -H 'Cache-Control: no-cache' -H 'Pragma: no-cache' "$@"
  fi
}

canonical_path() {
  if [ -z "$1" ]; then
    return 0
  fi
  readlink -f "$1" 2>/dev/null || printf '%s' "$1"
}

cleanup() {
  [ -n "$WORK_DIR" ] && rm -rf "$WORK_DIR"
  [ -n "$STAGE_SIBLING" ] && rm -rf "$STAGE_SIBLING"
  return 0
}

require_command curl
require_command tar

if ! command -v node >/dev/null 2>&1; then
  print_error "Node.js is required but was not found on PATH."
  print_error "Install Node.js ${MIN_NODE_MAJOR}+ from https://nodejs.org/ or via nvm/fnm, then retry."
  exit 1
fi

NODE_VERSION_RAW="$(node --version 2>/dev/null || true)"
NODE_VERSION_TRIMMED="${NODE_VERSION_RAW#v}"
NODE_MAJOR="${NODE_VERSION_TRIMMED%%.*}"

case "$NODE_MAJOR" in
  "" | *[!0-9]*)
    print_error "Unable to parse Node.js version from: ${NODE_VERSION_RAW}"
    print_error "Expected Node.js ${MIN_NODE_MAJOR}+"
    exit 1
    ;;
esac

if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
  print_error "Node.js version is too old: ${NODE_VERSION_RAW}"
  print_error "Required: Node.js ${MIN_NODE_MAJOR}+"
  exit 1
fi

print_info "Node.js ${NODE_VERSION_RAW} detected."

REQUESTED_VERSION="${AGEMON_VERSION:-latest}"
RESOLVED_VERSION=""

if [ "$REQUESTED_VERSION" != "latest" ]; then
  RESOLVED_VERSION="${REQUESTED_VERSION#v}"
  print_info "Installing requested agemon version ${RESOLVED_VERSION}."
else
  print_info "Resolving the latest agemon release..."
  if RELEASE_JSON="$(fetch --max-time 20 "$LATEST_RELEASE_API_URL" 2>/dev/null)"; then
    RAW_TAG="$(printf '%s' "$RELEASE_JSON" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
    RESOLVED_VERSION="${RAW_TAG#v}"
  fi
  if [ -n "$RESOLVED_VERSION" ]; then
    print_info "Latest release is ${RESOLVED_VERSION}."
  else
    print_error "Could not resolve the latest release from the GitHub API; falling back to the 'latest' download alias."
    print_error "That alias can lag a fresh release by a few minutes, so re-run this installer if the version below looks stale."
  fi
fi

if [ -n "$RESOLVED_VERSION" ]; then
  DOWNLOAD_URL="https://github.com/${REPO}/releases/download/v${RESOLVED_VERSION}/agemon.tgz"
else
  DOWNLOAD_URL="https://github.com/${REPO}/releases/latest/download/agemon.tgz"
fi

if [ -n "${AGEMON_INSTALL_DIR:-}" ]; then
  INSTALL_DIR="$AGEMON_INSTALL_DIR"
  BIN_DIR="$AGEMON_INSTALL_DIR/bin-link"
elif [ "$(id -u)" -eq 0 ]; then
  INSTALL_DIR="/usr/local/lib/agemon"
  BIN_DIR="/usr/local/bin"
else
  INSTALL_DIR="$HOME/.local/share/agemon"
  BIN_DIR="$HOME/.local/bin"
fi

WORK_DIR="$(mktemp -d)"
trap cleanup EXIT

TARBALL_PATH="$WORK_DIR/agemon.tgz"
STAGING_DIR="$WORK_DIR/stage"
mkdir -p "$STAGING_DIR"

print_info "Downloading agemon from ${DOWNLOAD_URL}..."
if ! fetch "$DOWNLOAD_URL" -o "$TARBALL_PATH"; then
  print_error "Failed to download agemon from ${DOWNLOAD_URL}"
  print_error "Set AGEMON_VERSION to a published release tag (e.g. 3.0.0) if 'latest' is unavailable."
  exit 1
fi

if ! tar -xzf "$TARBALL_PATH" -C "$STAGING_DIR" --strip-components=1; then
  print_error "Downloaded archive could not be extracted; it may be truncated or corrupt. Re-run the installer."
  exit 1
fi

if [ ! -f "$STAGING_DIR/package.json" ] || [ ! -f "$STAGING_DIR/bin/agemon.js" ]; then
  print_error "Downloaded archive is missing expected files (package.json / bin/agemon.js)."
  exit 1
fi

PACKAGE_VERSION="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version || ""))' "$STAGING_DIR/package.json" 2>/dev/null || true)"
if [ -z "$PACKAGE_VERSION" ]; then
  print_error "Could not read a version from the downloaded package.json."
  exit 1
fi

if [ -n "$RESOLVED_VERSION" ] && [ "$PACKAGE_VERSION" != "$RESOLVED_VERSION" ]; then
  print_error "Version mismatch: expected agemon ${RESOLVED_VERSION} but the downloaded archive is ${PACKAGE_VERSION}."
  print_error "This is almost always a stale CDN or proxy cache of the release asset."
  print_error "Retry in a few minutes, or pin the version: AGEMON_VERSION=${RESOLVED_VERSION} sh install.sh"
  exit 1
fi
EXPECTED_VERSION="${RESOLVED_VERSION:-$PACKAGE_VERSION}"

STAGED_VERSION="$(node "$STAGING_DIR/bin/agemon.js" --version 2>/dev/null || true)"
if [ "$STAGED_VERSION" != "$EXPECTED_VERSION" ]; then
  print_error "The downloaded agemon ${EXPECTED_VERSION} does not run: it reports '${STAGED_VERSION:-<nothing>}'."
  print_error "The release archive is truncated, stale, or missing a bundled dependency."
  print_error "Try again shortly; if it keeps failing, this release is broken — open an issue at https://github.com/${REPO}/issues."
  print_error "Nothing was changed on your machine."
  exit 1
fi

STAGE_SIBLING="${INSTALL_DIR}.tmp-$$"
mkdir -p "$(dirname "$INSTALL_DIR")"
rm -rf "$STAGE_SIBLING"
mv "$STAGING_DIR" "$STAGE_SIBLING"
rm -rf "$INSTALL_DIR"
mv "$STAGE_SIBLING" "$INSTALL_DIR"
STAGE_SIBLING=""

mkdir -p "$BIN_DIR"
chmod +x "$INSTALL_DIR/bin/agemon.js"
ln -sf "$INSTALL_DIR/bin/agemon.js" "$BIN_DIR/$BIN_NAME"

print_info "Installed agemon ${EXPECTED_VERSION} to ${INSTALL_DIR}"
print_info "Linked ${BIN_DIR}/${BIN_NAME}"

INSTALLED_VERSION="$(node "$INSTALL_DIR/bin/agemon.js" --version 2>/dev/null || true)"
if [ "$INSTALLED_VERSION" != "$EXPECTED_VERSION" ]; then
  print_error "Post-install check failed: the installed binary reports '${INSTALLED_VERSION:-<none>}', expected '${EXPECTED_VERSION}'."
  print_error "The files under ${INSTALL_DIR} may be partially written. Re-run the installer."
  exit 1
fi

BIN_DIR_ON_PATH=0
case ":$PATH:" in
  *":$BIN_DIR:"*) BIN_DIR_ON_PATH=1 ;;
  *)
    print_info ""
    print_info "${BIN_DIR} is not on your PATH. Add this to your shell profile:"
    print_info "  export PATH=\"${BIN_DIR}:\$PATH\""
    ;;
esac

NEW_LINK="$BIN_DIR/$BIN_NAME"

hash -r 2>/dev/null || true
RESOLVED_ON_PATH="$(command -v "$BIN_NAME" 2>/dev/null || true)"

if [ "$BIN_DIR_ON_PATH" -eq 1 ] && [ -n "$RESOLVED_ON_PATH" ] && \
  [ "$(canonical_path "$RESOLVED_ON_PATH")" != "$(canonical_path "$NEW_LINK")" ]; then
  print_info ""
  print_error "WARNING: '${BIN_NAME}' on your PATH resolves to:"
  print_error "    ${RESOLVED_ON_PATH}"
  print_error "not the copy just installed at:"
  print_error "    ${NEW_LINK}"
  print_error "The older install will keep winning until you remove it:"
  case "$RESOLVED_ON_PATH" in
    /usr/local/*)
      print_error "    sudo rm -rf /usr/local/lib/agemon /usr/local/bin/${BIN_NAME}"
      ;;
    "$HOME"/.local/*)
      print_error "    rm -rf ${HOME}/.local/share/agemon ${HOME}/.local/bin/${BIN_NAME}"
      ;;
    *)
      print_error "    rm -f ${RESOLVED_ON_PATH}"
      ;;
  esac
  print_error "Then open a new shell and re-check with '${BIN_NAME} --version'."
  exit 1
fi

print_info ""
print_info "agemon ${INSTALLED_VERSION} installed successfully."
print_info "If this shell still reports an older version, run 'hash -r' or open a new shell."
print_info "Run '${BIN_NAME} --help' to get started."

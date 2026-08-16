#!/usr/bin/env sh
set -eu

MIN_NODE_MAJOR=24
REPO="Korak-997/agemon"
BIN_NAME="agemon"

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

VERSION="${AGEMON_VERSION:-latest}"
if [ "$VERSION" = "latest" ]; then
  DOWNLOAD_URL="https://github.com/${REPO}/releases/latest/download/agemon.tgz"
else
  DOWNLOAD_URL="https://github.com/${REPO}/releases/download/v${VERSION}/agemon.tgz"
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

print_info "Node.js ${NODE_VERSION_RAW} detected."
print_info "Downloading agemon (${VERSION}) from ${DOWNLOAD_URL}..."

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

TARBALL_PATH="$WORK_DIR/agemon.tgz"
if ! curl -fsSL "$DOWNLOAD_URL" -o "$TARBALL_PATH"; then
  print_error "Failed to download agemon from ${DOWNLOAD_URL}"
  print_error "Set AGEMON_VERSION to a published release tag (e.g. 0.1.0) if 'latest' is unavailable."
  exit 1
fi

rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
tar -xzf "$TARBALL_PATH" -C "$INSTALL_DIR" --strip-components=1

mkdir -p "$BIN_DIR"
chmod +x "$INSTALL_DIR/bin/agemon.js"
ln -sf "$INSTALL_DIR/bin/agemon.js" "$BIN_DIR/$BIN_NAME"

print_info "Installed agemon to ${INSTALL_DIR}"
print_info "Linked ${BIN_DIR}/${BIN_NAME}"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    print_info ""
    print_info "${BIN_DIR} is not on your PATH. Add this to your shell profile:"
    print_info "  export PATH=\"${BIN_DIR}:\$PATH\""
    ;;
esac

if command -v "$BIN_NAME" >/dev/null 2>&1; then
  print_info ""
  print_info "$("$BIN_NAME" --version) installed successfully. Run '${BIN_NAME} --help' to get started."
else
  "$INSTALL_DIR/bin/agemon.js" --version
fi

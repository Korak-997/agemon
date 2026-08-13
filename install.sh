#!/usr/bin/env sh
set -eu

MIN_NODE_MAJOR=24

print_error() {
  printf '%s\n' "$1" >&2
}

if ! command -v node >/dev/null 2>&1; then
  print_error "Node.js is required but was not found on PATH."
  print_error "Install Node.js ${MIN_NODE_MAJOR}+ from https://nodejs.org/ or via nvm/fnm, then retry."
  exit 1
fi

if ! command -v npx >/dev/null 2>&1; then
  print_error "npx is required but was not found on PATH."
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

printf '%s\n' "Node.js ${NODE_VERSION_RAW} detected. Running agemon installer..."
exec npx agemon@latest install "$@"

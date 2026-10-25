#!/usr/bin/env sh
# The body lives in main(), called on the last line, so a truncated
# `curl | sh` download defines a partial function and runs nothing.
set -eu

MIN_NODE_MAJOR=22
MIN_NODE_MINOR=12
REPO="Korak-997/agemon"
BIN_NAME="agemon"
LATEST_RELEASE_API_URL="https://api.github.com/repos/${REPO}/releases/latest"
RELEASES_URL="https://github.com/${REPO}/releases"
SIGNER_WORKFLOW="${REPO}/.github/workflows/release.yml"
INSTALL_MARKER=".agemon-install"
MAX_VERSION_LENGTH=64

WORK_DIR=""
STAGE_DIR=""
ASIDE_DIR=""
INSTALL_DIR=""
SWAP_COMPLETED=0

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
  curl -fsSL --connect-timeout 15 --retry 2 --retry-delay 1 \
    -H 'Cache-Control: no-cache' -H 'Pragma: no-cache' "$@"
}

fetch_github_api() {
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    printf 'header = "Authorization: Bearer %s"\n' "$GITHUB_TOKEN" | fetch --config - "$@"
  else
    fetch "$@"
  fi
}

canonical_path() {
  if [ -z "$1" ]; then
    return 0
  fi
  readlink -f "$1" 2>/dev/null || printf '%s' "$1"
}

is_release_version() {
  case "$1" in
    "" | *[!0-9A-Za-z.-]*) return 1 ;;
  esac
  [ "${#1}" -le "$MAX_VERSION_LENGTH" ] || return 1
  printf '%s\n' "$1" | grep -Eqx 'v?[0-9]+\.[0-9]+\.[0-9]+(-(alpha|beta|rc)\.[0-9]+)?'
}

normalize_absolute_path() {
  case "$1" in
    /*) ;;
    *) return 1 ;;
  esac
  normalized_path="$(printf '%s' "$1" | tr -s '/')"
  case "${normalized_path}/" in
    */./* | */../*) return 1 ;;
  esac
  if [ "$normalized_path" != "/" ]; then
    normalized_path="${normalized_path%/}"
  fi
  printf '%s' "$normalized_path"
}

physical_directory() {
  (cd -P "$1" 2>/dev/null && pwd -P)
}

resolve_physical_path() {
  existing_ancestor="$1"
  missing_suffix=""
  while [ ! -d "$existing_ancestor" ]; do
    missing_suffix="/$(basename "$existing_ancestor")${missing_suffix}"
    existing_ancestor="$(dirname "$existing_ancestor")"
  done
  ancestor_physical="$(physical_directory "$existing_ancestor")" || return 1
  physical_path="${ancestor_physical%/}${missing_suffix}"
  printf '%s' "${physical_path:-/}"
}

is_protected_directory() {
  resolve_physical_path "$HOME" >/dev/null || return 0
  for protected_path in / /bin /etc /home /opt /usr /usr/bin /usr/local /usr/local/bin /var \
    "$HOME" "${HOME}/.local" "${HOME}/.local/share"; do
    physical_protected_path="$(resolve_physical_path "$protected_path")" || continue
    if [ "$1" = "$physical_protected_path" ]; then
      return 0
    fi
  done
  return 1
}

read_package_field() {
  node -e 'const [file, field] = process.argv.slice(1); process.stdout.write(String(JSON.parse(require("fs").readFileSync(file, "utf8"))[field] ?? ""))' "$1" "$2" 2>/dev/null || true
}

is_default_install_dir() {
  physical_candidate="$(resolve_physical_path "$1")" || return 1
  for default_install_dir in /usr/local/lib/agemon "${HOME}/.local/share/agemon"; do
    physical_default="$(resolve_physical_path "$default_install_dir")" || continue
    if [ "$physical_candidate" = "$physical_default" ]; then
      return 0
    fi
  done
  return 1
}

links_to_own_entrypoint() {
  bin_link="$1/bin-link/${BIN_NAME}"
  [ -L "$bin_link" ] || return 1
  link_target="$(readlink "$bin_link")"
  [ "$(basename "$link_target")" = "agemon.js" ] || return 1
  link_target_dir="$(dirname "$link_target")"
  case "$link_target_dir" in
    /*) ;;
    *) link_target_dir="$1/bin-link/${link_target_dir}" ;;
  esac
  link_target_physical="$(physical_directory "$link_target_dir")" || return 1
  [ "$link_target_physical" = "$(physical_directory "$1/bin")" ]
}

looks_like_source_tree() {
  [ -e "$1/.git" ] || [ -e "$1/src" ] || [ -e "$1/node_modules" ]
}

is_legacy_install() {
  [ -f "$1/bin/agemon.js" ] && [ -f "$1/package.json" ] || return 1
  [ "$(read_package_field "$1/package.json" name)" = "agemon" ] || return 1
  is_default_install_dir "$1" || links_to_own_entrypoint "$1"
}

refuse_install_dir() {
  print_error "Refusing to install into ${INSTALL_DIR}: $1"
  print_error "Nothing was changed. Set AGEMON_INSTALL_DIR to a new or empty directory, or one a previous agemon install created."
  exit 1
}

assert_install_dir_is_replaceable() {
  if [ -L "$INSTALL_DIR" ]; then
    print_error "Refusing to install into ${INSTALL_DIR}: the install dir is a symlink."
    print_error "Point AGEMON_INSTALL_DIR at its target instead: $(physical_directory "$INSTALL_DIR" || printf '%s' "$INSTALL_DIR")"
    exit 1
  fi
  if ! physical_install_dir="$(resolve_physical_path "$INSTALL_DIR")"; then
    refuse_install_dir "its location cannot be resolved."
  fi
  if is_protected_directory "$physical_install_dir"; then
    refuse_install_dir "it is a system or home directory."
  fi
  [ -e "$INSTALL_DIR" ] || return 0
  if [ ! -d "$INSTALL_DIR" ]; then
    refuse_install_dir "it exists and is not a directory."
  fi
  if [ ! -r "$INSTALL_DIR" ] || [ ! -x "$INSTALL_DIR" ] ||
    ! install_dir_entries="$(ls -A "$INSTALL_DIR")"; then
    refuse_install_dir "its contents cannot be read."
  fi
  if [ -z "$install_dir_entries" ]; then
    return 0
  fi
  if looks_like_source_tree "$INSTALL_DIR"; then
    refuse_install_dir "it looks like a source checkout (.git, src or node_modules), not an install."
  fi
  if [ -f "${INSTALL_DIR}/${INSTALL_MARKER}" ] || is_legacy_install "$INSTALL_DIR"; then
    return 0
  fi
  if [ -f "${INSTALL_DIR}/bin/agemon.js" ]; then
    refuse_install_dir "it looks like an older agemon install, but its origin cannot be confirmed. If it is one, remove it by hand and re-run."
  fi
  refuse_install_dir "it is not empty and was not created by the agemon installer."
}

select_sha256_command() {
  if command -v sha256sum >/dev/null 2>&1; then
    SHA256_COMMAND="sha256sum"
  elif command -v shasum >/dev/null 2>&1; then
    SHA256_COMMAND="shasum"
  else
    print_error "Neither sha256sum nor shasum was found on PATH; the download cannot be verified."
    exit 1
  fi
}

sha256_of_file() {
  if [ "$SHA256_COMMAND" = "sha256sum" ]; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}

read_expected_tarball_checksum() {
  tarball_line="$(tr -d '\r' <"$1" | awk '$NF == "agemon.tgz" || $NF == "*agemon.tgz" { count++; line = $0 } END { if (count == 1) print line }')"
  printf '%s\n' "$tarball_line" | grep -Eqx '[0-9a-f]{64}  agemon\.tgz' || return 1
  printf '%s' "${tarball_line%% *}"
}

restore_previous_install() {
  [ "$SWAP_COMPLETED" -eq 0 ] && [ -n "$ASIDE_DIR" ] && [ -e "${ASIDE_DIR}/previous" ] || return 0
  if [ -f "${INSTALL_DIR}/${INSTALL_MARKER}" ] && [ ! -e "${STAGE_DIR}" ]; then
    print_error "The new install is in place at ${INSTALL_DIR}; the previous one is kept at ${ASIDE_DIR}/previous and can be deleted."
    ASIDE_DIR=""
  elif [ ! -e "$INSTALL_DIR" ] && mv "${ASIDE_DIR}/previous" "$INSTALL_DIR"; then
    print_error "Restored the previous install at ${INSTALL_DIR}."
  else
    print_error "Could not restore the previous install. It is kept at ${ASIDE_DIR}/previous; move it back to ${INSTALL_DIR} by hand."
    ASIDE_DIR=""
  fi
}

cleanup() {
  restore_previous_install
  [ -n "$ASIDE_DIR" ] && rm -rf "$ASIDE_DIR"
  [ -n "$STAGE_DIR" ] && rm -rf "$STAGE_DIR"
  [ -n "$WORK_DIR" ] && rm -rf "$WORK_DIR"
  return 0
}

is_installer_created() {
  [ -d "$1" ] && [ ! -L "$1" ] && [ -f "$1/${INSTALL_MARKER}" ] && [ ! -L "$1/${INSTALL_MARKER}" ]
}

keep_previous_install() {
  PREVIOUS_DIR="${INSTALL_DIR}.prev"
  is_installer_created "${ASIDE_DIR}/previous" || return 0
  if [ -e "$PREVIOUS_DIR" ] || [ -L "$PREVIOUS_DIR" ]; then
    if ! is_installer_created "$PREVIOUS_DIR"; then
      print_info "Kept no rollback copy: ${PREVIOUS_DIR} exists and was not created by the agemon installer."
      return 0
    fi
    if ! mv "$PREVIOUS_DIR" "${ASIDE_DIR}/older"; then
      print_info "Kept no rollback copy: ${PREVIOUS_DIR} could not be replaced."
      return 0
    fi
  fi
  if [ -e "$PREVIOUS_DIR" ] || ! mv "${ASIDE_DIR}/previous" "$PREVIOUS_DIR"; then
    print_info "Kept no rollback copy: the previous install could not be moved to ${PREVIOUS_DIR}."
    return 0
  fi
  print_info "Kept the previous install at ${PREVIOUS_DIR}; 'agemon upgrade --rollback' switches back to it."
}

swap_into_place() {
  if [ -e "$INSTALL_DIR" ]; then
    ASIDE_DIR="$(mktemp -d "${INSTALL_DIR}.old-XXXXXX")"
    mv "$INSTALL_DIR" "${ASIDE_DIR}/previous"
  fi
  if [ -e "$INSTALL_DIR" ] || ! mv "$STAGE_DIR" "$INSTALL_DIR"; then
    print_error "Could not move the new install into ${INSTALL_DIR}."
    restore_previous_install
    exit 1
  fi
  SWAP_COMPLETED=1
  STAGE_DIR=""
  if [ -n "$ASIDE_DIR" ]; then
    keep_previous_install
    rm -rf "$ASIDE_DIR"
    ASIDE_DIR=""
  fi
}

main() {
  LC_ALL=C
  export LC_ALL

  require_command curl
  require_command tar

  if ! command -v node >/dev/null 2>&1; then
    print_error "Node.js is required but was not found on PATH."
    print_error "Install Node.js ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}+ from https://nodejs.org/ or via nvm/fnm, then retry."
    exit 1
  fi

  NODE_VERSION_RAW="$(node --version 2>/dev/null || true)"
  NODE_VERSION_TRIMMED="${NODE_VERSION_RAW#v}"
  NODE_MAJOR="${NODE_VERSION_TRIMMED%%.*}"
  NODE_MINOR_AND_REST="${NODE_VERSION_TRIMMED#*.}"
  NODE_MINOR="${NODE_MINOR_AND_REST%%.*}"

  case "${NODE_MAJOR}:${NODE_MINOR}" in
    :* | *: | *[!0-9:]*)
      print_error "Unable to parse Node.js version from: ${NODE_VERSION_RAW}"
      print_error "Expected Node.js ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}+"
      exit 1
      ;;
  esac

  if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ] ||
    { [ "$NODE_MAJOR" -eq "$MIN_NODE_MAJOR" ] && [ "$NODE_MINOR" -lt "$MIN_NODE_MINOR" ]; }; then
    print_error "Node.js version is too old: ${NODE_VERSION_RAW}"
    print_error "Required: Node.js ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}+"
    exit 1
  fi

  print_info "Node.js ${NODE_VERSION_RAW} detected."

  REQUESTED_VERSION="${AGEMON_VERSION:-latest}"
  if [ "$REQUESTED_VERSION" != "latest" ] && ! is_release_version "$REQUESTED_VERSION"; then
    print_error "AGEMON_VERSION is not a release version: ${REQUESTED_VERSION}"
    print_error "Use a release tag such as 4.8.0 or v4.8.0-rc.1, or leave it unset for the latest release."
    exit 1
  fi

  if [ -n "${AGEMON_INSTALL_DIR:-}" ]; then
    if ! INSTALL_DIR="$(normalize_absolute_path "$AGEMON_INSTALL_DIR")"; then
      print_error "AGEMON_INSTALL_DIR must be an absolute path without '.' or '..' components: ${AGEMON_INSTALL_DIR}"
      exit 1
    fi
    BIN_DIR="${INSTALL_DIR}/bin-link"
  elif [ "$(id -u)" -eq 0 ]; then
    INSTALL_DIR="/usr/local/lib/agemon"
    BIN_DIR="/usr/local/bin"
  else
    INSTALL_DIR="$HOME/.local/share/agemon"
    BIN_DIR="$HOME/.local/bin"
  fi
  assert_install_dir_is_replaceable

  select_sha256_command
  if [ "${AGEMON_VERIFY_ATTESTATION:-}" = "1" ] && ! command -v gh >/dev/null 2>&1; then
    print_error "AGEMON_VERIFY_ATTESTATION=1 needs the GitHub CLI (gh), logged in with 'gh auth login'. It was not found on PATH."
    exit 1
  fi

  RESOLVED_VERSION=""
  if [ "$REQUESTED_VERSION" != "latest" ]; then
    RESOLVED_VERSION="${REQUESTED_VERSION#v}"
    print_info "Installing requested agemon version ${RESOLVED_VERSION}."
  else
    print_info "Resolving the latest agemon release..."
    if RELEASE_JSON="$(fetch_github_api --max-time 20 "$LATEST_RELEASE_API_URL" 2>/dev/null)"; then
      RAW_TAG="$(printf '%s' "$RELEASE_JSON" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
      if [ -n "$RAW_TAG" ] && ! is_release_version "$RAW_TAG"; then
        print_error "The GitHub API returned an unexpected release tag; refusing to continue."
        exit 1
      fi
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
    RELEASE_ASSETS_URL="${RELEASES_URL}/download/v${RESOLVED_VERSION}"
  else
    RELEASE_ASSETS_URL="${RELEASES_URL}/latest/download"
  fi
  DOWNLOAD_URL="${RELEASE_ASSETS_URL}/agemon.tgz"

  trap cleanup EXIT
  trap 'exit 1' INT TERM HUP
  WORK_DIR="$(mktemp -d)"
  TARBALL_PATH="$WORK_DIR/agemon.tgz"
  CHECKSUMS_PATH="$WORK_DIR/SHA256SUMS"

  print_info "Downloading agemon from ${DOWNLOAD_URL}..."
  if ! fetch "$DOWNLOAD_URL" -o "$TARBALL_PATH"; then
    print_error "Failed to download agemon from ${DOWNLOAD_URL}"
    print_error "Set AGEMON_VERSION to a published release tag (e.g. 4.8.0) if 'latest' is unavailable."
    exit 1
  fi

  if ! fetch "${RELEASE_ASSETS_URL}/SHA256SUMS" -o "$CHECKSUMS_PATH"; then
    print_error "This release has no SHA256SUMS file, so its download cannot be verified."
    print_error "Releases published before checksums were introduced (4.7.2 and older) can no longer be installed with this script."
    exit 1
  fi

  if ! EXPECTED_CHECKSUM="$(read_expected_tarball_checksum "$CHECKSUMS_PATH")"; then
    print_error "The release's SHA256SUMS file has no single valid entry for agemon.tgz; refusing to install."
    exit 1
  fi

  ACTUAL_CHECKSUM="$(sha256_of_file "$TARBALL_PATH")"
  if [ "$ACTUAL_CHECKSUM" != "$EXPECTED_CHECKSUM" ]; then
    print_error "Checksum mismatch for agemon.tgz: expected ${EXPECTED_CHECKSUM}, got ${ACTUAL_CHECKSUM}."
    print_error "The download is corrupt, stale or tampered with. Nothing was changed; re-run the installer in a few minutes."
    exit 1
  fi
  print_info "Checksum verified (SHA-256 ${ACTUAL_CHECKSUM})."

  if [ "${AGEMON_VERIFY_ATTESTATION:-}" = "1" ]; then
    if ! gh attestation verify "$TARBALL_PATH" --repo "$REPO" \
      --signer-workflow "$SIGNER_WORKFLOW" --deny-self-hosted-runners; then
      print_error "Build provenance verification failed. gh must be logged in ('gh auth login'). Nothing was changed."
      exit 1
    fi
    print_info "Build provenance verified."
  fi

  mkdir -p "$(dirname "$INSTALL_DIR")"
  STAGE_DIR="$(mktemp -d "${INSTALL_DIR}.tmp-XXXXXX")"
  chmod 755 "$STAGE_DIR"

  if ! tar -xzf "$TARBALL_PATH" -C "$STAGE_DIR" --strip-components=1; then
    print_error "Downloaded archive could not be extracted; it may be truncated or corrupt. Re-run the installer."
    exit 1
  fi

  if [ ! -f "$STAGE_DIR/package.json" ] || [ ! -f "$STAGE_DIR/bin/agemon.js" ]; then
    print_error "Downloaded archive is missing expected files (package.json / bin/agemon.js)."
    exit 1
  fi

  PACKAGE_VERSION="$(read_package_field "$STAGE_DIR/package.json" version)"
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

  STAGED_VERSION="$(node "$STAGE_DIR/bin/agemon.js" --version 2>/dev/null || true)"
  if [ "$STAGED_VERSION" != "$EXPECTED_VERSION" ]; then
    print_error "The downloaded agemon ${EXPECTED_VERSION} does not run: it reports '${STAGED_VERSION:-<nothing>}'."
    print_error "The release archive is truncated, stale, or missing a bundled dependency."
    print_error "Try again shortly; if it keeps failing, this release is broken — open an issue at https://github.com/${REPO}/issues."
    print_error "Nothing was changed on your machine."
    exit 1
  fi

  printf '%s\n' "$EXPECTED_VERSION" >"${STAGE_DIR}/${INSTALL_MARKER}"
  assert_install_dir_is_replaceable
  swap_into_place

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

  if [ "$BIN_DIR_ON_PATH" -eq 1 ] && [ -n "$RESOLVED_ON_PATH" ] &&
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
}

main "$@"

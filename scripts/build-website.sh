#!/bin/sh
set -eu

SITE_ORIGIN="https://agemon.korak-kurani.com"

usage="usage: build-website.sh [--install-sh <file> --sha256sums <file> --release-tag <vX.Y.Z>]"
install_script="install.sh"
sha256sums=""
release_tag=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-sh) install_script="${2:?$usage}" ;;
    --sha256sums) sha256sums="${2:?$usage}" ;;
    --release-tag) release_tag="${2:?$usage}" ;;
    *)
      echo "$usage" >&2
      exit 2
      ;;
  esac
  shift 2
done

set -- --install-sh "$install_script"
[ -z "$sha256sums" ] || set -- "$@" --sha256sums "$sha256sums"
[ -z "$release_tag" ] || set -- "$@" --release-tag "$release_tag"

npm run website:content -- "$@"
npm --prefix website run build
npx tsx scripts/site-csp.ts "$SITE_ORIGIN"
sh scripts/verify-site.sh website/dist "$SITE_ORIGIN" website/csp-policy.txt \
  "$install_script" ${sha256sums:+"$sha256sums"}

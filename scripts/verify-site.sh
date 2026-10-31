#!/bin/sh
# Runs in the deploy workflow's verify job, which must not run npm or any repository
# JavaScript: it re-checks the built site outside the job whose dependencies built it.
set -eu
# The C locale makes grep read bytes, so no encoding error can switch it to binary mode.
export LC_ALL=C

usage="usage: verify-site.sh <site-dir> <site-origin> <csp-policy-file> <install.sh> [SHA256SUMS]"
site_dir="${1:?$usage}"
site_origin="${2:?$usage}"
policy_file="${3:?$usage}"
install_script="${4:?$usage}"
sha256sums="${5:-}"

fail() {
  echo "verify-site: $*" >&2
  exit 1
}

sha256_of() {
  sha256sum "$1" | cut -d' ' -f1
}

expected_sha256="$(sha256_of "$install_script")"

if [ -n "$sha256sums" ]; then
  listed="$(grep -E '^[0-9a-f]{64}  install\.sh$' "$sha256sums" || true)"
  [ "$(printf '%s\n' "$listed" | grep -c .)" -eq 1 ] ||
    fail "SHA256SUMS must list install.sh exactly once"
  [ "${listed%%  *}" = "$expected_sha256" ] ||
    fail "install.sh does not match SHA256SUMS"
fi

cmp -s "$site_dir/install.sh" "$install_script" ||
  fail "the site's install.sh is not byte-identical to $install_script"

file_list="$(mktemp)"
trap 'rm -f "$file_list"' EXIT

newline='
'
find "$site_dir" -name "*$newline*" >"$file_list"
[ ! -s "$file_list" ] || fail "$site_dir has a file name containing a newline"

find "$site_dir" -type f ! -iname '*.html' ! -iname '*.css' ! -iname '*.js' \
  ! -iname '*.json' ! -name 'sitemap-index.xml' ! -name 'sitemap-[0-9]*.xml' ! -iname '*.svg' ! -iname '*.png' ! -iname '*.ico' \
  ! -iname '*.woff2' ! -iname '*.webmanifest' ! -iname '*.sh' ! -iname '*.wasm' \
  ! -iname '*.webm' \
  ! -iname '*.pagefind' ! -iname '*.pf_fragment' ! -iname '*.pf_index' ! -iname '*.pf_meta' \
  >"$file_list"
[ ! -s "$file_list" ] || fail "unexpected file type: $(head -n 1 "$file_list")"

# Pages serves these by extension with a concrete media type, which browsers do not
# sniff up to HTML; the signature check only catches a misnamed or truncated file.
check_signature() {
  extension="$1"
  format="$2"
  signature="$3"
  find "$site_dir" -type f -iname "*.$extension" >"$file_list"
  while IFS= read -r media_file; do
    [ "$(head -c "$((${#signature} / 2))" "$media_file" | od -An -tx1 | tr -d ' \n')" = "$signature" ] ||
      fail "$media_file does not start with the $format signature"
  done <"$file_list"
}
check_signature png PNG 89504e470d0a1a0a
check_signature webm WebM 1a45dfa3

# A NUL byte makes grep treat a file as binary, which hides matches from any
# check that forgets -a; an ESC byte lets a file decoded as ISO-2022-JP hide
# markup from a byte-wise grep.
find "$site_dir" -type f \( -iname '*.html' -o -iname '*.svg' -o -iname '*.xml' \
  -o -iname '*.css' -o -iname '*.js' -o -iname '*.json' \) >"$file_list"
while IFS= read -r text_file; do
  tr -d '\000' <"$text_file" | cmp -s - "$text_file" ||
    fail "$text_file contains a NUL byte"
  tr -d '\033' <"$text_file" | cmp -s - "$text_file" ||
    fail "$text_file contains an ESC byte"
done <"$file_list"

declared_encoding_other_than_utf8() {
  printf '%s' "$1" | grep -a -oiE "<\?xml[^>]*encoding[[:space:]]*=[[:space:]]*[\"'][^\"']*[\"']" |
    grep -a -viE "[\"']utf-8[\"']$" | head -n 1 || true
}

occurrences() {
  grep -a -o "$@" | wc -l
}

home_page="$site_dir/index.html"
grep -a -qF "data-install-sha256=\"$expected_sha256\"" "$home_page" ||
  fail "the home page does not show install.sh's SHA-256 $expected_sha256"

verified_copy_buttons=0
for command in \
  "npm install --global agemon" \
  "curl --proto '=https' --tlsv1.2 -fsSL $site_origin/install.sh | sh"; do
  offered="$(occurrences -F "data-copy=\"$command\"" "$home_page")"
  [ "$offered" -ge 1 ] ||
    fail "the home page does not offer the install command: $command"
  verified_copy_buttons=$((verified_copy_buttons + offered))
done
[ "$(occurrences -i 'data-copy' "$home_page")" -eq "$verified_copy_buttons" ] ||
  fail "every copy button on the home page must offer one of the two install commands"

policy="$(cat "$policy_file")"
csp_prefix='<head><meta http-equiv="content-security-policy" content="'
find "$site_dir" -type f -iname '*.html' >"$file_list"
pages=0
while IFS= read -r page; do
  pages=$((pages + 1))
  ! grep -a -q '<!--' "$page" ||
    fail "$page contains an HTML comment"
  page_start="$(head -n 1 "$page" | grep -a -o -i -E "^<!DOCTYPE html><html( [a-z-]+(=\"[^\"<>]*\")?)*>${csp_prefix}[^\"]*\"" || true)"
  [ -n "$page_start" ] ||
    fail "$page does not start with <!DOCTYPE html><html><head> and its Content-Security-Policy"
  [ "$(occurrences -i 'http-equiv' "$page")" -eq 1 ] ||
    fail "$page must have exactly one http-equiv meta tag"
  [ "$page" = "$home_page" ] || [ "$(occurrences -i 'data-copy' "$page")" -eq 0 ] ||
    fail "$page has a copy button; only the home page may offer one"
  page_policy="${page_start#*"$csp_prefix"}"
  page_policy="${page_policy%\"}"
  without_hashes="$(printf '%s' "$page_policy" | sed "s/ 'sha256-[A-Za-z0-9+/=]*'//g")"
  [ "$without_hashes" = "$policy" ] ||
    fail "$page has a Content-Security-Policy that differs from $policy_file"
done <"$file_list"
[ "$pages" -gt 0 ] || fail "$site_dir has no pages"

one_line() {
  tr '\n\r\t\f\v' '     ' <"$1"
}

find "$site_dir" -type f -iname '*.svg' >"$file_list"
while IFS= read -r svg; do
  svg_text="$(one_line "$svg")"
  [ -z "$(declared_encoding_other_than_utf8 "$svg_text")" ] ||
    fail "$svg declares an encoding other than UTF-8"
  if printf '%s' "$svg_text" | grep -a -qiE 'script|xmlns:|<foreignObject|<a[[:space:]>]|<set[[:space:]>]|<animate|[[:space:]]on[a-z]+[[:space:]]*=|javascript:|@import|&|http-equiv|<meta|<form|<input|<iframe|<embed|<object|<link'; then
    fail "$svg contains active content"
  fi
  foreign_namespace="$(printf '%s' "$svg_text" | grep -a -oiE "xmlns[[:space:]]*=[[:space:]]*[\"'][^\"']*[\"']" |
    grep -vxF 'xmlns="http://www.w3.org/2000/svg"' | head -n 1 || true)"
  [ -z "$foreign_namespace" ] ||
    fail "$svg declares a namespace other than SVG: $foreign_namespace"
  if printf '%s' "$svg_text" | grep -a -qiE "(href[[:space:]]*=[[:space:]]*[\"']|url\([[:space:]]*[\"']?)([a-z][a-z0-9+.-]*:|//)"; then
    fail "$svg references another resource"
  fi
done <"$file_list"

sitemap_root='^<(urlset|sitemapindex) xmlns="http://www\.sitemaps\.org/schemas/sitemap/0\.9"( xmlns:[a-z]+="https?://[^"<>]*")*>$'
find "$site_dir" -type f -name '*.xml' >"$file_list"
while IFS= read -r xml; do
  xml_text="$(one_line "$xml")"
  [ -z "$(declared_encoding_other_than_utf8 "$xml_text")" ] ||
    fail "$xml declares an encoding other than UTF-8"
  if printf '%s' "$xml_text" | grep -a -qiE '&|script|xml-stylesheet|[[:space:]]on[a-z]+[[:space:]]*=|javascript:'; then
    fail "$xml contains active content"
  fi
  unexpected_element="$(printf '%s' "$xml_text" | grep -a -o '<[^[:space:]>]*' |
    grep -vxE '<\?xml|</?(urlset|sitemapindex|sitemap|url|loc|lastmod|changefreq|priority)/?' |
    head -n 1 || true)"
  [ -z "$unexpected_element" ] ||
    fail "$xml contains an element that is not part of a sitemap: $unexpected_element"
  elements_with_attributes="$(printf '%s' "$xml_text" | grep -a -oE '<[a-zA-Z][^[:space:]>/]*[[:space:]][^>]*>' || true)"
  if [ "$(printf '%s\n' "$elements_with_attributes" | grep -c .)" -ne 1 ] ||
    ! printf '%s\n' "$elements_with_attributes" | grep -a -qE "$sitemap_root"; then
    fail "$xml must have attributes only on its root element, and only the sitemap namespace declarations"
  fi
done <"$file_list"

echo "verify-site: $pages pages, install.sh and the install commands check out"

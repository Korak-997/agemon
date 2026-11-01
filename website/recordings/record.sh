#!/bin/sh
# Records the website's terminal recordings; see README.md.
set -eu

usage="usage: record.sh [recording-name ...]"
recordings_dir="$(cd "$(dirname "$0")" && pwd)"
repository_root="$(cd "$recordings_dir/../.." && pwd)"
media_dir="$repository_root/website/public/media"
recorded_ledger="$repository_root/website/src/data/recorded-ledger.json"
readme_gif="$repository_root/docs/demo/agemon.gif"
manifest="$recordings_dir/recordings.sha256"
all_recordings="roundtrip plan-and-consent failure-and-rollback"
work_root="${XDG_CACHE_HOME:-$HOME/.cache}/agemon-recordings"
max_video_bytes=3145728
max_poster_bytes=524288
max_readme_gif_bytes=4194304
max_ledger_bytes=1048576

fail() {
  echo "record.sh: $*" >&2
  exit 1
}

for name in "$@"; do
  case " $all_recordings " in
    *" $name "*) ;;
    *) fail "unknown recording '$name' ($usage)" ;;
  esac
done
[ "$#" -gt 0 ] || set -- $all_recordings

node_binary="$(readlink -f "$(command -v node)")" || fail "node is not on PATH"
case "$node_binary" in
  /usr/*) fail "node at $node_binary belongs to the system; use a self-contained Node (nvm, or the official tarball) so it can be mounted into the container" ;;
esac
node_prefix="$(dirname "$(dirname "$node_binary")")"
case "$HOME/" in
  "$node_prefix"/*) fail "node's install directory $node_prefix contains your home directory; use a self-contained Node (nvm, or the official tarball)" ;;
esac
[ -d "$node_prefix/lib/node_modules/npm" ] ||
  fail "$node_prefix does not look like a Node installation (no lib/node_modules/npm)"

remove_work_root() {
  chmod -R u+rwx "$work_root" 2>/dev/null || true
  rm -rf "$work_root" || echo "record.sh: could not remove $work_root; delete it by hand" >&2
}
remove_work_root
mkdir -p "$work_root/env" "$media_dir" "$(dirname "$recorded_ledger")" "$(dirname "$readme_gif")"
trap remove_work_root EXIT

printf 'root:x:0:0::/root:/bin/sh\nrecorder:x:%s:%s::/tmp:/bin/bash\n' "$(id -u)" "$(id -g)" >"$work_root/passwd"
printf 'root:x:0:\nrecorder:x:%s:\n' "$(id -g)" >"$work_root/group"

cd "$repository_root"
npm run -s build >/dev/null
image="agemon-recordings:$(sha256sum "$recordings_dir/Dockerfile" | cut -c1-16)"
docker build -q -t "$image" "$recordings_dir" >/dev/null

starts_with() {
  [ "$(head -c "$((${#2} / 2))" "$1" | od -An -tx1 | tr -d ' \n')" = "$2" ]
}

accept_output() {
  produced="$1"
  destination="$2"
  max_bytes="$3"
  signature="${4:-}"
  { [ -f "$produced" ] && [ ! -L "$produced" ]; } ||
    fail "$produced is missing or not a regular file"
  [ "$(wc -c <"$produced")" -le "$max_bytes" ] ||
    fail "$produced is larger than $max_bytes bytes"
  [ -z "$signature" ] || starts_with "$produced" "$signature" ||
    fail "$produced does not start with the expected signature"
  { [ ! -L "$destination" ] && [ ! -L "$(dirname "$destination")" ]; } ||
    fail "$destination or its directory is a symlink; remove it and record again"
  [ ! -e "$destination" ] || [ -f "$destination" ] ||
    fail "$destination exists and is not a regular file"
  cat <"$produced" >"$destination"
}

for name in "$@"; do
  runs_root="$work_root/runs/$name"
  out_dir="$work_root/out/$name"
  mkdir -p "$runs_root" "$out_dir"
  npm run -s sandbox -- prepare clean-repo --label "recording-$name" \
    --runs-root "$runs_root" --shell-runs-root /work >"$work_root/env/$name.env"

  docker run --rm \
    --user "$(id -u):$(id -g)" \
    --network none \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --read-only \
    --tmpfs /tmp:exec \
    --shm-size 256m \
    --pids-limit 512 \
    --memory 2g \
    -e HOME=/tmp \
    -w /out \
    -v "$repository_root/bin:/agemon/bin:ro" \
    -v "$repository_root/dist:/agemon/dist:ro" \
    -v "$repository_root/assets:/agemon/assets:ro" \
    -v "$repository_root/package.json:/agemon/package.json:ro" \
    -v "$work_root/passwd:/etc/passwd:ro" \
    -v "$work_root/group:/etc/group:ro" \
    -v "$node_prefix:/opt/node:ro" \
    -v "$recordings_dir:/tapes:ro" \
    -v "$work_root/env:/env:ro" \
    -v "$runs_root:/work" \
    -v "$out_dir:/out" \
    "$image" "/tapes/$name.tape"

  accept_output "$out_dir/$name.webm" "$media_dir/$name.webm" "$max_video_bytes" 1a45dfa3
  accept_output "$out_dir/$name.png" "$media_dir/$name.png" "$max_poster_bytes" 89504e470d0a1a0a
  if [ "$name" = roundtrip ]; then
    accept_output "$out_dir/roundtrip.gif" "$readme_gif" "$max_readme_gif_bytes" 474946383961
    accept_output "$out_dir/recorded-ledger.json" "$recorded_ledger" "$max_ledger_bytes"
  fi
done

{
  for input in Dockerfile record.sh settings.tape roundtrip.tape plan-and-consent.tape failure-and-rollback.tape; do
    sha256sum "website/recordings/$input"
  done
  for name in $all_recordings; do
    sha256sum "website/public/media/$name.webm" "website/public/media/$name.png"
  done
  sha256sum website/src/data/recorded-ledger.json docs/demo/agemon.gif
} >"$manifest"
echo "record.sh: recorded $*; review the media and the recordings.sha256 diff"

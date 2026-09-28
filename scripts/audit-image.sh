#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  printf 'usage: %s <image-ref>\n' "$0" >&2
  exit 2
fi

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

docker save -o "$tmpdir/image.tar" "$1"
tar -xf "$tmpdir/image.tar" -C "$tmpdir"
jq -r '.[].Layers[]' "$tmpdir/manifest.json" > "$tmpdir/layers"
if [[ ! -s "$tmpdir/layers" ]]; then
  printf 'docker save contained no layers\n' >&2
  exit 2
fi

: > "$tmpdir/offenders"
while IFS= read -r layer; do
  tar -tf "$tmpdir/$layer" > "$tmpdir/members"
  while IFS= read -r member; do
    path=$member
    while [[ $path == ./* ]]; do path=${path#./}; done
    path=${path#/}
    name=${path##*/}
    if [[ $path == */ ]]; then
      # Directory entries do not themselves contain files.
      [[ $path == app/data/* ]] && printf '%s\n' "$path" >> "$tmpdir/offenders"
      continue
    fi
    case "$name" in
      .env|.env.*)
        [[ $name == .env.example ]] || printf '%s\n' "$path" >> "$tmpdir/offenders"
        ;;
    esac
    case "$path" in
      *.sqlite|*.sqlite-wal|*.sqlite-shm|app/data/*|var/lib/llm-router/*)
        printf '%s\n' "$path" >> "$tmpdir/offenders"
        ;;
    esac
  done < "$tmpdir/members"
done < "$tmpdir/layers"

if [[ -s "$tmpdir/offenders" ]]; then
  sort -u "$tmpdir/offenders"
  exit 1
fi

#!/usr/bin/env bash
set -euo pipefail

src="${PI_PRIVATE_CONFIG:-$HOME/.pi/agent}"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
destination="$repo/extensions/codex-accounts"
readonly -a public_files=(
  "index.ts"
  "auto-recovery.ts"
)

for file in "${public_files[@]}"; do
  test -f "$src/extensions/codex-accounts/$file"
done

stage="$(mktemp -d "$repo/extensions/.codex-accounts.stage.XXXXXX")"
backup="$repo/extensions/.codex-accounts.backup.$$"
cleanup() {
  rm -rf "$stage"
  if [ -d "$backup" ] && [ ! -e "$destination" ]; then
    mv "$backup" "$destination"
  fi
}
trap cleanup EXIT INT TERM

for file in "${public_files[@]}"; do
  install -m 0644 "$src/extensions/codex-accounts/$file" "$stage/$file"
done

if rg -n '/Users/|/Volumes/|privateKey|server_private|ivancho-codex|cycle_chatgpt_seat' "$stage"; then
  echo "Refusing to publish a private path or key reference." >&2
  exit 1
fi
if rg -n "from [\"']\\.\\./" "$stage"; then
  echo "Refusing to publish an extension with a sibling dependency." >&2
  exit 1
fi

rm -rf "$backup"
if [ -d "$destination" ]; then
  mv "$destination" "$backup"
fi
mv "$stage" "$destination"
rm -rf "$backup"
trap - EXIT INT TERM

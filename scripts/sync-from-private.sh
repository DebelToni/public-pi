#!/usr/bin/env bash
set -euo pipefail

src="${PI_PRIVATE_CONFIG:-$HOME/.pi/agent}"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

copy_files() {
  local directory="$1"
  shift
  rm -rf "$repo/$directory"
  mkdir -p "$repo/$directory"
  local file
  for file in "$@"; do
    cp -p "$src/$directory/$file" "$repo/$directory/$file"
  done
}

copy_files extensions/codex-accounts \
  auto-recovery.ts \
  index.ts
copy_files extensions/codex-provider-sync \
  index.ts
copy_files extensions/codex-seat-automation \
  README.md \
  config.example.json \
  continuation-request.ts \
  coordinator.py \
  index.ts \
  mac-webhook.pub \
  package-lock.json \
  package.json \
  recovery-state.ts \
  recovery.ts \
  seat-request.ts \
  webhook-client.d.ts \
  webhook-client.mjs
copy_files extensions/compaction \
  index.ts \
  prompt.ts
copy_files extensions/lib \
  codex-provider-sync-control.ts \
  internal-usage.ts

mkdir -p "$repo/prompts"
cp -p "$src/prompts/friend-codex-automatic-switching.md" "$repo/prompts/friend-codex-automatic-switching.md"

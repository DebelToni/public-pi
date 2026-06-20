#!/usr/bin/env bash
set -euo pipefail
src="${PI_PRIVATE_CONFIG:-$HOME/.pi/agent}"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for ext in codex-accounts codex-provider-sync; do
  rm -rf "$repo/extensions/$ext"
  mkdir -p "$repo/extensions/$ext"
  cp -R "$src/extensions/$ext/." "$repo/extensions/$ext/"
done

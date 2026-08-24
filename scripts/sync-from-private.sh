#!/usr/bin/env bash
set -euo pipefail

src="${PI_PRIVATE_CONFIG:-$HOME/.pi/agent}"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
manifest="$repo/scripts/public-files.txt"
staging="$repo/.sync-staging.$$"
extensions_backup="$repo/.extensions-pre-sync.$$"
prompts_backup="$repo/.prompts-pre-sync.$$"

approved_extensions=(
  agent-time-telemetry
  agents-inbox
  ask-past-session
  cli-fast
  codex-accounts
  codex-provider-sync
  codex-seat-automation
  compaction
  compatible-skills
  custom-tui
  deep-think
  delete-session
  exa-search
  fork-tmux
  goal
  lib
  max-reasoning
  model-shortcuts
  model-status
  modern-latex
  move-session
  openai-plus
  ordered-context
  pi-prompt-editor
  safety
  scrollback-goto
  search-session
  session-kb
  session-recency
  spec-driven
  steering-continuity
  subagent
  tool-hide
  zz-btw
  zz-prompt-tabs
  zzz-close-on-done
)

cleanup() {
  rm -rf "$staging"
  if [[ -d "$extensions_backup" && ! -d "$repo/extensions" ]]; then
    mv "$extensions_backup" "$repo/extensions"
  fi
  if [[ -d "$prompts_backup" && ! -d "$repo/prompts" ]]; then
    mv "$prompts_backup" "$repo/prompts"
  fi
}
trap cleanup EXIT

is_approved_extension() {
  local candidate="$1"
  local extension
  for extension in "${approved_extensions[@]}"; do
    [[ "$candidate" == "$extension" ]] && return 0
  done
  return 1
}

is_allowlisted() {
  grep -Fqx -- "$1" "$manifest"
}

if [[ ! -f "$manifest" || -L "$manifest" ]]; then
  printf 'Missing regular publication manifest: %s\n' "$manifest" >&2
  exit 1
fi
if ! LC_ALL=C sort -cu "$manifest" 2>/dev/null; then
  printf 'Publication manifest must be sorted and unique: %s\n' "$manifest" >&2
  exit 1
fi

# Reject new files and symlinks anywhere in an approved private source tree.
for extension in "${approved_extensions[@]}"; do
  source_dir="$src/extensions/$extension"
  if [[ ! -d "$source_dir" || -L "$source_dir" ]]; then
    printf 'Missing regular approved source directory: %s\n' "$source_dir" >&2
    exit 1
  fi

  symlink="$(find "$source_dir" -path "$source_dir/node_modules" -prune -o -type l -print -quit)"
  if [[ -n "$symlink" ]]; then
    printf 'Refusing symlink in approved source: %s\n' "$symlink" >&2
    exit 1
  fi

  while IFS= read -r -d '' file; do
    relative="${file#"$src"/}"
    if ! is_allowlisted "$relative"; then
      printf 'Refusing file absent from publication manifest: %s\n' "$relative" >&2
      exit 1
    fi
  done < <(find "$source_dir" -path "$source_dir/node_modules" -prune -o -type f -print0)
done

mkdir -p "$staging/extensions" "$staging/prompts"
while IFS= read -r relative; do
  [[ -n "$relative" ]] || continue
  case "$relative" in
    prompts/friend-codex-automatic-switching.md)
      ;;
    extensions/*/*)
      extension="${relative#extensions/}"
      extension="${extension%%/*}"
      if ! is_approved_extension "$extension"; then
        printf 'Unapproved extension in publication manifest: %s\n' "$relative" >&2
        exit 1
      fi
      ;;
    *)
      printf 'Invalid path in publication manifest: %s\n' "$relative" >&2
      exit 1
      ;;
  esac

  source_file="$src/$relative"
  if [[ ! -f "$source_file" || -L "$source_file" ]]; then
    printf 'Missing regular allowlisted source file: %s\n' "$source_file" >&2
    exit 1
  fi
  mkdir -p "$staging/$(dirname "$relative")"
  cp -p "$source_file" "$staging/$relative"
done < "$manifest"

# Reusable extensions need only these pure helpers. The private modes extension
# contains personal wiki behavior and is never a publication source.
if [[ ! -f "$repo/extensions/modes/shared.ts" || -L "$repo/extensions/modes/shared.ts" ]]; then
  printf 'Missing sanitized public modes/shared.ts\n' >&2
  exit 1
fi
mkdir -p "$staging/extensions/modes"
cp -p "$repo/extensions/modes/shared.ts" "$staging/extensions/modes/shared.ts"

if grep -R -n -I -E \
  '/Users/|/Volumes/|/home/[^<[:space:]]|/opt/homebrew|@icloud\.com|@gmail\.com|\.ts\.net|BEGIN (OPENSSH|RSA|EC|DSA) PRIVATE KEY' \
  "$staging" >&2; then
  printf 'Privacy-sensitive literal found in staged publication.\n' >&2
  exit 1
fi

# Every source has been validated before replacing the public extension tree.
mv "$repo/extensions" "$extensions_backup"
mv "$staging/extensions" "$repo/extensions"
rm -rf "$extensions_backup"

if [[ -d "$repo/prompts" ]]; then
  mv "$repo/prompts" "$prompts_backup"
fi
mv "$staging/prompts" "$repo/prompts"
rm -rf "$prompts_backup"

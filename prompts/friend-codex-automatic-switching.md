# Prepare portable Codex switching code without activation

Fast-forward the installed Codex account/recovery bundle from Anton's sanitized public mirror:

```text
https://github.com/DebelToni/public-pi
```

This is a **code preparation only** update. Keep every account Codex-only and leave seat automation disabled. Do not create or install a signing key, webhook URL, client mapping, or enabled local configuration. Do not run a live seat mutation. Do not install the `subagent` extension; interrupted main tasks resume directly without it.

## Safety preflight

Work only under:

```text
~/.pi/agent/extensions/
~/.pi/agent/codex-seat-automation.local.json
~/.pi/agent/codex-auto-recovery-runtime/config.json
~/tmp/
```

Do not inspect or print OAuth credential values. Do not modify `auth.json`, `codex-accounts.json`, provider/model state, saved quota history, pending-operation state, or any account login.

Before changing source files:

1. Confirm no `/as --auto` or `/seat-cycle-check` operation is running.
2. If `~/.pi/agent/codex-seat-automation.local.json` exists, inspect only its `enabled` and `automaticRecovery` booleans. Stop without changing anything unless both are `false`.
3. If `~/.pi/agent/codex-auto-recovery-runtime/config.json` exists, inspect only its `enabled` boolean. Stop unless it is `false`.
4. Record the current provider/model without changing it.

## Install the exact public release

Anton will provide an immutable public commit as `PUBLIC_PI_REF`. Refuse a branch name such as `main`; require a full 40-character lowercase commit hash.

Use a fresh owner-only staging directory and verify that checkout exactly:

```bash
if ! printf '%s' "${PUBLIC_PI_REF:-}" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "PUBLIC_PI_REF must be one full commit hash" >&2
  exit 1
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
staging="$HOME/tmp/friend-public-pi-$stamp"
backup="$HOME/tmp/friend-codex-backup-$stamp"
umask 077
mkdir -p "$staging" "$backup/extensions"
git clone --no-checkout https://github.com/DebelToni/public-pi.git "$staging/repo"
git -C "$staging/repo" checkout --detach "$PUBLIC_PI_REF"
test "$(git -C "$staging/repo" rev-parse HEAD)" = "$PUBLIC_PI_REF"
```

Stage the coordinated bundle and install its dependency lockfile without scripts:

```bash
mkdir -p "$staging/install/extensions/lib"
for name in codex-accounts codex-provider-sync codex-seat-automation compaction model-status; do
  cp -a "$staging/repo/extensions/$name" "$staging/install/extensions/"
done
for name in codex-provider-sync-control.ts fast-mode.ts internal-usage.ts; do
  cp -a "$staging/repo/extensions/lib/$name" "$staging/install/extensions/lib/"
done

cd "$staging/install/extensions/codex-seat-automation"
npm ci --omit=dev --ignore-scripts
```

Move only the existing source bundle into the owner-only backup, then install the staged replacement. Never move or copy runtime state:

```bash
mkdir -p "$backup/extensions/lib" "$HOME/.pi/agent/extensions/lib"
for name in codex-accounts codex-provider-sync codex-seat-automation compaction model-status; do
  if [ -e "$HOME/.pi/agent/extensions/$name" ]; then
    mv "$HOME/.pi/agent/extensions/$name" "$backup/extensions/"
  fi
  mv "$staging/install/extensions/$name" "$HOME/.pi/agent/extensions/"
done
for name in codex-provider-sync-control.ts fast-mode.ts internal-usage.ts; do
  if [ -e "$HOME/.pi/agent/extensions/lib/$name" ]; then
    mv "$HOME/.pi/agent/extensions/lib/$name" "$backup/extensions/lib/"
  fi
  mv "$staging/install/extensions/lib/$name" "$HOME/.pi/agent/extensions/lib/"
done
chmod -R go-rwx "$backup"
```

Do not copy the `subagent` extension or any local/runtime JSON file from the repository, staging directory, backup, or another machine.

## Verify without activation

Run the repository's existing tests for the copied extensions using the runtimes already installed on the machine. Also run:

```bash
pi --list-models
```

Verification must not:

- invoke `/as --auto` or `/seat-cycle-check`;
- create `codex-seat-automation.local.json`;
- enable `/codex-auto-recovery`;
- change the active provider/model;
- refresh, remove, or re-login an OAuth account;
- install or copy private key material.

After tests pass, ask the user to type `/reload` once in each active Pi process. Do not inject input or restart a process. After reload, confirm the previously selected provider/model is unchanged and report that seat automation remains unconfigured/disabled.

Finish by reporting:

- installed public commit;
- tests and load-check results;
- backup directory;
- whether either disabled configuration file already existed;
- confirmation that no seat mutation, account selection, OAuth change, or server activation occurred.

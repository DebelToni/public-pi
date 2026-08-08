# public-pi

Public, whitelisted Pi extensions from Anton's private Pi configuration.

## Automatic Codex account switching

The portable no-subagent switching bundle contains:

- `extensions/codex-accounts` — account providers, usage checks, and account selection.
- `extensions/codex-provider-sync` — selected provider/model synchronization across Pi sessions.
- `extensions/codex-seat-automation` — durable signed seat requests and automatic recovery.
- `extensions/compaction` — custom compaction and quota-failure signaling.
- `extensions/lib/codex-provider-sync-control.ts`
- `extensions/lib/internal-usage.ts`

Follow the complete installation prompt:

[`prompts/friend-codex-automatic-switching.md`](prompts/friend-codex-automatic-switching.md)

The `subagent` extension is not required. If absent, automatic recovery continues the interrupted main task directly through Pi.

Private provisioning is still required. This repository intentionally excludes sender private keys, webhook URLs, account credentials, OAuth data, local config, runtime state, sessions, and logs.

## Other mirrored extensions

The repository also contains selected general-purpose extensions. Copy only the extension folders you want into `~/.pi/agent/extensions`, then use `/reload`.

## Mirror maintenance

`scripts/sync-from-private.sh` copies an explicit file whitelist from the private Pi configuration. It does not copy local config or runtime files.

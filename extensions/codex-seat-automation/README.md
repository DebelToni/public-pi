# Codex seat automation companion

Private companion for the public `codex-accounts` extension. It submits one idempotent, signed seat-rotation request to Anton's Mac and polls the signed durable result. The request never contains a role, pool, email, or target account; the Mac maps the configured key ID to a fixed pool.

Install runtime dependencies in this directory:

```bash
npm ci --ignore-scripts
```

Copy `config.example.json` to `~/.pi/agent/codex-seat-automation.local.json`, replace both `REPLACE` path segments, and set mode `0600`:

```json
{
  "version": 1,
  "enabled": false,
  "automaticRecovery": false,
  "keyId": "REPLACE_WITH_APPROVED_KEY_ID",
  "privateKeyPath": "~/.ssh/REPLACE_WITH_THE_SENDER_ED25519_KEY",
  "macPublicKeyPath": "~/.pi/agent/extensions/codex-seat-automation/mac-webhook.pub",
  "url": "https://REPLACE_WITH_THE_DEPLOYED_WEBHOOK_URL"
}
```

Leave both flags `false` while installing code without activation. After separate server-side authorization and private provisioning, set `enabled` and `automaticRecovery` to `true` if this Pi installation should switch seats automatically after an exact Codex quota failure. Recovery rotates when live quota reports less than 10% remaining; at 10% or more it retries once on the same account instead. A pending operation ID is kept under `~/.pi/agent/codex-seat-automation-runtime/` so process or network failure cannot create an accidental second rotation.

Test mode does not select a model or publish provider sync:

```text
/codex-usage
/codex-usage --saved
/seat-cycle-check
```

`/codex-usage` shows live 5-hour and weekly windows without forcing OAuth refresh. Successful quota responses atomically update owner-only snapshots in `~/.pi/agent/codex-usage-history.json`; usage-based responses and errors retain the previous snapshot. `--saved` performs no network request. `/seat-cycle-check` prints usage, requests exactly one signed seat rotation, waits for the unique usable account to move, and prints the final state. A verified v2 response reports `previous → selected` immediately, then activation queries only the selected account; older v1 responses fall back to the all-account scan. If local activation fails, `/as <selected> <model>` remains available for manual selection. OAuth tokens refresh automatically near expiry; forced refresh flags are rejected.

Automatic recovery can resume the interrupted main task directly through Pi. The `subagent` extension is optional; it is only needed for subagent continuation features.

Passphrase-protected OpenSSH keys require `WEBHOOK_KEY_PASSPHRASE` in the environment that launches Pi. Never save the passphrase in this config. For unattended macOS recovery, retrieve it from the login Keychain in a local Pi launcher, or provision a dedicated seat-signing key.

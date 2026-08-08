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
  "enabled": true,
  "automaticRecovery": false,
  "keyId": "friend-1",
  "privateKeyPath": "~/.ssh/REPLACE_WITH_THE_SENDER_ED25519_KEY",
  "macPublicKeyPath": "~/.pi/agent/extensions/codex-seat-automation/mac-webhook.pub",
  "url": "https://REPLACE_WITH_THE_DEPLOYED_WEBHOOK_URL"
}
```

Set `automaticRecovery` to `true` if this Pi installation should switch seats automatically after a confirmed Codex quota failure; leave it `false` for manual-only `/as --auto` switching. A pending operation ID is kept under `~/.pi/agent/codex-seat-automation-runtime/` so process or network failure cannot create an accidental second rotation.

Automatic recovery can resume the interrupted main task directly through Pi. The `subagent` extension is optional; it is only needed for subagent continuation features.

Passphrase-protected OpenSSH keys require `WEBHOOK_KEY_PASSPHRASE` in the environment that launches Pi. Never save the passphrase in this config. For unattended macOS recovery, retrieve it from the login Keychain in a local Pi launcher, or provision a dedicated seat-signing key.

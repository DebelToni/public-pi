# Install portable Codex automatic account switching

Install the switching bundle from Anton’s public mirror:

https://github.com/DebelToni/public-pi

Do not install the `subagent` extension. This setup resumes an interrupted main task directly and does not require subagents.

## 1. Copy the public extensions

Use a temporary clone and copy only the switching bundle:

```bash
rm -rf /tmp/public-pi
git clone --depth 1 https://github.com/DebelToni/public-pi.git /tmp/public-pi
mkdir -p ~/.pi/agent/extensions/lib
cp -R /tmp/public-pi/extensions/codex-accounts ~/.pi/agent/extensions/
cp -R /tmp/public-pi/extensions/codex-provider-sync ~/.pi/agent/extensions/
cp -R /tmp/public-pi/extensions/codex-seat-automation ~/.pi/agent/extensions/
cp -R /tmp/public-pi/extensions/compaction ~/.pi/agent/extensions/
cp /tmp/public-pi/extensions/lib/codex-provider-sync-control.ts ~/.pi/agent/extensions/lib/
cp /tmp/public-pi/extensions/lib/internal-usage.ts ~/.pi/agent/extensions/lib/
```

If any destination already exists, inspect it and preserve the user’s work instead of overwriting blindly.

Install the seat-request dependencies:

```bash
cd ~/.pi/agent/extensions/codex-seat-automation
npm ci --ignore-scripts
```

## 2. Create the private local config

Create:

```text
~/.pi/agent/codex-seat-automation.local.json
```

Use values provisioned privately for this user. Never copy another machine’s private key or local paths:

```json
{
  "version": 1,
  "enabled": true,
  "automaticRecovery": true,
  "keyId": "FRIEND_KEY_ID",
  "privateKeyPath": "~/.ssh/FRIEND_PRIVATE_ED25519_KEY",
  "macPublicKeyPath": "~/.pi/agent/extensions/codex-seat-automation/mac-webhook.pub",
  "url": "PRIVATE_WEBHOOK_URL"
}
```

Requirements:

- The sender private key and webhook URL must be delivered privately, not fetched from GitHub.
- The sender private key must be owner-readable only.
- The local config must be mode `0600`.
- The Mac public key is public, but its configured local path must exist.
- The key ID must already be approved by the Mac-side service.
- `automaticRecovery: true` enables switching after a confirmed Codex quota failure.

Apply permissions:

```bash
chmod 600 ~/.pi/agent/codex-seat-automation.local.json
chmod 600 ~/.ssh/FRIEND_PRIVATE_ED25519_KEY
```

## 3. Validate without rotating a seat

1. Reload Pi with `/reload`.
2. Log in to the user’s configured Codex accounts.
3. Run `/codex-auto-recovery status`; it must report enabled.
4. Confirm the desired `codex-piN` providers appear under `/model`.
5. Do not run `/as --auto` merely to test installation because it performs a real seat rotation.

Expected behavior after a confirmed quota exhaustion:

1. Confirm that the current provider really exhausted its quota.
2. Submit one durable signed seat-rotation request.
3. Wait for the Mac-side operation to finish.
4. Select the first verified usable account.
5. Continue the interrupted main task without requiring `subagent`.

The remote caller cannot choose a pool, member, or target account. The Mac-side mapping decides which configured seat is rotated.

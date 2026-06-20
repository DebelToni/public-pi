# public-pi

Public, whitelisted Pi extensions from Anton's private Pi config.

Currently included:
- `extensions/codex-accounts` — multiple Codex/ChatGPT OAuth account providers and `/as` autosub selection.
- `extensions/codex-provider-sync` — sync selected Codex provider/model across Pi sessions.

## Use

Copy the wanted extension folder into your Pi agent config:

```bash
mkdir -p ~/.pi/agent/extensions
cp -R extensions/codex-accounts ~/.pi/agent/extensions/
cp -R extensions/codex-provider-sync ~/.pi/agent/extensions/
```

Then reload Pi:

```text
/reload
```

Private runtime files are intentionally not included: `auth.json`, `codex-accounts.json`, `codex-provider-sync*.json`, sessions, logs, local settings.

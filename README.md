# public-pi

Public, whitelisted Pi extensions from Anton's private Pi config.

Currently included:
- `extensions/codex-accounts` — multiple Codex/ChatGPT OAuth account providers and `/as` autosub selection.
- `extensions/codex-provider-sync` — sync selected Codex provider/model across Pi sessions.
- `extensions/exa-search` — Exa web search/answer tools using `EXA_API_KEY`.
- `extensions/search-session` — search current Pi session transcript.
- `extensions/ask-past-session` — ask disposable forks of previous sessions.
- `extensions/subagent` — isolated subagent runner.
- `extensions/compatible-skills` — compatible skill discovery.
- `extensions/engineering-principles` — engineering-principles prompt toggle.
- `extensions/goal` — goal loop/evaluator helper.
- `extensions/session-recency` — session list recency ordering.
- `extensions/delete-session` — delete current session/window helper.
- `extensions/tool-hide` — hide/collapse tool-call UI.
- `extensions/safety` — shell/input safety helpers.
- `extensions/compaction` — opinionated compaction prompt.
- `extensions/openai-plus` — OpenAI/Codex priority/image helpers.
- `extensions/model-status` — standalone bottom model/context/usage/TPS status line.

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

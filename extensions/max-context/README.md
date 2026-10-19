# Session context window

Standalone, auto-discovered Pi extension. Run `/reload` after installation.

```text
/set-max-context 256000   Set this session's context window in tokens
/set-max-context          Restore the selected model's registered default
```

Accepts positive safe integers only, without signs, separators, decimals, or abbreviations. Values are never silently clamped. Commands wait for the agent to settle before changing its model.

## Behavior

- The numeric override follows model/provider switches and survives reload and same-session resume.
- State is stored in `pi-max-context` custom entries with the originating session ID. The latest valid entry across all branches wins; `null` clears the setting. New sessions, forks, clones, tmux forks, and subagents ignore copied parent settings.
- Application replaces the active model with a shallow clone, leaving registry/provider defaults and settings files unchanged. Reset resolves the current registry model. Thinking level is preserved; Pi may still record same-ID model/thinking changes in session history.
- The existing Ultra footer displays `max:256k` through its keyed `model-status:prefix` channel. No second footer or immutable suite changes are required. The marker is hidden when active and registered values match, even if an equal-valued numeric override remains enabled.
- Same-ID selections and silent registry replacements are repaired on the next idle input, before Pi's pre-prompt compaction check; `before_agent_start` provides an additional guard. Failed input-time repair blocks that prompt and reports an error instead of silently using the wrong limit.

The active metadata controls Pi's context accounting, compaction thresholds, and model-dependent token budgeting. Lowering it may compact before the next response. Raising it cannot increase backend capacity and may cause backend overflow. Ultra's separate custom compaction-model request still uses its own registered metadata; the Codex adapter does not send a server context-window or output-limit parameter.

## Tests

From an Ultra session (which provides `PI_CODEX_ULTRA_RELEASE_ROOT`):

```bash
node --test ~/.pi/agent/extensions/max-context/*.test.ts
```

Unit tests cover validation, persistence, isolation, lifecycle repair, failure behavior, exact marker formatting, and thinking preservation. Offline integration tests exercise the installed Pi loader/session/compaction/provider adapter and Ultra's actual footer and account-model cloning. Fixtures live under `~/tmp` and are removed afterward; no live credentials or provider requests are used.

One executable compatibility test is marked TODO for an independent existing issue: `manage-reasoning/index.ts` calls `pi.getThinkingLevel()` during factory loading, before Pi binds runtime actions. That extension is not modified here. Remove the TODO after its initialization moves to `session_start`.

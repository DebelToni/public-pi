# public-pi

Curated Pi extension source mirrored from Anton's configuration. Some extensions assume this Pi fork, named Sol/Luna models, tmux, or other documented workflow conventions.

## Install selected extensions

The root package intentionally exports no Pi resources, preventing a Git-package install from activating the whole catalog. Clone it and copy only the extensions you have reviewed:

```bash
git clone https://github.com/DebelToni/public-pi.git
mkdir -p ~/.pi/agent/extensions
cp -R public-pi/extensions/lib public-pi/extensions/modes ~/.pi/agent/extensions/
cp -R public-pi/extensions/zz-btw ~/.pi/agent/extensions/ # example selection
```

`lib` and `modes` are non-loading helpers used by several extensions. If a selected directory contains `package-lock.json`, install its runtime dependencies after copying it:

```bash
cd ~/.pi/agent/extensions/<extension>
npm ci --omit=dev --ignore-scripts
```

The coordinated account/recovery workflow requires `codex-accounts`, `codex-provider-sync`, `compaction`, and `codex-seat-automation` together. Run `/reload` after changing the installed set. Root `npm ci --ignore-scripts` is only for developing or testing the mirror itself.

## Extension catalog

### Context, memory, and session understanding

- `ordered-context` — loads numbered global context files in deterministic order.
- `session-kb` — maintains a model-curated knowledge base inside a session and exposes `session_kb_recall`.
- `agent-time-telemetry` — records agent/tool timing telemetry for local analysis.
- `agents-inbox` — summarizes running and completed agent sessions using telemetry and session JSONL files.
- `deep-think` — provides a private scratchpad tool for deliberate reasoning.
- `spec-driven` — creates and advances spec/plan/task artifacts.
- `goal` — generates goal-oriented session continuation context.
- `search-session` — searches the current Pi transcript.
- `session-recency` — keeps resumed-session timing metadata coherent.

`session-kb` sends selected session and tool content to its configured model. Review `~/.pi/agent/session-kb.json` before enabling it for sensitive sessions.

### Conversation and TUI workflow

- `zz-btw` — `/btw` cache-forked side conversations with an overlay and follow-ups.
- `zz-prompt-tabs` — durable prompt tabs and queued draft handling.
- `pi-prompt-editor` — non-blocking tmux/Neovim prompt editing.
- `custom-tui` — compact transcript/editor rendering for this Pi fork.
- `modern-latex` — normalizes unsupported LaTeX commands before terminal rendering.
- `tool-hide` — toggles tool-call visibility.
- `model-status` — model, usage, reset, and fast-mode status controls.
- `scrollback-goto` — tmux scrollback navigation commands.
- `steering-continuity` — preserves steering/follow-up delivery semantics.
- `zzz-close-on-done` — parks and closes a tmux window after successful completion.

`/btw` does not write diagnostic payload logs by default. Set `PI_BTW_DIAGNOSTICS=1` only for local debugging; those logs can contain complete prompts, responses, paths, and provider metadata.

The prompt editor, scrollback, fork, and close-on-done extensions require tmux; `pi-prompt-editor` also requires Neovim. `zzz-close-on-done` uses tmux session `B`, so review that extension before enabling it on a setup where `B` is meaningful.

### Sessions and tmux

- `fork-tmux` — forks the current branch into the next tmux window.
- `move-session` — moves a verified session JSONL to another project directory.
- `delete-session` — branch-aware session deletion.

Set `PI_FORK_TMUX_LAUNCHER` when `/fork-tmux` should launch a wrapper instead of the currently running Pi executable.

### Models, accounts, and recovery

- `model-shortcuts` — `/luna`, `/sol`, and related model shortcuts.
- `max-reasoning` — one-way high-to-max reasoning control.
- `cli-fast` — priority service-tier support for compatible Codex requests.
- `openai-plus` — OpenAI/Codex request and fast-mode behavior.
- `codex-accounts` — multiple Codex OAuth providers and `/as` selection.
- `codex-provider-sync` — provider/model synchronization across local Pi sessions.
- `codex-seat-automation` — signed remote seat rotation and automatic recovery.
- `compaction` — custom compaction and quota-failure signaling.

The public bundle can be installed while seat automation remains disabled. Follow [`prompts/friend-codex-automatic-switching.md`](prompts/friend-codex-automatic-switching.md); private provisioning and activation are deliberately separate.

### Agent and safety infrastructure

- `subagent` — one-off, parallel, chained, named, and resumable child agents.
- `ask-past-session` — focused queries against prior Pi sessions.
- `exa-search` — Exa search/answer tools with account-safe locking.
- `compatible-skills` — compatible skill discovery.
- `safety` — destructive-command policy and confirmation gates.
- `lib` and `modes/shared.ts` — non-loading helper modules used by the extensions above.

## Deliberate exclusions

The mirror excludes credentials, private endpoints, local configuration, sessions, logs, runtime databases (including saved quota history), context/wiki content, generated telemetry, Anton's wiki mode, Google Chrome GUI automation, swear-meter pipeline, and title/wiki integration.

## Mirror maintenance

`scripts/sync-from-private.sh` validates the exact paths in `scripts/public-files.txt`, rejects unknown files, symlinks, and privacy-sensitive literals, stages the complete approved tree, and retains only the sanitized public `modes/shared.ts` from `modes` before replacing the mirror.

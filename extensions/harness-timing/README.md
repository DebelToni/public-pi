# Harness timing

Personal Pi extension that prepends and persists `<harness_timing>` in new user messages only when:

- The previous user message arrived more than three hours earlier. Fields: `previous user`, `current user`.
- The previous reply completed more than one hour after its initiating user message. Fields: `agent started`, `agent finished`. Waiting for the user's next message does not count as agent work.

When both apply, `previous user` supplies the agent start time, followed by `agent finished` and `current user`. Exactly three hours or one hour does not trigger the corresponding condition.

Dates use Sofia local time in `Oct 8 14:40` form, without year, seconds, timezone or elapsed-duration fields. A session's first user message has no previous-message timing.

The `message_end` hook reads Pi's active branch and replaces the new user message before Pi saves it and prepares the model request, preserving images and its arrival timestamp. The tag is ordinary message content in session JSONL, chat history, context inspection and replay. Existing tagged messages are not tagged again. Reloads and branching use normal Pi persistence; compaction handles tags like other message text. No request-time injection, system-prompt edits, reminders, timers or separate state are used.

Both direct terminal input (`input.source: "interactive"`) and phone-injected input (`input.source: "extension"`) use this same message-end path. The extension does not intercept or transform the input event. The envelope is prepended as literal text in the accepted user message, not emitted as a separate assistant message or hidden context block. Quoted, fenced and blockquoted marker examples remain ordinary user text. A message whose first text starts with the exact `<harness_timing>\n` prefix is treated as already enveloped and left unchanged.

This applies to newly accepted messages after loading the extension. Existing session entries are not backfilled or rewritten.

Completion comes from the assistant session entry's timestamp, written after `message_end`, rather than the assistant's generation-start timestamp. Only the latest successful text reply without tool calls qualifies. If a new user message was received before that reply completed, it does not receive completed-run timing.

## Loading and tests

Pi automatically discovers this directory's `index.ts` in new sessions. Existing sessions load it with `/reload`.

```sh
bun test ~/.pi/agent/extensions/harness-timing/index.test.ts
```

Tests cover strict thresholds, long runs versus user waiting, combined tags, incomplete replies, images, duplicate prevention, equal-timestamp queues, date boundaries, quoted marker examples and both interactive/extension input sources. Integration checks use Pi's real extension loader, message-end runner and file-backed SessionManager to verify JSONL storage, reload, branching and compaction.

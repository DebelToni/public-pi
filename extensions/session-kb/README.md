# Session KB

`session-kb` maintains a structured knowledge base as custom entries in the current Pi session. It can activate after compaction and exposes `session_kb_recall` for lexical recall.

Copy `config.example.json` to `~/.pi/agent/session-kb.json` and select a provider/model available in that Pi installation. The default is inactive.

The curator sends bounded session messages, tool results, paths, and live event summaries to the configured model. The resulting knowledge base remains in the session JSONL. Do not enable it for content that must not be sent to that provider or persisted in the session.

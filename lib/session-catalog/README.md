# Standalone Pi session store

A normalized, rebuildable SQLite index over authoritative Pi JSONL sessions. JSONL is never modified. This backend does not integrate itself into Pi runtime; consumers must call the API or CLI explicitly.

## Storage and installation

`defaultCatalogPath()` resolves to `cache/session-store.sqlite3` beside the physical sessions directory. The previous `cache/session-catalog.sqlite3` is neither opened nor migrated, so it remains a rollback artifact.

The next writer upgrades standalone schema v2/v3 to v4 structurally, without reading session sources. Parser v3 changes normalized image pointers, tool bounds, and public first-message representation; older rows are marked stale and rebuilt only when their reconciliation scope is requested. Interrupted staged generations are discarded during writer startup.

The streaming parser is local to this library:

```sh
cd ~/.pi/agent/lib/session-catalog
npm ci
```

## Model

- `files`: physical-path identity, selector metadata, source snapshot/sentinels, visible epoch/generation, freshness, and failures.
- `entries`: every non-header JSONL record, including non-text custom records. It stores source order, entry/parent IDs, type, role, timestamps, source byte range/hash, and bounded checkpoint metadata. IDs are not unique.
- `entry_content`: the single stored copy of bounded extracted content for an entry.
- `parts`: ordered `text`, `toolCall`, `toolResult`, and `image` parts. Text uses character ranges into `entry_content`. Images store MIME, decoded-byte SHA-256/length, and a full `{base, retainedIndex?, contentIndex}` source pointer—never base64. Synthetic retained-tail parts remain children of their compaction checkpoint and carry provenance rather than inventing entry IDs.
- `summaries`: compaction and branch-summary ranges into `entry_content`.
- `entry_fts`: external-content FTS5 with one row per textual entry.

Default search admits conversation text, normalized `retainedTail` conversation parts, and compaction/branch summaries. `includeTools` / `--include-tools` opts into bounded tool calls/results, including retained calls. Thinking text, image data, arbitrary custom payloads, embeddings, OCR, captions, and permanent chunks are not stored. Tool arguments use bounded canonical JSON while complete; a truncated value is explicitly labeled `format: "json-prefix", validJson: false` and must not be parsed as JSON. Metadata records source coverage and truncation. Compaction metadata preserves `firstKeptEntryId`, `tokensBefore`, retained-tail coverage, and branch `fromId`.

## Reconciliation guarantees

Parsing is streaming and framed by literal LF. Each nonempty physical line must contain exactly one top-level JSON object; whitespace-only lines are accepted without consuming an entry descriptor. The opening snapshot is indexed only through its last completed LF. An incomplete tail is reported as deferred, leaves the scope fresh through `indexed_offset`, and resumes from that exact byte after completion. A new empty or partial-header file is deferred; a completed header-only file is a valid zero-entry session.

Changed files stage normalized rows in bounded transactions. `cwd + tree` discovery safely enumerates candidate descendant buckets, checks normalized header cwd values, and records a distinct tree freshness scope. An explicit path may select a trusted regular, non-symlink JSONL outside the configured sessions root; its canonical parent becomes that row's validated source root. This never adds the parent to broad discovery. A final file-row visibility flip publishes the generation atomically. Concurrent append is accepted after identity and indexed-prefix validation; rewrites, malformed completed lines, invalid image base64, and unsafe paths fail the file without publishing staged rows. Appends reuse the epoch, rewrites use a new epoch, inode identity recognizes renames, and missing files have a grace period. The ownership-checked process lock serializes writers and safely reaps confirmed dead owners; corrupt lock metadata fails immediately with manual safety instructions rather than deleting a potentially live lock. Startup removes abandoned generations and marks interrupted files for reconciliation. Readers open SQLite read-only, hold a read transaction across every multi-statement response, and perform no schema or journal mutations.

Image extraction rechecks the exact source snapshot, source byte-range hash, decoded hash, and byte length before publishing the output file.

## JavaScript API

From `index.mjs`:

- `await reconcileCatalog(options)` — writer; exactly one of `path`, `cwd`, or `all` defines scope. `tree` expands a cwd scope to normalized descendants. Returns counters, `failures`, and `scopeComplete`.
- `listCatalogSessions(options)` — read-only metadata with `cwd`/`tree` and SQL `sinceHours` filtering. The returned array exposes a non-enumerable `coverage` receipt; `allowPartial` permits fresh rows from an incomplete global/cwd scope, while `includeText` remains a bounded compatibility option.
- `searchCatalog(query, options)` — read-only; `allowPartial` has the same fresh-only global/cwd semantics. Modes are `bm25`, `phrase`, and `regex`; broad scopes search both normalized entries and bounded file metadata (`name`, session ID, cwd), while exact path/leaf scopes remain entry-only. `metadata: false` disables the broad metadata lane. It also supports `cwd`, `tree`, SQL `sinceHours`, role/type filters, `namedOnly`, sorting, and up to 50 `matchLimit` records per session. Path branch ancestry is applied before ranking. Common relevance-sorted BM25 searches rank lightweight candidate identities, fetch content lazily, and stop once both the top sessions and their requested matches are settled. Exact-path BM25 uses indexed ancestry and one FTS scan bounded by its rowid envelope, preserving global BM25 statistics; recent, phrase, and regex searches retain exhaustive enumeration.
- `readCatalogSession(options)` — read-only branch reconstruction for an exact `path`; supports `leaf`, `entry`, `byteStart`/locator, `before`, `after`, roles, limits, and `maxChars`. An entry without a leaf selects its newest persisted descendant, and text/metadata budgets reserve the requested focus first.
- `inspectCatalogSession(options)` / `inspectSession(options)` — source and freshness metadata for an exact path or session ID without listing or reading entries.
- `await extractCatalogImage(options)` — validates and extracts `{path, entry, part, output}`.
- `await verifyCatalog(options)` — full streaming source/normalization verification.
- `catalogStatus(options)` and `rebuildFts(options)`. Status reports `integrity: "not-checked"` by default; `integrity: true` explicitly runs the potentially expensive full SQLite integrity check.
- `openCatalog(databasePath, {readOnly})`, `closeCatalog`, `scanSessionFile`, `discoverSessionFiles`, `defaultCatalogPath`, `defaultSessionsRoot`, and `encodeSessionBucket`.

For resume searches, `titleFirst: true` / CLI `--title-first` opts BM25 into named-title fuzzy matching. Contiguous query matches rank first, then titles containing all query terms, then ordered-character matches for each term. Every matching title precedes body/ID/cwd hits before the result limit, including `sort: "recent"`; each tier keeps the selected sort's normal tie-breaks. Only the personal `ultra-client.mjs` resume adapter enables this automatically. Phrase/regex, exact-path search, role/type filters, and `metadata: false` retain their existing semantics. Start a new Pi process to load adapter changes.

`listCatalogSessions()` returns an array. The CLI includes its array coverage as a top-level field. `searchCatalog()` returns `{mode, query, results, coverage, performance, durationMs}`. `performance` reports candidate rows scanned, content rows fetched, candidates verified, metadata rows scanned, and whether bounded enumeration stopped early. Every list/search result has bounded `name`/`firstMessage` metadata and has:

```js
{
  path, id, cwd, name, parentSessionPath, created, modified,
  messageCount, firstMessage, firstMessageTruncated,
  // search only:
  excerpt, matchKind, matchedField,
  matchedEntryId, matchedEntryRef, matchedRole,
  // when matchLimit > 1:
  matches
}
```

`matchKind` is `entry` or `metadata`; metadata-only matches identify `matchedField` and deliberately omit entry IDs/locators. Dates are ISO strings. Names are capped at 256 UTF-8 bytes and first messages at 512 bytes; truncation fields preserve coverage. `name`, `parentSessionPath`, match fields, and `matches` are omitted when absent. Broad list/search/status readers are constrained to the configured canonical sessions root; separately indexed external/ephemeral rows and their failures are visible only through deliberate exact-path operations (or by explicitly selecting their root). Global missing cleanup likewise cannot delete external rows. Fresh readers fail closed on incomplete scopes. `allowPartial` is available only to global/cwd list and search: it returns fresh active rows, excludes every stale/failed/missing source, and preserves `scopeComplete: false` with file/scope counts even when no rows match. `allowStale` remains a distinct diagnostic mode that may serve old rows. Exact path list/search/read requests never accept partial mode and validate exact source snapshot identity after an unreconciled rewrite or append. Global/cwd coverage is explicitly labeled `catalog-snapshot` with `sourceValidation: "not-performed"`; consumers reconcile first when live freshness is required. There is intentionally no aggregate session text in default list output.

`readCatalogSession()` returns `{path, id, leafId, leafSelection, entries, coverage}`. Entries may include bounded `metadata`; retained-tail parts carry `checkpointEntryId`, `retainedIndex`, and `contentIndex`, so context readers assemble them in retained/content order after the checkpoint summary. Coverage distinguishes exact source snapshot equality from indexed-prefix validity, reports deferred-tail bytes, and accounts for omitted entries/parts/metadata. Returned metadata is capped below 64 KiB per entry and 128 KiB per response independently of `maxChars`. Without `leaf` or `entry`, the latest persisted entry is selected and `leafSelection` is `latest-persisted-entry-not-guaranteed-live-leaf`; entry-anchored selection is labeled `latest-descendant-not-live`. Neither is presented as Pi's live in-memory leaf. Internal parent links resolve to the latest preceding physical parent. Public entries expose `{id, ordinal, byteStart, byteEnd, sourceSha256}` locators; search returns `matchedEntryRef`, reads return `entryRef`/`leafRef`, and images return `entryRef` plus `imageSource`. Explicit duplicate IDs are rejected unless an exact locator (or CLI `--byte-start`) is supplied.

## CLI

```text
pi-session-catalog reconcile --path SESSION.jsonl
pi-session-catalog reconcile --cwd /project
pi-session-catalog reconcile --all
pi-session-catalog list [--cwd /project] [--tree] [--since-hours HOURS] [--allow-partial]
pi-session-catalog search QUERY [--path SESSION.jsonl [--leaf ID] [--leaf-byte-start N]] [--since-hours HOURS] [--matches N] [--allow-partial]
pi-session-catalog inspect (--path SESSION.jsonl | --id SESSION_ID)
pi-session-catalog read --path SESSION.jsonl [--leaf ID] [--leaf-byte-start N] [--entry ID] [--entry-byte-start N] [--before N] [--after N]
pi-session-catalog image --path SESSION.jsonl --entry ID [--byte-start N] --part N --output FILE
pi-session-catalog verify (--path SESSION.jsonl | --cwd /project | --all)
pi-session-catalog status [--integrity]
pi-session-catalog rebuild-fts
```

`--entry-byte-start` and `--leaf-byte-start` independently disambiguate duplicate IDs. `--byte-start` remains a compatibility locator (entry when `--entry` is present, otherwise leaf).

An incomplete `reconcile` prints its structured report and exits 2; supported partial `list`/`search` responses print results and coverage and exit 0. Consumers explicitly permitting incomplete reconciliation or `--allow-partial` must parse these receipts before treating the exit status as fatal, while rejecting unexpected statuses, malformed output, or stderr diagnostics. Exact-source operations remain fail-closed. Source corruption remains authoritative and is never edited or hidden. List/search coverage includes receipt and catalog-snapshot timestamps rather than claiming unreconciled live-source freshness.

Status is cheap by default; `--integrity` opts into `PRAGMA integrity_check`. Use `--no-metadata` to disable broad metadata matching. Use `--role` and `--type` repeatedly for entry filters; specifying either also excludes metadata-only matches. A `toolResult` or `bashExecution` role automatically admits bounded tool evidence. `--max-chars` bounds read/list text, `--matches` requests multiple search entries, and `--compact` emits one-line JSON. `--` terminates options before a dash-leading search query.

## Search diagnostics

Pi's `SessionStoreClient` records catalog subprocess requests in `~/.pi/agent/cache/session-search-diagnostics.jsonl`. `PI_SESSION_SEARCH_LOG_PATH` overrides the path for isolated tests. The owner-only log rotates at approximately 2 MiB to one `.1` file; rotation under concurrent writers is best effort and logging failures never fail retrieval.

Records include operation, mode, scope kind, limits, query character count, parent/child PIDs, elapsed time, output byte counts, exit status, error category, partial-coverage count, and available backend timing/candidate counters. They omit query text, source paths, returned excerpts, and raw error strings, which can echo a query. Correlate timestamps and the parent PID with `agent-time-telemetry` and the authoritative session's tool call for full arguments/errors. The derived database's `file_failures`, `files.last_error`, and `reconcile_scopes` hold indexing failure details.

The new client logging and process cleanup load after Pi reload/restart. Backend CLI changes apply on the next invocation. Phrase/regex broad-bank scans still enumerate text and can exceed the client deadline; use BM25 for discovery and scope literal/regex searches to selected sources when possible. Exact-source requests remain strict, while opted-in broad partial searches retain coverage warnings.

## Benchmark safety

`pi-session-catalog-benchmark --fresh` requires an explicit non-default `--database`, refuses existing writer/reaper locks, and never deletes lock files. Reports default to `~/tmp`.

## Deliberate limits

- Append sentinels sample the already-indexed prefix; newly scanned ranges are hashed when a concurrent source change requires revalidation. Sentinels are not proof against every unsampled historical in-place edit. `verify` reparses each selected indexed prefix and deliberately ignores an unfinished tail.
- Extracted conversation text is bounded to 2 MiB per part and tool text/metadata to smaller bounds applied after role discovery, independent of JSON key order. At most 256 content parts are normalized per entry; `partCoverage` reports omitted array parts. Retained-tail state is limited to context-bearing parts and fixed provenance fields. Coverage marks truncation; raw JSONL remains authoritative.
- FTS produces candidates over each entry's full extracted text, then allowed part ranges are verified with unicode61-compatible diacritic folding. SQL excludes entries with no permitted conversation/summary parts before loading normalized content, so tool-only phrase/regex rows are skipped by default.
- Regex and phrase modes scan bounded normalized entry text and are intended for interactive result limits, not arbitrary analytics.

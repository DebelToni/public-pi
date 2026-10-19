# Subagents

## Project trust

Project templates use Pi's existing project-trust decision. Starting one-off agents, creating named threads and continuing saved work do not request additional interactive approval, including in headless sessions. Untrusted projects still cannot supply templates; explicit project-only launches and resumptions remain blocked.

## Model sizes

The available sizes are `small` (GPT-6 Luna/high), `big` (GPT-6.1 Sol/low) and `biggest` (GPT-6.1 Sol/high). Template defaults still apply when size is omitted; otherwise the default is `big`. Saved threads, templates and continuation records use their size's current policy on their next launch, without rewriting stored history. These defaults do not change the main session's reasoning. New processes or `/reload` activate the updated extension; already-running children retain their launch settings.

## Forced deliberate children

A forced Ultra process delegates exclusively through its current personal `codex-pro` provider. Local model/account changes remain available; delegation is refused while the parent is on another provider.

`../lib/pi-subprocess.ts` reads the process-local `Symbol.for("pi-codex-ultra.force-model.v1")` latch. It never activates force from environment variables. Each actual child launch validates the immutable Ultra launcher by canonical path containment and adds `--force-model` before prompts, with an explicit personal provider and model. Stock Pi fallback is refused in force mode.

Model-size aliases retain their existing precedence. Foreign-qualified requests are rebased to the same model ID under `codex-pro`, using the live model registry, including dynamically available Astra. An unavailable model falls back to the parent's current personal model; missing personal authentication/catalog authority fails closed. Requested reasoning suffixes are preserved, otherwise the current parent reasoning is used. The oracle's explicit `--thinking` remains authoritative.

Single, parallel, fan-in, chain, continuation and named launches pass live parent context. Both oracle aliases use the same policy. Named creation and completed-result recovery do not launch processes and need no launcher validation. A policy refusal keeps pending/interrupted work and its checkpoint rather than deleting the saved child session.

Mutable launch sites strip any inherited force marker; Ultra creates and consumes a fresh one-process marker for each forced Pi child. Forced launches also discard stale launcher-handoff markers. Ordinary subagents retain their existing fresh-launch policy; ordinary oracles retain PATH lookup and handoff behavior. Arbitrary shell children receive no force marker.

### Activation

New Pi processes load these mutable extension changes. Existing processes retain their loaded code until an explicitly authorized reload; none were reloaded or restarted for this change. No immutable release or repository push is required.

### Verification

The focused tests cover the policy, all launch/continuation branches, named recovery, exact synthetic oracle fixtures, nested children and ordinary behavior. Run them with an isolated agent directory and without inherited `PI_*` state:

```sh
work=$(mktemp -d "$HOME/tmp/pi-force-tests.XXXXXX")
mkdir "$work/agent"
env -i HOME="$HOME" PATH="$PATH" TMPDIR="$work" PI_CODING_AGENT_DIR="$work/agent" \
  bun test ./extensions/lib/pi-subprocess.test.ts ./extensions/subagent/force-inheritance.test.ts
```

The pre-existing combined Bun suite has one quota-continuation assertion failure and seven `node:test` nesting/import failures. The launcher's existing `SIGUSR2` forwarding limitation is separate; this change leaves signal handling and continuation lease ownership unchanged.

## Continuing after quota exhaustion

`/continue` resumes outstanding named invocations and one-off/parallel/chain/fan-in work before starting another main-agent turn. Provider usage/quota/rate-limit failures are saved as resumable interruptions, not terminal failures; ordinary errors remain terminal. Saved quota-error messages do not count as completed work during restart recovery.

Completed siblings are not rerun. Named invocations keep durable per-call receipts, including a new prompt waiting behind an earlier interrupted task. Results are delivered as hidden parent context with statuses and outputs; only after outstanding work finishes does the main model resume. If quota is still exhausted, work remains paused and another `/continue` retries it. Repeating `/continue` after result delivery continues the parent without relaunching completed children.

Recovery needs the saved child transcript. Older named quota failures can be recovered when their recorded resume handle survives; previously deleted one-off child sessions cannot be reconstructed. This command does not bypass provider limits or change forced-provider policies.

### One-off discovery and legacy results

Terminal-status checks in continuation lookup and `agent_end` are read-only. Completed or failed legacy inline results are not normalized or spilled merely to decide that no work remains; running results still become recoverable interruptions when selected.

Discovery projects only manifest metadata, rejects unrelated call IDs/owners as soon as known, and lazily decodes selected payloads. `agent_end` targets the exact parent session ID and, when recorded, session file; only actionable receipts are hydrated. Cross-fork source receipts remain discoverable by the inherited tool-call ID, with ready/resolved receipts ahead of newer pending work. Each fork keeps its own mutable manifest and delivery state.

Version-1 manifests remain readable without rewriting them or creating sidecars. New writes place metadata before args/details. Legacy fields may appear after payloads, requiring linear streaming I/O, but metadata scanning uses 64 KiB chunks and never materializes args/details. Keys are limited to 1 KiB, metadata scalar values to 64 KiB, and skipped JSON nesting to 256 levels. Missing manifests are absent. Global enumeration skips corrupt or unreadable historical files that cannot be positively matched to the target. Known candidate IDs or exact owner/candidate file identity keep relevant corruption strict, including malformed owner metadata; explicit owner-targeted reads and selected payload errors also propagate. Unrelated files rejected by identity are not fully validated. Selected legacy payloads are still decoded whole and may be normalized for actual continuation/adoption; this is not a whole-process heap bound.

### Explicit named continuation

`invoke_subagent` accepts exactly one action with the named thread:

```ts
invoke_subagent({ name: "worker", prompt: "next task" })
invoke_subagent({ name: "worker", continue: true })
```

The prompt form keeps the existing behavior: it first recovers interrupted work, then sends the new follow-up. `continue: true` only recovers the pending task and never appends another prompt. If the thread has no pending work, it returns an idle no-op status without launching a child. Prompt and continue are mutually exclusive, and continue must be exactly `true`.

Continue-only receipts are checkpointed like prompt receipts. Restart recovery reuses a completed receipt without rerunning it, while an interrupted receipt resumes from its saved handle. Forked parents receive remapped private handles and preserve the same continue-only mode.

### Ultra automatic recovery integration

The extension handles the generic `pi:continue-request` event with the same child-first orchestration. It synchronously claims `request.run`, calls `beforeWork("outstanding" | "main")` before execution, and calls `onStarted()` immediately after submitting the final parent trigger. The promise resolves only after the parent settles; paused, busy, cancelled, or failed recovery rejects without starting the parent. Ultra releases its outer recovery lease before outstanding child work and keeps input blocked until that final trigger.

The legacy `subagent:continue-request` channel remains supported, including its explicit `target: "main"` bypass. Existing Ultra releases using that bypass do not gain child-first automatic recovery from `/reload` alone: they require the corresponding Ultra release and a new process. Other subagent systems can implement the generic event contract independently; Ultra provides parent-only fallback when nobody claims it.

## Named threads across forks

A parent `/fork`, `/clone`, or `/fork-tmux` automatically receives independent copies of the named threads carried in its selected branch. Restoration runs before startup tool descriptions are registered; `invoke_subagent` and `export_subagent` also recover a missing inherited name on demand. Existing fork-local state takes precedence, and reopening a session does not clone it again. Restoration starts no child process or model call.

Creation and invocation checkpoints pin each child's conversation leaf, configuration, and interrupted-task state. Immutable checkpoint files remain in private named storage; the parent transcript carries only a reference. Later source work is excluded even if the fork starts afterward. Each copy receives a new child session ID, private transcript, and parent namespace. Both recovery handles point to the copy, with stale process IDs removed. Child working directories and working files remain shared.

Older forks without checkpoints are recovered from their recorded successful create/invoke results, tracing the original record owner through verified ancestry. Missing historical messages, checkpoints, or child files produce a per-thread warning instead of substituting newer history. Only matching copied session entry IDs/payloads authorize inheritance: synthetic context copies and unrelated same-name sessions do not qualify. Ancestor transcripts are read incrementally, retaining only candidate entries; child copies are written record-by-record, avoiding Node's whole-string limit for multi-gigabyte JSONL files. No global session scan is used. `/tree` navigation retains its existing same-session named-state semantics.

Storage lives under `subagent-runs/named/<sha256(parent-session-id)>/`: `<name>.json` holds local state, `children/` holds transcripts, and `checkpoints/` holds immutable snapshots. Directories are `0700` and files `0600`. Shared per-name leases protect creation, invocation and adoption; corrupt occupied state is never overwritten.

Fork and named-thread regressions:

```sh
mkdir -p "$HOME/tmp/named-fork-tests"
TMPDIR="$HOME/tmp/named-fork-tests" env -u PI_SUBAGENT bun test \
  extensions/subagent/named-subagent-forks.test.ts extensions/subagent/named-subagents.test.ts
```

## Live subagent panel

`/subagents` or `Alt+A` opens a borderless full-screen panel of the current parent session's queued/running invocations. Only tabs and metadata sit above the history; there is no key legend or footer. Horizontal tabs retain queue order, and selecting an agent jumps to its latest output. Named-thread creation is idle; only invocation appears. Terminal runs disappear immediately, and the final run's removal closes the panel. Nothing is persisted or restored by the monitor.

| Key | Action |
| --- | --- |
| Left / Right | Switch agent tabs (Tab / Shift+Tab also work) |
| Up / Down | Scroll the selected agent by one page with two lines of overlap |
| Alt+Up / Alt+Down, PageUp / PageDown | Scroll one page |
| Home / End | First message / latest work; End resumes following new output |
| Ctrl+O | Expand/collapse tool output |
| Ctrl+Alt+O (Ctrl+Option+O on Mac) | Notes-only view: hide both tools and thinking |
| Ctrl+T | Show/collapse emitted thinking |
| q, Esc, Ctrl+C, Alt+A | Close without aborting any agent |

History starts with the exact delegated task or invocation prompt, followed by chronological notes, thinking and tool calls updated in place with partial/final results. Inherited parent history and template system instructions are not replayed. Visibility controls are local to the panel and preserve the parent's tool-hide state. New tools and streamed output stay in view while following the bottom; deliberately scrolling up pauses following until you return to the bottom or select an agent.

Rendering reuses Pi's public `UserMessageComponent`, `AssistantMessageComponent` and `ToolExecutionComponent`, with native built-in tool renderers. Child-only custom tools use a generic native fallback because JSON cannot carry renderer functions. Rendering does not execute tools, read files for edit previews, or start native tool timers. Recorded edit diffs remain visible; expanded active/failed edits expose their arguments. Images become placeholders, and encrypted/redacted thinking payloads and signatures are excluded.

The initial prompt is pinned alongside at most 240 retained history entries and 80 tools. An omission notice marks evicted entries. Retained expanded text wraps and remains scrollable; collapsed tools retain native previews. Only blocks near the viewport are materialized, so expansion and resizing do not render every offscreen result.

Focused verification:

```sh
mkdir -p "$HOME/tmp/subagent-panel-tests"
TMPDIR="$HOME/tmp/subagent-panel-tests" env -u PI_SUBAGENT bun test \
  extensions/subagent/monitor.test.ts extensions/subagent/monitor-store.test.ts \
  extensions/subagent/monitor-messages.test.ts extensions/tool-hide/index.test.ts
```

## Pi heap policy

Local `~/.pi/agent/bin/pi` launches set `NODE_OPTIONS=... --max-old-space-size=8192`. `../lib/pi-subprocess.ts` applies the same policy to deliberate children, including direct versioned-launcher calls. Other Node options are preserved; the login shell and unrelated Node services are unchanged. The limit permits up to 8 GiB of old-space; it does not reserve that RAM and is not a whole-process RSS cap.

Existing processes keep their startup heap limit until restarted. Reloading an idle parent activates the disk-backed extension and child-launch policy without changing that parent's existing heap. `Pi:1` was restarted with the new limit after the selected migration.

## Disk-backed results (schema v1)

New runs write each completed child message to private disk storage immediately. `SingleResult.messages` stays `[]` throughout execution, including updates, named receipts/checkpoints, and continuation manifests. The parent retains status, usage, errors, the complete `finalText`, `sessionId`, and durable `sessionFile`. `resume` still identifies the child boundary for recovery. Successful one-offs and delivered continuation children are no longer deleted. Existing parallel previews and continuation delivery limits are unchanged; the stored `finalText` itself remains exact.

Migration-aware named ancestry accepts an inline/disk representation difference only for `invoke_subagent`'s `details.result`. Entry ID, timestamp, tool-call ID, content, remaining details and all result metadata must still match; only native fork `parentId` re-chaining is ignored as before. Derived `finalText`/`sessionFile` must match normalization. Every inline message is verified against the entire corresponding immutable backing record with streamed SHA-256 checks, including intermediate messages, not just the last-message fingerprint. Disk/disk comparisons may differ in directory only when all record bytes and remaining reference metadata match. Missing records raise a per-thread restoration failure; nothing is hydrated into a full transcript or rewritten during comparison.

A truncated final child append is recovered into a private, synced sibling session file. The source file, including its interrupted bytes, remains byte-for-byte intact; a `subagent-tail-recovery` custom record links the original path and byte offsets. Complete entry IDs and parent links survive, and named resume handles follow the recovered file. Malformed newline-terminated records still fail loudly, including when followed by a truncated tail.

The live monitor keeps its existing bounded, image-sanitized history. Collapsed result cards do no disk reads; expanded cards show final text and the transcript directory. No monitor UI rewrite or automatic historical hydration is involved. Named restore/checkpoint identity scans project only top-level session metadata without parsing message payloads. Fork copies and terminal recovery process child records individually, never retaining a whole child conversation in `SessionManager`.

### Normalization API for selected-session migration

Import from **`/home/user/.pi/agent/extensions/subagent/result-store.ts`** (also re-exported by `index.ts`):

```ts
normalizeSingleResult(result: SingleResult, root?: string): SingleResult
readResultPage(result, start = 0, limit = 16, maxBytes = 1048576)
// -> { messages: Message[], next?: number, total: number }
```

`normalizeSingleResult` accepts an already-decoded legacy result, writes its inline messages individually, and returns a new lean object. It preserves other result fields and derives the complete final assistant text. Already-normalized results are copied without opening backing files. It does not mutate the argument, open/rewrite/repair any session, launch a child, or traverse arbitrary nested details. Apply it explicitly to selected `details.result` / `details.results[]` and saved `pending` / `continuation.result` values as appropriate. Session JSONL is append-only: this helper is **not** permission to overwrite existing entries or append duplicate IDs. The migration owner must preserve original evidence and enclosing entry IDs, `parentId`, branch structure, and delivery semantics. No real-session migration was run here.

Returned result additions:

```ts
{
  messages: [],
  finalText: string,                    // complete, never truncated
  sessionFile?: string,                 // from legacy resume.filePath when available
  transcript?: {
    version: 1,
    directory: string,                  // absolute private directory
    messageCount: number,               // immutable visible prefix [0, messageCount)
    lastMessage?: {
      role: string, timestamp?: number, sha256: string
    }                                  // exact legacy named-fork tail matching
  }
}
```

Default storage: `<getAgentDir()>/subagent-runs/results/<uuid>/`, or `<root>/<uuid>/` when supplied. Each `0.json`, `1.json`, etc. is an immutable `0600` record in a `0700` directory:

```ts
{ version: 1, sha256: string, message: Message }
```

The digest is lowercase SHA-256 of UTF-8 `JSON.stringify(message)`, without a newline. Files and directory entries are synced before publishing a reference. Resuming creates another directory and hard-links the prior visible prefix, then appends fresh records; earlier references never advance or change. Child session JSONL remains separately durable, with its original IDs and parent links. A migrated legacy result whose child session was previously deleted still preserves its inline message evidence, but cannot regain that missing resumable session.

`readResultPage` is explicit access, not restore-time hydration. Windows are capped at 32 records and 4 MiB of serialized backing data, with no cache. Missing files, invalid JSON/schema, or checksum corruption throw rather than substituting inline/empty data. An individually oversized record throws with its exact path, so a caller can explicitly inspect that raw record using bounded byte reads or streaming image/text extraction. Legacy inline results and all built-in JSON stream roles, including system messages, remain supported by the reader and renderers. Final output is available without opening any transcript.

### Verification and limits

Run each existing Bun test file separately to avoid Bun's cross-file `node:test` nesting issue. Use an isolated `PI_CODING_AGENT_DIR` (with a `general`/big fixture template for the schema test) and `TMPDIR`.

Validation: 157 subagent tests passed across all 16 test files, run in separate Bun processes. The shared child-launch helper adds 9 passing tests; the wrapper has a passing Python heap-policy test. Preserve the installed Ultra profile environment for the existing quota-recovery integration fixture, which skips recovery without its profile. The unrelated resume-by-title test still uses the retired Mac `~/Documents/wiki` fixture and fails against the existing DGX `~/wiki` guard. A direct `tsc` check still reports four pre-existing `JsonValue` narrowing errors in `named-subagents.ts`, confirmed against the original file.

`result-store.test.ts` exercises repeated 8 MiB image-heavy runs, bounded retained parent JSON/heap after GC, named reuse, exact legacy normalization, lazy rendering/access, record integrity and successful transcript retention. `session-records.test.ts` verifies metadata-only scanning across large multibyte payloads with identity fields after the payload, and byte-preserving session appends. Review regressions cover 50 legacy/streamed system messages, both inline/disk ancestry directions and tamper rejection, hardlink fsync ordering, truncated-tail terminal/continuation recovery, named-handle remapping, and malformed completed-record refusal. Existing quota, monitor and wrap tests cover recovery compatibility.

Tradeoffs: raw messages are duplicated on disk alongside child sessions; no automatic garbage collector is introduced. Final text, stderr and the existing live-monitor text remain inline, so these are not global heap bounds. Child recovery/fork copying and legacy normalization can transiently parse/serialize one full record; a single legacy record beyond the runtime's string limit still needs a streaming migration outside this helper. Metadata scans use bounded payload memory but retain an entry-identity index and cost linear I/O per scan. This change requires newly loaded extension code; no existing sessions were reloaded and no launcher settings were changed.

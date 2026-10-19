#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import {
	catalogStatus,
	closeCatalog,
	defaultCatalogPath,
	discoverSessionFiles,
	encodeSessionBucket,
	extractCatalogImage,
	inspectCatalogSession,
	listCatalogSessions,
	openCatalog,
	readCatalogSession,
	reconcileCatalog,
	scanSessionFile,
	searchCatalog,
	verifyCatalog,
} from "../lib/session-catalog/index.mjs";

const CLI = path.join(path.dirname(new URL(import.meta.url).pathname), "pi-session-catalog");
const BENCHMARK_CLI = path.join(path.dirname(new URL(import.meta.url).pathname), "pi-session-catalog-benchmark");
const iso = (ms) => new Date(ms).toISOString();
function header(id, cwd, timestamp = 1_700_000_000_000, extra = {}) { return { type: "session", version: 3, id, timestamp: iso(timestamp), cwd, ...extra }; }
function message(id, parentId, timestamp, role, content, extra = {}) {
	return { type: "message", id, parentId, timestamp: iso(timestamp), message: { role, content, timestamp, ...extra } };
}
function entry(type, id, parentId, timestamp, extra = {}) { return { type, id, parentId, timestamp: iso(timestamp), ...extra }; }
function writeJsonl(file, rows, trailing = true) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, rows.map(JSON.stringify).join("\n") + (trailing ? "\n" : ""), { mode: 0o600 });
}
function appendJsonl(file, rows, trailing = true) { fs.appendFileSync(file, rows.map(JSON.stringify).join("\n") + (trailing ? "\n" : "")); }
function fixture() {
	const root = fs.mkdtempSync(path.join(os.homedir(), "tmp", "pi-session-store-test-"));
	const sessionsRoot = path.join(root, "sessions"), cwd = path.join(root, "project");
	const bucket = path.join(sessionsRoot, encodeSessionBucket(cwd));
	const databasePath = path.join(root, "cache", "session-store.sqlite3");
	fs.mkdirSync(bucket, { recursive: true });
	return { root, sessionsRoot, cwd, bucket, databasePath };
}
function runCli(args) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [CLI, ...args], { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "", stderr = "";
		child.stdout.on("data", (chunk) => stdout += chunk); child.stderr.on("data", (chunk) => stderr += chunk);
		child.on("error", reject); child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}
function runBenchmark(args) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [BENCHMARK_CLI, ...args], { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "", stderr = "";
		child.stdout.on("data", (chunk) => stdout += chunk); child.stderr.on("data", (chunk) => stderr += chunk);
		child.on("error", reject); child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

assert.equal(path.basename(defaultCatalogPath("/Volumes/example/pi/sessions")), "session-store.sqlite3");

test("normalizes every ancestry entry and aggregates entry-level search without private/tool leakage", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const time = 1_700_000_000_000, file = path.join(f.bucket, "normalized.jsonl");
	writeJsonl(file, [
		header("same-session-id", f.cwd, time),
		message("u", null, time + 1, "user", "Find queue recovery"),
		message("a", "u", time + 2, "assistant", [
			{ type: "thinking", thinking: "PRIVATE_COT_NEVER_STORE" },
			{ type: "text", text: "Durable recovery is ready" },
			{ type: "toolCall", id: "call", name: "bash", arguments: { path: "/secret/tool-only-path", status: "probe" } },
		]),
		message("tool", "a", time + 3, "toolResult", [{ type: "text", text: "TOOL_ONLY_EVIDENCE " + "z".repeat(2 * 1024 * 1024) }], { toolCallId: "call", toolName: "bash", isError: false }),
		entry("custom", "state", "tool", time + 4, { customType: "fixture", data: { retained: true, giantIgnoredState: "q".repeat(2 * 1024 * 1024) } }),
		entry("compaction", "compact", "state", time + 5, { summary: "compaction summary marker", tokensBefore: 99 }),
		entry("branch_summary", "summary", "u", time + 6, { summary: "branch summary marker", fromId: "compact" }),
		entry("session_info", "name", "summary", time + 7, { name: "Normalized fixture" }),
	]);
	const result = await reconcileCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd });
	assert.equal(result.created, 1); assert.equal(result.failed, 0); assert.equal(result.entries, 7);
	assert.deepEqual(listCatalogSessions({ databasePath: f.databasePath, cwd: f.cwd }), [{
		path: file, id: "same-session-id", cwd: f.cwd, name: "Normalized fixture", created: iso(time), modified: iso(time + 2),
		messageCount: 3, firstMessage: "Find queue recovery",
	}]);
	assert.equal(searchCatalog("durab recover", { databasePath: f.databasePath, cwd: f.cwd }).results[0].matchedEntryId, "a");
	assert.equal(searchCatalog("compaction marker", { databasePath: f.databasePath }).results[0].matchedEntryId, "compact");
	assert.equal(searchCatalog("branch summary", { databasePath: f.databasePath }).results[0].matchedEntryId, "summary");
	assert.equal(searchCatalog("TOOL_ONLY_EVIDENCE", { databasePath: f.databasePath }).results.length, 0);
	assert.equal(searchCatalog("TOOL_ONLY_EVIDENCE", { databasePath: f.databasePath, includeTools: true }).results[0].matchedRole, "toolResult");
	assert.equal(searchCatalog("PRIVATE_COT_NEVER_STORE", { databasePath: f.databasePath, includeTools: true }).results.length, 0);
	assert.equal(searchCatalog("recovery", { databasePath: f.databasePath, roles: ["assistant"] }).results.length, 1);
	assert.equal(searchCatalog("recovery", { databasePath: f.databasePath, types: ["compaction"] }).results.length, 0);
	const db = openCatalog(f.databasePath, { readOnly: true });
	try {
		assert.equal(db.prepare("SELECT COUNT(*) count FROM entries").get().count, 7);
		assert.equal(db.prepare("SELECT COUNT(*) count FROM entries WHERE type='custom' AND content_chars=0").get().count, 1);
		assert.equal(db.prepare("SELECT extraction_truncated FROM parts WHERE kind='toolResult'").get().extraction_truncated, 1);
		assert.equal(db.prepare("SELECT COUNT(*) count FROM entry_content WHERE text LIKE '%PRIVATE_COT%'").get().count, 0);
		const toolArgs = db.prepare(`SELECT substr(c.text,p.text_start+1,p.text_end-p.text_start) text FROM parts p
			JOIN entry_content c ON c.entry_pk=p.entry_pk WHERE p.kind='toolCall'`).get().text;
		assert.deepEqual(JSON.parse(toolArgs), { path: "/secret/tool-only-path", status: "probe" });
		assert.ok(fs.statSync(f.databasePath).size < 1024 * 1024);
	} finally { closeCatalog(db); }
});

test("streams a giant image, stores only hash/pointer, validates offsets, and extracts exact bytes", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const bytes = crypto.randomBytes(4 * 1024 * 1024 + 7), file = path.join(f.bucket, "image.jsonl");
	writeJsonl(file, [header("image", f.cwd), message("img", null, 1_700_000_001_000, "user", [
		{ type: "text", text: "image prompt" }, { type: "image", mimeType: "application/octet-stream", data: bytes.toString("base64") },
	])]);
	const indexed = await reconcileCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd });
	assert.ok(indexed.maxLineBytes > 5 * 1024 * 1024);
	const status = catalogStatus({ databasePath: f.databasePath });
	assert.ok(status.databaseBytes < 1024 * 1024, `database unexpectedly contains base64 (${status.databaseBytes})`);
	const output = path.join(f.root, "decoded.bin");
	const extracted = await extractCatalogImage({ databasePath: f.databasePath, path: file, entry: "img", part: 1, output });
	assert.equal(extracted.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
	assert.deepEqual(fs.readFileSync(output), bytes);
	const db = openCatalog(f.databasePath, { readOnly: true });
	try {
		const row = db.prepare("SELECT byte_start,byte_end,source_sha256 FROM entries WHERE entry_id='img'").get();
		const raw = fs.readFileSync(file).subarray(row.byte_start, row.byte_end);
		assert.equal(crypto.createHash("sha256").update(raw).digest("hex"), row.source_sha256);
	} finally { closeCatalog(db); }
	fs.appendFileSync(file, JSON.stringify(entry("custom", "later", "img", Date.now())) + "\n");
	await assert.rejects(() => extractCatalogImage({ databasePath: f.databasePath, path: file, entry: "img", part: 1, output }), /generation (?:differs|changed)/);
});

test("read is branch-aware, preserves duplicate IDs, labels default leaf, and bounds output", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const file = path.join(f.bucket, "tree.jsonl"), time = 1_700_000_000_000;
	writeJsonl(file, [header("tree", f.cwd, time),
		message("dup", null, time + 1, "user", "root text"),
		message("left", "dup", time + 2, "assistant", "left branch"),
		message("dup", "dup", time + 3, "user", "second duplicate " + "x".repeat(200)),
		entry("custom", "leaf", "dup", time + 4, { customType: "state", data: 1 }),
	]);
	await reconcileCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd });
	const branchRead = readCatalogSession({ databasePath: f.databasePath, path: file, leaf: "leaf" });
	const duplicateRef = branchRead.entries.filter((item) => item.id === "dup").at(-1).entryRef;
	const read = readCatalogSession({ databasePath: f.databasePath, path: file, leaf: "leaf", entry: "dup", byteStart: duplicateRef.byteStart, before: 1, after: 1, maxChars: 20 });
	assert.equal(read.leafSelection, "explicit"); assert.equal(read.coverage.branchEntries, 3);
	assert.equal(read.coverage.duplicateEntryMatches, 2); assert.equal(read.coverage.textTruncated, true);
	assert.deepEqual(read.entries.map((item) => item.id), ["dup", "dup", "leaf"]);
	const defaultRead = readCatalogSession({ databasePath: f.databasePath, path: file, limit: 1 });
	assert.match(defaultRead.leafSelection, /not-guaranteed-live-leaf/); assert.equal(defaultRead.entries[0].id, "leaf");
	const cli = await runCli(["read", "--database", f.databasePath, "--path", file, "--leaf", "left", "--compact"]);
	assert.equal(cli.code, 0, cli.stderr); assert.deepEqual(JSON.parse(cli.stdout).entries.map((item) => item.id), ["dup", "left"]);
});

test("indexes the opening completed-LF snapshot, defers tails, and resumes the exact offset", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const file = path.join(f.bucket, "append.jsonl"), time = 1_700_000_000_000;
	writeJsonl(file, [header("append", f.cwd, time), message("u", null, time + 1, "user", "before append")]);
	await reconcileCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd });
	appendJsonl(file, [message("a", "u", time + 2, "assistant", "complete delta")]);
	const partial = JSON.stringify(message("p", "a", time + 3, "user", "partial delta"));
	fs.appendFileSync(file, partial);
	const deferred = await reconcileCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd });
	assert.equal(deferred.failed, 0); assert.equal(deferred.scopeComplete, true); assert.equal(deferred.appended, 1);
	assert.equal(deferred.deferred, 1); assert.equal(searchCatalog("complete delta", { databasePath: f.databasePath }).results.length, 1);
	assert.equal(searchCatalog("partial delta", { databasePath: f.databasePath }).results.length, 0);
	const status = catalogStatus({ databasePath: f.databasePath });
	assert.equal(status.deferredFiles, 1); assert.equal(status.deferredBytes, Buffer.byteLength(partial)); assert.equal(status.fresh, true);
	const deferredRead = readCatalogSession({ databasePath: f.databasePath, path: file });
	assert.equal(deferredRead.coverage.sourcePrefixMatches, true); assert.equal(deferredRead.coverage.sourceMatchesSnapshot, true);
	assert.equal(deferredRead.coverage.deferredTailBytes, Buffer.byteLength(partial));
	const db = openCatalog(f.databasePath, { readOnly: true });
	let exactOffset;
	try { exactOffset = db.prepare("SELECT indexed_offset FROM files WHERE path=?").get(file).indexed_offset; }
	finally { closeCatalog(db); }
	assert.equal(fs.readFileSync(file).subarray(exactOffset).toString(), partial);
	fs.appendFileSync(file, "\n");
	const appended = await reconcileCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd });
	assert.equal(appended.appended, 1); assert.equal(appended.failed, 0); assert.equal(appended.deferred, 0);
	assert.equal(searchCatalog("partial delta", { databasePath: f.databasePath }).results.length, 1);
});

test("scanner tolerates append during scan while publishing only its opening snapshot", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const file = path.join(f.bucket, "concurrent.jsonl"), time = 1_700_000_000_000;
	writeJsonl(file, [header("concurrent", f.cwd, time), message("u", null, time + 1, "user", "opening")]);
	let appended = false;
	const scan = await scanSessionFile(file, { sourceRoot: fs.realpathSync(f.sessionsRoot), batchEntries: 1, onBatch() {
		if (!appended) { appended = true; appendJsonl(file, [message("later", "u", time + 2, "assistant", "after opening")]); }
	} });
	assert.equal(scan.records.length, 0); assert.equal(scan.metrics.records, 1); assert.ok(scan.ending.size > scan.indexedOffset);
	assert.equal(scan.deferredTailBytes, scan.ending.size - scan.indexedOffset);
	const resumed = await scanSessionFile(file, { sourceRoot: fs.realpathSync(f.sessionsRoot), startOffset: scan.indexedOffset,
		startOrdinal: scan.nextOrdinal, expectedSentinels: JSON.stringify(scan.sentinels) });
	assert.deepEqual(resumed.records.map((record) => record.entry.id), ["later"]);
	const raw = fs.readFileSync(file); const marker = raw.indexOf("opening"); let changed = false;
	await assert.rejects(() => scanSessionFile(file, { sourceRoot: fs.realpathSync(f.sessionsRoot), batchEntries: 1, onBatch() {
		if (!changed) { changed = true; const writeFd = fs.openSync(file, "r+"); try { fs.writeSync(writeFd, Buffer.from("changed"), 0, 7, marker); } finally { fs.closeSync(writeFd); } }
	} }), /prefix changed/);
});

test("detects rewrites, inode renames, duplicate session IDs, and scoped deletion", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const one = path.join(f.bucket, "one.jsonl"), copy = path.join(f.bucket, "copy.jsonl");
	writeJsonl(one, [header("duplicate-session", f.cwd), message("u", null, 1_700_000_001_000, "user", "alpha source")]);
	writeJsonl(copy, [header("duplicate-session", f.cwd), message("u", null, 1_700_000_001_000, "user", "copy source")]);
	await reconcileCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd });
	assert.equal(listCatalogSessions({ databasePath: f.databasePath }).length, 2);
	const moved = path.join(f.bucket, "moved.jsonl"); fs.renameSync(one, moved);
	const rename = await reconcileCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd });
	assert.equal(rename.created, 0); assert.equal(searchCatalog("alpha source", { databasePath: f.databasePath }).results[0].path, moved);
	writeJsonl(moved, [header("duplicate-session", f.cwd), message("new", null, 1_700_000_002_000, "user", "omega rewrite")]);
	const rewrite = await reconcileCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd });
	assert.equal(rewrite.rebuilt, 1); assert.equal(searchCatalog("alpha source", { databasePath: f.databasePath }).results.length, 0);
	fs.unlinkSync(copy);
	assert.equal((await reconcileCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd, missingGraceMs: 0 })).missingMarked, 1);
	assert.equal((await reconcileCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd, missingGraceMs: 0 })).missingDeleted, 1);
	assert.equal(listCatalogSessions({ databasePath: f.databasePath, cwd: f.cwd }).length, 1);
});

test("malformed JSON, source symlinks, cancellation, and verification fail loudly", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const valid = path.join(f.bucket, "valid.jsonl"), malformed = path.join(f.bucket, "bad.jsonl");
	writeJsonl(valid, [header("valid", f.cwd), message("u", null, 1_700_000_001_000, "user", "verify marker")]);
	fs.writeFileSync(malformed, `${JSON.stringify(header("bad", f.cwd))}\n{"type":"message" broken}\n`);
	const result = await reconcileCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd });
	assert.equal(result.failed, 1); assert.equal(result.scopeComplete, false);
	assert.throws(() => searchCatalog("verify", { databasePath: f.databasePath }), /scope is incomplete/);
	const partial = searchCatalog("verify", { databasePath: f.databasePath, allowPartial: true });
	assert.equal(partial.results.length, 1); assert.equal(partial.coverage.scopeComplete, false); assert.equal(partial.coverage.partialResults, true);
	fs.unlinkSync(malformed);
	await reconcileCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd, missingGraceMs: 0 });
	await reconcileCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd, missingGraceMs: 0 });
	assert.equal((await verifyCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd })).ok, true);
	const controller = new AbortController(); controller.abort();
	await assert.rejects(() => reconcileCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd, signal: controller.signal }), { name: "AbortError" });
	const linked = path.join(f.bucket, "linked.jsonl"); fs.symlinkSync(valid, linked);
	assert.equal(discoverSessionFiles({ sessionsRoot: f.sessionsRoot, cwd: f.cwd }).files.some((item) => item.filePath === linked), false);
	const raw = fs.readFileSync(valid, "utf8"); fs.writeFileSync(valid, raw.replace("verify marker", "tampered marker"));
	const verification = await verifyCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd });
	assert.equal(verification.ok, false); assert.ok(verification.failures.some((failure) => failure.path === valid));
});

test("concurrent CLI writers serialize and search accepts a dash-leading query", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const file = path.join(f.bucket, "race.jsonl");
	writeJsonl(file, [header("race", f.cwd), message("u", null, 1_700_000_001_000, "user", "--priority before race")]);
	const args = ["reconcile", "--cwd", f.cwd, "--sessions-root", f.sessionsRoot, "--database", f.databasePath, "--compact"];
	const writers = await Promise.all([runCli(args), runCli(args), runCli(args)]);
	for (const writer of writers) assert.equal(writer.code, 0, writer.stderr);
	const search = await runCli(["search", "--cwd", f.cwd, "--database", f.databasePath, "--compact", "--", "--priority"]);
	assert.equal(search.code, 0, search.stderr); assert.equal(JSON.parse(search.stdout).results[0].id, "race");
	assert.equal((await verifyCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd })).ok, true);
});

test("scanner enforces one object per nonempty physical line without blank-line offset drift", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const file = path.join(f.bucket, "strict.jsonl");
	const h = JSON.stringify(header("strict", f.cwd));
	const m = JSON.stringify(message("u", null, 1_700_000_001_000, "user", "after blank"));
	fs.writeFileSync(file, `${h}\n   \n${m}\n`);
	const scan = await scanSessionFile(file, { sourceRoot: fs.realpathSync(f.sessionsRoot) });
	assert.equal(scan.records.length, 1); assert.equal(scan.records[0].entry.byteStart, Buffer.byteLength(`${h}\n   \n`));
	for (const invalid of [`${h}\n{} {}\n`, `${h}\n[]\n`, `${h}\n42\n`, `${h}\nnull\n`]) {
		fs.writeFileSync(file, invalid);
		await assert.rejects(() => scanSessionFile(file, { sourceRoot: fs.realpathSync(f.sessionsRoot) }), /exactly one JSON object|top-level JSON object/);
	}
});

test("empty and partial-header files defer safely; a completed header-only file indexes", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const file = path.join(f.bucket, "forming.jsonl");
	fs.writeFileSync(file, "");
	let result = await reconcileCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd });
	assert.equal(result.failed, 0); assert.equal(result.deferred, 1); assert.equal(listCatalogSessions({ databasePath: f.databasePath }).length, 0);
	fs.writeFileSync(file, JSON.stringify(header("forming", f.cwd)));
	result = await reconcileCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd });
	assert.equal(result.failed, 0); assert.equal(result.deferred, 1);
	fs.appendFileSync(file, "\n");
	result = await reconcileCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd });
	assert.equal(result.created, 1); assert.equal(result.entries, 0);
	assert.equal(listCatalogSessions({ databasePath: f.databasePath })[0].messageCount, 0);
});

test("retainedTail is normalized as bounded checkpoint parts with provenance and structured tool arguments", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const file = path.join(f.bucket, "tail.jsonl"), time = 1_700_000_000_000;
	writeJsonl(file, [header("tail", f.cwd, time), entry("compaction", "cp", null, time + 1, {
		summary: "checkpoint summary", firstKeptEntryId: "kept", tokensBefore: 123,
		retainedTail: [
			{ role: "user", content: "retained request", timestamp: time - 2 },
			{ role: "assistant", provider: "openai", model: "gpt-tail", api: "responses", stopReason: "toolUse", timestamp: time - 1,
				content: [{ type: "thinking", thinking: "TRANSIENT_TAIL_THINKING" },
					{ type: "toolCall", id: "call-tail", name: "read", arguments: { path: "/tmp/a b", nested: { count: 2, flags: [true, false] } } }] },
		],
	})]);
	await reconcileCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd });
	assert.equal(searchCatalog("retained request", { databasePath: f.databasePath }).results[0].matchedEntryId, "cp");
	assert.equal(searchCatalog("TRANSIENT_TAIL_THINKING", { databasePath: f.databasePath, includeTools: true }).results.length, 0);
	const read = readCatalogSession({ databasePath: f.databasePath, path: file });
	assert.deepEqual(read.entries[0].metadata, { firstKeptEntryId: "kept", tokensBefore: 123,
		retainedTail: { messages: 2, parts: 2, contentChars: 77, storedChars: 77, truncated: false } });
	const retained = read.entries[0].parts.filter((part) => part.metadata?.provenance === "retainedTail");
	assert.equal(retained.length, 2); assert.equal(retained[1].metadata.checkpointEntryId, "cp");
	assert.equal(retained[1].metadata.model, "gpt-tail"); assert.equal(retained[1].metadata.provider, "openai");
	assert.deepEqual(JSON.parse(retained[1].text), { path: "/tmp/a b", nested: { count: 2, flags: [true, false] } });
	assert.equal(retained[1].path, "/tmp/a b"); assert.equal(retained[1].toolCallId, "call-tail");
});

test("base64 image digest accepts arbitrary tokenizer chunking for padded and unpadded data", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	for (let length = 1; length <= 10; length++) {
		const bytes = Buffer.from(Array.from({ length }, (_, index) => (length * 17 + index) & 255));
		for (const unpadded of [false, true]) {
			const encoded = bytes.toString("base64").replace(unpadded ? /=+$/u : /$^/u, "");
			const file = path.join(f.bucket, `b64-${length}-${unpadded}.jsonl`);
			writeJsonl(file, [header(`b64-${length}-${unpadded}`, f.cwd), message("img", null, 1_700_000_001_000, "user",
				[{ type: "image", mimeType: "application/octet-stream", data: encoded }])]);
			for (const readBufferBytes of [1, 2, 3, 5, 7]) {
				const scan = await scanSessionFile(file, { sourceRoot: fs.realpathSync(f.sessionsRoot), readBufferBytes });
				assert.equal(scan.records[0].parts[0].imageSha256, crypto.createHash("sha256").update(bytes).digest("hex"));
				assert.equal(scan.records[0].parts[0].imageBytes, bytes.length);
			}
		}
	}
});

test("schema v2/v3 stores migrate structurally without rebuilding rows", (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	let db = openCatalog(f.databasePath);
	try {
		db.exec("DROP TABLE reconcile_scopes; ALTER TABLE files DROP COLUMN deferred_tail_bytes; ALTER TABLE entries DROP COLUMN metadata_json; PRAGMA user_version=2");
	} finally { closeCatalog(db); }
	db = openCatalog(f.databasePath);
	try {
		assert.equal(db.prepare("PRAGMA user_version").get().user_version, 4);
		assert.ok(db.prepare("PRAGMA table_info(files)").all().some((column) => column.name === "deferred_tail_bytes"));
		assert.ok(db.prepare("PRAGMA table_info(entries)").all().some((column) => column.name === "metadata_json"));
		assert.equal(db.prepare("SELECT COUNT(*) count FROM reconcile_scopes").get().count, 0);
	} finally { closeCatalog(db); }
	db = openCatalog(f.databasePath);
	try {
		db.exec("ALTER TABLE files DROP COLUMN first_message_chars; ALTER TABLE files DROP COLUMN first_message_truncated; ALTER TABLE parts DROP COLUMN image_source_base; ALTER TABLE parts DROP COLUMN image_retained_index; ALTER TABLE parts DROP COLUMN image_content_index; PRAGMA user_version=3");
	} finally { closeCatalog(db); }
	db = openCatalog(f.databasePath);
	try {
		assert.equal(db.prepare("PRAGMA user_version").get().user_version, 4);
		assert.ok(db.prepare("PRAGMA table_info(parts)").all().some((column) => column.name === "image_source_base"));
		assert.ok(db.prepare("PRAGMA table_info(files)").all().some((column) => column.name === "first_message_truncated"));
	} finally { closeCatalog(db); }
});

test("writer recovery removes abandoned staging and lock release cannot unlink a replacement owner", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const file = path.join(f.bucket, "recovery.jsonl");
	writeJsonl(file, [header("recovery", f.cwd), message("u", null, 1_700_000_001_000, "user", "recover")]);
	await reconcileCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd });
	let db = openCatalog(f.databasePath);
	try {
		const row = db.prepare("SELECT * FROM files WHERE path=?").get(file);
		db.prepare("UPDATE files SET index_status='indexing' WHERE file_id=?").run(row.file_id);
		db.prepare(`INSERT INTO entries(file_id,epoch,generation,ordinal,type,byte_start,byte_end,source_sha256)
			VALUES(?,?,?,?,?,?,?,?)`).run(row.file_id, row.active_epoch, row.active_generation + 1, row.next_ordinal, "custom", 0, 0, "abandoned");
	} finally { closeCatalog(db); }
	const lockPath = `${f.databasePath}.writer-lock`;
	fs.writeFileSync(`${lockPath}.reap`, `999999999\n${Date.now() - 5000}\nstale-reaper\n`);
	fs.writeFileSync(lockPath, `999999999\n${Date.now() - 5000}\nstale\n`);
	const recovered = await reconcileCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd, onFile() {
		fs.rmSync(lockPath); fs.writeFileSync(lockPath, `999999998\n${Date.now()}\nreplacement\n`);
	} });
	assert.equal(recovered.failed, 0); assert.equal(fs.existsSync(lockPath), true);
	db = openCatalog(f.databasePath, { readOnly: true });
	try { assert.equal(db.prepare("SELECT COUNT(*) count FROM entries e JOIN files f ON f.file_id=e.file_id WHERE e.generation>f.active_generation OR e.epoch<>f.active_epoch").get().count, 0); }
	finally { closeCatalog(db); }
	fs.rmSync(lockPath);
});


test("path/leaf search restricts ancestry before ranking, keeps early entries, and caps matches at 50", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const time = Date.now() - 10_000, file = path.join(f.bucket, "deep-tree.jsonl"), other = path.join(f.bucket, "other.jsonl");
	const rows = [header("deep", f.cwd, time), message("root", null, time + 1, "user", "earlyneedle root")];
	let parent = "root";
	for (let index = 0; index < 1_100; index++) {
		const id = `d${index}`; rows.push(message(id, parent, time + index + 2, "assistant", index < 60 ? `needle match ${index}` : `filler ${index}`)); parent = id;
	}
	rows.push(message("other-branch", "root", time + 2_000, "assistant", "earlyneedle off branch"));
	writeJsonl(file, rows);
	writeJsonl(other, [header("other", f.cwd, time), message("other-root", null, time + 1, "user", "earlyneedle other file")]);
	await reconcileCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd });
	const early = searchCatalog("earlyneedle", { databasePath: f.databasePath, path: file, leaf: parent, matchLimit: 50 });
	assert.deepEqual(early.results.map((result) => result.path), [file]);
	assert.deepEqual(early.results[0].matches.map((match) => match.matchedEntryId), ["root"]);
	const many = searchCatalog("needle", { databasePath: f.databasePath, path: file, leaf: parent, matchLimit: 99 });
	assert.equal(many.results[0].matches.length, 50);
	assert.equal(many.coverage.branchSelection, "explicit-leaf-ancestry");
	const cli = await runCli(["search", "--database", f.databasePath, "--path", file, "--leaf", parent, "--matches", "50", "--compact", "--", "earlyneedle"]);
	assert.equal(cli.code, 0, cli.stderr);
	assert.deepEqual(JSON.parse(cli.stdout).results[0].matches.map((match) => match.matchedEntryId), ["root"]);
});

test("exact-path BM25 stays FTS-first under realistic global noise", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const time = Date.now() - 20_000, target = path.join(f.bucket, "scoped-target.jsonl"), noise = path.join(f.bucket, "global-noise.jsonl");
	const targetRows = [header("scoped-target", f.cwd, time), message("root", null, time + 1, "user", "scopeprobe target root")];
	let parent = "root";
	for (let index = 0; index < 32; index++) {
		const id = `target-${index}`; targetRows.push(message(id, parent, time + index + 2, "assistant", `scopeprobe target branch ${index}`)); parent = id;
	}
	targetRows.push(message("off-branch", "root", time + 100, "assistant", "scopeprobe excluded branch"));
	const noiseRows = [header("global-noise", f.cwd, time)];
	for (let index = 0; index < 8_000; index++) noiseRows.push(message(`noise-${index}`, null, time + index + 1, "assistant", `scopeprobe unrelated global noise ${index}`));
	writeJsonl(target, targetRows); writeJsonl(noise, noiseRows);
	await reconcileCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd });

	const scoped = searchCatalog("scopeprobe", { databasePath: f.databasePath, path: target, leaf: parent, roles: ["assistant"], matchLimit: 50 });
	assert.deepEqual(scoped.results.map((result) => result.path), [target]);
	assert.equal(scoped.coverage.branchSelection, "explicit-leaf-ancestry");
	assert.deepEqual(new Set(scoped.results[0].matches.map((match) => match.matchedEntryId)),
		new Set(Array.from({ length: 32 }, (_, index) => `target-${index}`)));
	assert.ok(scoped.results[0].matches.every((match) => match.matchedRole === "assistant" && match.matchedEntryRef.sourceSha256));
	const bounded = searchCatalog("scopeprobe", { databasePath: f.databasePath, path: target, leaf: parent, roles: ["assistant"], matchLimit: 10 });
	const exhaustive = searchCatalog("scopeprobe", { databasePath: f.databasePath, path: target, leaf: parent, roles: ["assistant"], matchLimit: 10, exhaustive: true });
	assert.deepEqual(bounded.results[0].matches, exhaustive.results[0].matches);
	assert.equal(bounded.performance.earlyStopped, true); assert.equal(bounded.performance.contentRowsFetched, 10);

	const source = fs.readFileSync(new URL("../lib/session-catalog/index.mjs", import.meta.url), "utf8");
	const fromClause = source.match(/\n(FROM entry_fts[^\n]+)\nWHERE entry_fts MATCH \?/)?.[1];
	assert.ok(fromClause, "BM25 search FROM clause not found");
	const ftsBounds = source.match(/const ftsBounds = file \? "([^"]+)" : ""/)?.[1];
	assert.ok(ftsBounds, "exact BM25 rowid bounds not found");
	const db = openCatalog(f.databasePath, { readOnly: true });
	try {
		const fileId = db.prepare("SELECT file_id FROM files WHERE path=?").get(target).file_id;
		const globalHits = db.prepare("SELECT COUNT(*) count FROM entry_fts WHERE entry_fts MATCH ?").get("scopeprobe*").count;
		const targetHits = db.prepare(`SELECT COUNT(*) count FROM entry_fts JOIN entries e ON e.entry_pk=entry_fts.rowid
WHERE entry_fts MATCH ? AND e.file_id=?`).get("scopeprobe*", fileId).count;
		assert.ok(globalHits > targetHits * 200, `noise ratio too small: ${globalHits}/${targetHits}`);
		const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT e.entry_pk,bm25(entry_fts) AS rank
${fromClause}
WHERE entry_fts MATCH ? AND e.epoch=f.active_epoch AND e.generation<=f.active_generation
  AND f.missing_since_ms IS NULL AND f.index_status='fresh' AND f.file_id=?
  AND EXISTS (SELECT 1 FROM parts permitted WHERE permitted.entry_pk=e.entry_pk
    AND permitted.search_class IN ('conversation','summary') AND permitted.text_start IS NOT NULL)
ORDER BY rank ASC,f.modified_ms DESC,f.path ASC,e.ordinal ASC`).all("scopeprobe*", fileId).map((row) => row.detail);
		const ftsLoop = plan.findIndex((detail) => detail.includes("entry_fts VIRTUAL TABLE"));
		const entryLookup = plan.findIndex((detail) => detail.includes("e USING INTEGER PRIMARY KEY"));
		assert.ok(ftsLoop >= 0 && entryLookup > ftsLoop, `expected one FTS scan followed by rowid lookups:\n${plan.join("\n")}`);
		assert.equal(plan.some((detail) => detail.includes("entries_visible")), false,
			`scoped entries must not drive repeated FTS scans:\n${plan.join("\n")}`);
		const boundedPlan = db.prepare(`EXPLAIN QUERY PLAN WITH branch(entry_pk) AS (
SELECT entry_pk FROM entries WHERE file_id=?) SELECT e.entry_pk,bm25(entry_fts) rank
${fromClause}
WHERE entry_fts MATCH ?${ftsBounds} ORDER BY rank,e.ordinal`).all(fileId, "scopeprobe*").map((row) => row.detail);
		const ftsScans = boundedPlan.filter((detail) => detail.includes("entry_fts VIRTUAL TABLE"));
		assert.equal(ftsScans.length, 1, boundedPlan.join("\n"));
		assert.match(ftsScans[0], /M1><$/u, "exact FTS must consume rowid bounds, not repeat equality probes");
	} finally { closeCatalog(db); }
});

test("since-hours filters in SQL before search grouping and limit", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const now = Date.now(), oldFile = path.join(f.bucket, "old.jsonl"), recentFile = path.join(f.bucket, "recent.jsonl");
	writeJsonl(oldFile, [header("old", f.cwd, now - 72 * 3600_000), message("o", null, now - 72 * 3600_000, "user", `${"timefilter ".repeat(30)}marker`) ]);
	writeJsonl(recentFile, [header("recent", f.cwd, now - 3600_000), message("r", null, now - 3600_000, "user", "timefilter marker")]);
	await reconcileCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd });
	assert.deepEqual(searchCatalog("timefilter", { databasePath: f.databasePath, sinceHours: 24, limit: 1 }).results.map((item) => item.id), ["recent"]);
	assert.deepEqual(listCatalogSessions({ databasePath: f.databasePath, sinceHours: 24 }).map((item) => item.id), ["recent"]);
	const cli = await runCli(["search", "--database", f.databasePath, "--since-hours", "24", "--limit", "1", "--compact", "--", "timefilter"]);
	assert.equal(cli.code, 0, cli.stderr); assert.deepEqual(JSON.parse(cli.stdout).results.map((item) => item.id), ["recent"]);
});

test("cwd tree reconciliation discovers descendant header cwd buckets and excludes unrelated failures", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const childCwd = path.join(f.cwd, "child"), otherCwd = path.join(f.root, "other");
	const childBucket = path.join(f.sessionsRoot, encodeSessionBucket(childCwd));
	const otherBucket = path.join(f.sessionsRoot, encodeSessionBucket(otherCwd));
	const rootFile = path.join(f.bucket, "root.jsonl"), childFile = path.join(childBucket, "child.jsonl");
	writeJsonl(rootFile, [header("root-tree", f.cwd), message("r", null, Date.now(), "user", "tree root marker")]);
	writeJsonl(childFile, [header("child-tree", childCwd), message("c", null, Date.now(), "user", "tree child marker")]);
	fs.mkdirSync(otherBucket, { recursive: true }); fs.writeFileSync(path.join(otherBucket, "bad.jsonl"), "not json\n");
	const reconciled = await reconcileCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd, tree: true });
	assert.equal(reconciled.failed, 0); assert.equal(reconciled.files, 2);
	assert.deepEqual(listCatalogSessions({ databasePath: f.databasePath, cwd: f.cwd, tree: true }).map((item) => item.id).sort(), ["child-tree", "root-tree"]);
	assert.equal(searchCatalog("tree child", { databasePath: f.databasePath, cwd: f.cwd, tree: true }).results[0].path, childFile);
	const cli = await runCli(["reconcile", "--database", f.databasePath, "--sessions-root", f.sessionsRoot, "--cwd", f.cwd, "--tree", "--compact"]);
	assert.equal(cli.code, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).files, 2);
});

test("read entry without leaf selects its newest persisted descendant and CLI preserves the non-live label", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const file = path.join(f.bucket, "anchor.jsonl"), time = Date.now() - 1000;
	writeJsonl(file, [header("anchor", f.cwd, time),
		message("root", null, time + 1, "user", "root"),
		message("anchor-id", "root", time + 2, "assistant", "anchor"),
		message("desc", "anchor-id", time + 3, "user", "descendant"),
		message("unrelated", "root", time + 4, "assistant", "latest global branch"),
	]);
	await reconcileCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd });
	const read = readCatalogSession({ databasePath: f.databasePath, path: file, entry: "anchor-id" });
	assert.equal(read.leafId, "desc"); assert.equal(read.leafSelection, "latest-descendant-not-live");
	assert.deepEqual(read.entries.map((item) => item.id), ["root", "anchor-id"]);
	const cli = await runCli(["read", "--database", f.databasePath, "--path", file, "--entry", "anchor-id", "--compact"]);
	assert.equal(cli.code, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).leafSelection, "latest-descendant-not-live");
});

test("freshness is scoped, global reads expose partial-coverage receipts, and stale paths require opt-in", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const good = path.join(f.bucket, "good.jsonl"), stale = path.join(f.bucket, "stale.jsonl"), time = Date.now();
	writeJsonl(good, [header("good", f.cwd, time), message("g", null, time, "user", "freshness good marker")]);
	writeJsonl(stale, [header("stale", f.cwd, time), message("s", null, time, "user", "freshness stale marker")]);
	await reconcileCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd });
	fs.writeFileSync(stale, `${JSON.stringify(header("stale", f.cwd, time))}\n{"broken":\n`);
	const failed = await reconcileCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd });
	assert.equal(failed.failed, 1);
	const local = searchCatalog("freshness", { databasePath: f.databasePath, path: good });
	assert.equal(local.results.length, 1); assert.equal(local.coverage.scopeComplete, true);
	assert.throws(() => searchCatalog("freshness", { databasePath: f.databasePath }), /scope is incomplete/);
	const global = searchCatalog("freshness", { databasePath: f.databasePath, allowPartial: true, limit: 1 });
	assert.deepEqual(global.results.map((item) => item.id), ["good"]); assert.equal(global.coverage.scopeComplete, false);
	assert.equal(global.coverage.excludedFiles, 1); assert.equal(global.coverage.failureCount, 1); assert.equal(global.coverage.partialResults, true);
	assert.equal(searchCatalog("stale", { databasePath: f.databasePath, allowPartial: true }).results.length, 0);
	assert.throws(() => listCatalogSessions({ databasePath: f.databasePath }), /scope is incomplete/);
	const listed = listCatalogSessions({ databasePath: f.databasePath, allowPartial: true, limit: 1 });
	assert.deepEqual(listed.map((item) => item.id), ["good"]); assert.equal(listed[0].coverage.scopeComplete, false); assert.equal(listed.coverage.scopeComplete, false);
	const listedCli = await runCli(["list", "--database", f.databasePath, "--allow-partial", "--limit", "1", "--compact"]);
	assert.equal(listedCli.code, 0, listedCli.stderr); assert.equal(JSON.parse(listedCli.stdout).coverage.scopeComplete, false);
	assert.throws(() => searchCatalog("stale marker", { databasePath: f.databasePath, path: stale }), /not fresh/);
	const diagnostic = searchCatalog("stale marker", { databasePath: f.databasePath, path: stale, allowStale: true });
	assert.equal(diagnostic.results[0].id, "stale"); assert.equal(diagnostic.coverage.scopeComplete, false);
});

test("read bounds metadata and part count with explicit coverage and inspect avoids full listing", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const file = path.join(f.bucket, "bounded-read.jsonl"), time = Date.now();
	const parts = Array.from({ length: 300 }, (_, index) => ({ type: "toolCall", id: `call-${index}`, name: "read", arguments: { path: `/${index}/` + "x".repeat(500) } }));
	writeJsonl(file, [header("bounded-read", f.cwd, time), message("many", null, time + 1, "assistant", parts, { provider: "x", model: "y" })]);
	await reconcileCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd });
	const read = readCatalogSession({ databasePath: f.databasePath, path: file, maxChars: 100 });
	assert.ok(read.entries[0].parts.length < 300); assert.ok(read.coverage.partsOmitted > 0); assert.equal(read.coverage.metadataTruncated, true);
	const metadataOnly = structuredClone(read); for (const item of metadataOnly.entries) { delete item.text; for (const part of item.parts) delete part.text;
		assert.ok(Buffer.byteLength(JSON.stringify(item)) <= 64 * 1024); }
	assert.ok(Buffer.byteLength(JSON.stringify(metadataOnly)) <= 128 * 1024);
	const inspected = inspectCatalogSession({ databasePath: f.databasePath, path: file });
	assert.equal(inspected.id, "bounded-read"); assert.equal(inspected.path, file); assert.equal(inspected.source.indexStatus, "fresh");
	assert.equal(inspectCatalogSession({ databasePath: f.databasePath, id: "bounded-read" }).path, file);
	const cli = await runCli(["inspect", "--database", f.databasePath, "--id", "bounded-read", "--compact"]);
	assert.equal(cli.code, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).source.indexStatus, "fresh");
});

test("tool-result role search includes tool evidence without a separate include-tools flag", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const file = path.join(f.bucket, "tool-role.jsonl"), time = Date.now();
	writeJsonl(file, [header("tool-role", f.cwd, time), message("t", null, time + 1, "toolResult", [{ type: "text", text: "implicit tool evidence" }], { toolName: "bash" })]);
	await reconcileCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd });
	assert.equal(searchCatalog("implicit evidence", { databasePath: f.databasePath, roles: ["toolResult"] }).results.length, 1);
	const cli = await runCli(["search", "--database", f.databasePath, "--role", "toolResult", "--compact", "--", "implicit evidence"]);
	assert.equal(cli.code, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).results.length, 1);
});


test("exact-path readers reject unreconciled source generations while global search labels snapshot-only coverage", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const file = path.join(f.bucket, "source-freshness.jsonl"), time = Date.now();
	writeJsonl(file, [header("source-freshness", f.cwd, time), message("old", null, time + 1, "user", "OLD_SOURCE_MARKER")]);
	await reconcileCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd });
	writeJsonl(file, [header("source-freshness", f.cwd, time), message("new", null, time + 2, "user", "NEW_SOURCE_MARKER")]);
	assert.throws(() => searchCatalog("OLD_SOURCE_MARKER", { databasePath: f.databasePath, path: file }), /source snapshot is not fresh/);
	assert.throws(() => listCatalogSessions({ databasePath: f.databasePath, path: file }), /source snapshot is not fresh/);
	assert.throws(() => searchCatalog("OLD_SOURCE_MARKER", { databasePath: f.databasePath, path: file, allowPartial: true }), /allowPartial.*global or cwd/i);
	assert.throws(() => readCatalogSession({ databasePath: f.databasePath, path: file }), /source is not fresh/);
	assert.equal(inspectCatalogSession({ databasePath: f.databasePath, id: "source-freshness" }).source.sourceMatchesSnapshot, false);
	const global = searchCatalog("OLD_SOURCE_MARKER", { databasePath: f.databasePath });
	assert.equal(global.results.length, 1); assert.equal(global.coverage.freshness, "catalog-snapshot");
	assert.equal(global.coverage.sourceValidation, "not-performed"); assert.equal(global.coverage.liveSourceFreshness, false);
});

test("retained-tail image pointers include full provenance and extract without descriptor-close masking", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const file = path.join(f.bucket, "retained-images.jsonl"), one = Buffer.from("one-image"), two = Buffer.from("two-image");
	writeJsonl(file, [header("retained-images", f.cwd), entry("compaction", "cp-images", null, Date.now(), {
		summary: "images", tokensBefore: 1, retainedTail: [
			{ role: "user", content: [{ type: "image", mimeType: "application/octet-stream", data: one.toString("base64") }] },
			{ role: "user", content: [{ type: "image", mimeType: "application/octet-stream", data: two.toString("base64") }] },
		],
	})]);
	await reconcileCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd });
	const read = readCatalogSession({ databasePath: f.databasePath, path: file });
	const images = read.entries[0].parts.filter((part) => part.kind === "image");
	assert.deepEqual(images.map((part) => part.imageSource), [
		{ base: "retainedTail", retainedIndex: 0, contentIndex: 0 },
		{ base: "retainedTail", retainedIndex: 1, contentIndex: 0 },
	]);
	for (const [index, expected] of [one, two].entries()) {
		const output = path.join(f.root, `retained-${index}.bin`);
		await extractCatalogImage({ databasePath: f.databasePath, path: file, entry: "cp-images", byteStart: read.entries[0].byteStart, part: images[index].part, output });
		assert.deepEqual(fs.readFileSync(output), expected);
	}
	assert.equal((await verifyCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, path: file })).ok, true);
	const broken = path.join(f.root, "broken.bin");
	await assert.rejects(() => extractCatalogImage({ databasePath: f.databasePath, path: file, entry: "cp-images", byteStart: read.entries[0].byteStart, part: 999, output: broken }), /image part not found/);
});

test("read allocates text to the requested focus before large ancestors", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const file = path.join(f.bucket, "focus-budget.jsonl"), time = Date.now();
	writeJsonl(file, [header("focus-budget", f.cwd, time), message("big", null, time + 1, "user", "x".repeat(300_000)),
		message("focus", "big", time + 2, "assistant", "FOCUS_CONTENT")]);
	await reconcileCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd });
	const read = readCatalogSession({ databasePath: f.databasePath, path: file, entry: "focus", maxChars: 256 * 1024 });
	assert.equal(read.entries.find((item) => item.id === "focus").text, "FOCUS_CONTENT");
	assert.ok(read.entries.find((item) => item.id === "big").text.length < 256 * 1024);
});

test("duplicate IDs expose stable entry refs and require byte locators for read, search leaf, and image", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const file = path.join(f.bucket, "duplicate-locators.jsonl"), time = Date.now();
	const imageA = Buffer.from("duplicate-a"), imageB = Buffer.from("duplicate-b");
	writeJsonl(file, [header("duplicate-locators", f.cwd, time),
		message("root", null, time + 1, "user", "root locator"),
		message("dup", "root", time + 2, "user", [{ type: "text", text: "locator alpha" }, { type: "image", mimeType: "application/octet-stream", data: imageA.toString("base64") }]),
		message("dup", "root", time + 3, "user", [{ type: "text", text: "locator beta" }, { type: "image", mimeType: "application/octet-stream", data: imageB.toString("base64") }]),
	]);
	await reconcileCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd });
	const hit = searchCatalog("locator beta", { databasePath: f.databasePath, path: file }).results[0].matches?.[0]
		?? searchCatalog("locator beta", { databasePath: f.databasePath, path: file }).results[0];
	assert.equal(typeof hit.matchedEntryRef.byteStart, "number"); assert.equal(typeof hit.matchedEntryRef.sourceSha256, "string");
	assert.throws(() => readCatalogSession({ databasePath: f.databasePath, path: file, entry: "dup" }), /ambiguous entry/);
	const exact = readCatalogSession({ databasePath: f.databasePath, path: file, entry: "dup", byteStart: hit.matchedEntryRef.byteStart });
	const located = exact.entries.find((item) => item.byteStart === hit.matchedEntryRef.byteStart);
	assert.equal(located.entryRef.sourceSha256, hit.matchedEntryRef.sourceSha256); assert.equal(typeof located.ordinal, "number");
	assert.throws(() => searchCatalog("root locator", { databasePath: f.databasePath, path: file, leaf: "dup" }), /ambiguous leaf/);
	assert.equal(searchCatalog("locator beta", { databasePath: f.databasePath, path: file, leaf: "dup", byteStart: hit.matchedEntryRef.byteStart }).results.length, 1);
	await assert.rejects(() => extractCatalogImage({ databasePath: f.databasePath, path: file, entry: "dup", part: 1, output: path.join(f.root, "ambiguous.bin") }), /ambiguous entry/);
	const output = path.join(f.root, "exact.bin");
	const extracted = await extractCatalogImage({ databasePath: f.databasePath, path: file, entry: "dup", byteStart: hit.matchedEntryRef.byteStart, part: 1, output });
	assert.equal(extracted.entryRef.byteStart, hit.matchedEntryRef.byteStart); assert.deepEqual(fs.readFileSync(output), imageB);
	const cli = await runCli(["read", "--database", f.databasePath, "--path", file, "--entry", "dup", "--byte-start", String(hit.matchedEntryRef.byteStart), "--compact"]);
	assert.equal(cli.code, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).entries.at(-1).byteStart, hit.matchedEntryRef.byteStart);
});

test("public session metadata exposes bounded firstMessage and parentSessionPath", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const parent = path.join(f.bucket, "parent.jsonl"), child = path.join(f.bucket, "child.jsonl"), time = Date.now();
	writeJsonl(parent, [header("parent", f.cwd, time), message("p", null, time + 1, "user", "p".repeat(1_100_000))]);
	writeJsonl(child, [header("child", f.cwd, time, { parentSession: parent }), message("c", null, time + 2, "user", "child marker")]);
	await reconcileCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd });
	const listed = listCatalogSessions({ databasePath: f.databasePath });
	const parentResult = listed.find((item) => item.id === "parent"), childResult = listed.find((item) => item.id === "child");
	assert.ok(Buffer.byteLength(parentResult.firstMessage) <= 4096); assert.equal(parentResult.firstMessageTruncated, true);
	assert.equal(childResult.parentSessionPath, parent);
	const searched = searchCatalog("child marker", { databasePath: f.databasePath }).results[0];
	assert.equal(searched.parentSessionPath, parent);
	const cli = await runCli(["list", "--database", f.databasePath, "--limit", "1000", "--compact"]);
	assert.equal(cli.code, 0, cli.stderr); assert.ok(Buffer.byteLength(cli.stdout) < 1024 * 1024);
});

test("tool limits are key-order independent, part arrays are capped, and truncated JSON arguments are identified", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const file = path.join(f.bucket, "ordered-tool.jsonl"), time = Date.now();
	const orderedMessage = { type: "message", id: "tool", parentId: null, timestamp: iso(time), message: {
		content: [{ type: "text", text: "z".repeat(100) }], role: "toolResult", timestamp: time, toolName: "bash",
	} };
	const many = message("many", "tool", time + 1, "assistant", Array.from({ length: 8 }, (_, index) => ({ type: "toolCall", id: `c${index}`, name: "x", arguments: { payload: "q".repeat(100) } })));
	writeJsonl(file, [header("ordered-tool", f.cwd), orderedMessage, many]);
	const scan = await scanSessionFile(file, { sourceRoot: fs.realpathSync(f.sessionsRoot), maxToolChars: 10, maxToolMetaChars: 24, maxParts: 2 });
	const tool = scan.records.find((record) => record.entry.id === "tool");
	assert.equal(tool.parts[0].textEnd - tool.parts[0].textStart, 10); assert.equal(tool.parts[0].extractionChars, 100); assert.equal(tool.parts[0].extractionTruncated, true);
	const capped = scan.records.find((record) => record.entry.id === "many");
	assert.equal(capped.parts.length, 2); assert.equal(capped.entry.metadata.partCoverage.omitted, 6);
	assert.equal(capped.parts[0].metadata.validJson, false); assert.equal(capped.parts[0].metadata.format, "json-prefix");
});

test("CLI reconcile returns exit 2 JSON and allow-partial exposes fresh-only coverage even with no hits", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const good = path.join(f.bucket, "partial-good.jsonl"), bad = path.join(f.bucket, "partial-bad.jsonl"), time = Date.now();
	writeJsonl(good, [header("partial-good", f.cwd, time), message("g", null, time + 1, "user", "partial searchable")]);
	fs.writeFileSync(bad, `${JSON.stringify(message("headerless", null, time + 2, "user", "corrupt"))}\n`);
	const reconciled = await runCli(["reconcile", "--database", f.databasePath, "--sessions-root", f.sessionsRoot, "--cwd", f.cwd, "--compact"]);
	assert.equal(reconciled.code, 2, reconciled.stderr);
	const report = JSON.parse(reconciled.stdout); assert.equal(report.scopeComplete, false); assert.equal(report.failed, 1); assert.equal(report.failures.length, 1);
	const rejected = await runCli(["search", "--database", f.databasePath, "--compact", "--", "partial"]);
	assert.equal(rejected.code, 1); assert.match(rejected.stderr, /scope is incomplete/);
	const accepted = await runCli(["search", "--database", f.databasePath, "--allow-partial", "--compact", "--", "no-such-term"]);
	assert.equal(accepted.code, 0, accepted.stderr);
	const response = JSON.parse(accepted.stdout); assert.deepEqual(response.results, []); assert.equal(response.coverage.scopeComplete, false);
	assert.equal(response.coverage.failedFiles, 1); assert.equal(response.coverage.partialResults, true);
	assert.equal(response.coverage.freshness, "catalog-snapshot"); assert.equal(response.coverage.liveSourceFreshness, false);
	assert.equal(typeof response.coverage.receiptAt, "string"); assert.equal(typeof response.coverage.catalogSnapshotAt, "string");
	const emptyList = await runCli(["list", "--database", f.databasePath, "--allow-partial", "--since-hours", "0", "--compact"]);
	assert.equal(emptyList.code, 0, emptyList.stderr); assert.deepEqual(JSON.parse(emptyList.stdout).results, []);
	assert.equal(JSON.parse(emptyList.stdout).coverage.scopeComplete, false);
});

test("benchmark fresh mode requires an isolated unlocked database and never targets the default", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	let result = await runBenchmark(["--cwd", f.cwd, "--sessions-root", f.sessionsRoot, "--fresh"]);
	assert.equal(result.code, 1); assert.match(result.stderr, /explicit isolated --database/);
	result = await runBenchmark(["--cwd", f.cwd, "--sessions-root", f.sessionsRoot, "--fresh", "--database", defaultCatalogPath(f.sessionsRoot)]);
	assert.equal(result.code, 1); assert.match(result.stderr, /refuses the default live/);
	const isolated = path.join(f.root, "benchmark", "isolated.sqlite3"); fs.mkdirSync(path.dirname(isolated), { recursive: true });
	fs.writeFileSync(`${isolated}.writer-lock`, `123\n${Date.now()}\nowner\n`);
	result = await runBenchmark(["--cwd", f.cwd, "--sessions-root", f.sessionsRoot, "--fresh", "--database", isolated]);
	assert.equal(result.code, 1); assert.match(result.stderr, /writer lock/); assert.equal(fs.existsSync(`${isolated}.writer-lock`), true);
});

test("resume title-first search promotes direct and fuzzy names before recent body hits", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const time = Date.now();
	for (const [id, name, text, offset, cwd] of [
		["direct", "Phoenix", "ordinary", 0, f.cwd],
		["substring", "MyPhoenixNotes", "ordinary", 10, f.cwd],
		["fuzzy", "Phone Experiments", "ordinary", 20, f.cwd],
		["body", "Other", "phoenix phnx", 100, f.cwd],
		["outside", "Phoenix", "ordinary", 200, `${f.cwd}/other`],
	]) {
		writeJsonl(path.join(f.bucket, `${id}.jsonl`), [header(id, cwd, time + offset),
			message(`${id}-msg`, null, time + offset, "user", text),
			entry("session_info", `${id}-name`, `${id}-msg`, time + offset + 1, { name })]);
	}
	await reconcileCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, all: true });
	const base = { databasePath: f.databasePath, cwd: f.cwd, titleFirst: true };
	for (const sort of ["recent", "relevance"]) {
		const options = { ...base, sort };
		const direct = searchCatalog("phoenix", options).results;
		assert.deepEqual(direct.map((item) => item.id), ["substring", "direct", "body"]);
		assert.equal(direct[0].matchedField, "name");
		assert.equal(direct[0].matchedEntryId, undefined);
		const fuzzy = searchCatalog("phnx", options).results;
		assert.deepEqual(fuzzy.map((item) => item.id), ["fuzzy", "substring", "direct", "body"]);
		assert.equal(fuzzy[0].matchKind, "metadata");
		assert.equal(fuzzy[0].excerpt, "Phone Experiments");
		assert.equal(searchCatalog("phnx", { ...options, limit: 1 }).results[0].id, "fuzzy");
		const projection = (response) => response.results.map(({ coverage, ...item }) => item);
		assert.deepEqual(projection(searchCatalog("phnx", { ...options, limit: 2 })),
			projection(searchCatalog("phnx", { ...options, limit: 2, exhaustive: true })));
	}
	assert.equal(searchCatalog("phoenix", { ...base, titleFirst: false, sort: "recent" }).results[0].id, "body");
	assert.deepEqual(searchCatalog("phnx", { ...base, metadata: false }).results.map((item) => item.id), ["body"]);
	assert.deepEqual(searchCatalog("phnx", { ...base, roles: ["user"] }).results.map((item) => item.id), ["body"]);
	assert.equal(searchCatalog("phnx", { ...base, path: path.join(f.bucket, "fuzzy.jsonl") }).results.length, 0);
	assert.equal(searchCatalog("phnx", { ...base, mode: "phrase" }).results.length, 1);
	assert.equal(searchCatalog("phnx", { ...base, mode: "regex" }).results.length, 1);
	assert.equal(searchCatalog("Phoenix", { ...base, sinceHours: 0 }).results.some((item) => item.id === "direct"), false);
	const cli = await runCli(["search", "--database", f.databasePath, "--cwd", f.cwd,
		"--title-first", "--sort", "recent", "--limit", "1", "--compact", "--", "phnx"]);
	assert.equal(cli.code, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).results[0].id, "fuzzy");
});

test("broad search includes bounded session metadata while path search remains entry-only", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const time = Date.now(), named = path.join(f.bucket, "metadata-name.jsonl"), identified = path.join(f.bucket, "metadata-id.jsonl"),
		cwdFile = path.join(f.bucket, "metadata-cwd.jsonl"), contentFile = path.join(f.bucket, "metadata-content.jsonl"), oldFile = path.join(f.bucket, "metadata-old.jsonl");
	writeJsonl(named, [header("name-session", f.cwd, time), message("n", null, time + 1, "user", "ordinary content"),
		entry("session_info", "name", "n", time + 2, { name: "Renamed Phoenix Session" })]);
	writeJsonl(identified, [header("session-id-metadata-needle", f.cwd, time), message("i", null, time + 1, "user", "ordinary id content")]);
	writeJsonl(cwdFile, [header("cwd-session", path.join(f.cwd, "cwd-metadata-needle"), time), message("w", null, time + 1, "user", "ordinary cwd content")]);
	writeJsonl(contentFile, [header("content-session", f.cwd, time), message("c", null, time + 1, "user", "transcript-only-needle")]);
	writeJsonl(oldFile, [header("old-metadata-needle", f.cwd, time - 72 * 3600_000), message("o", null, time - 72 * 3600_000, "user", "ordinary old")]);
	await reconcileCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd });
	for (const [query, field, id] of [["Phoenix", "name", "name-session"], ["session-id-metadata-needle", "id", "session-id-metadata-needle"],
		["cwd-metadata-needle", "cwd", "cwd-session"]]) {
		const result = searchCatalog(query, { databasePath: f.databasePath }).results[0];
		assert.equal(result.id, id); assert.equal(result.matchKind, "metadata"); assert.equal(result.matchedField, field);
		assert.equal("matchedEntryId" in result, false); assert.equal("matchedEntryRef" in result, false);
	}
	const content = searchCatalog("transcript-only-needle", { databasePath: f.databasePath }).results[0];
	assert.equal(content.id, "content-session"); assert.equal(content.matchKind, "entry"); assert.equal(content.matchedEntryId, "c");
	assert.equal(searchCatalog("Phoenix", { databasePath: f.databasePath, path: named }).results.length, 0);
	assert.equal(searchCatalog("Phoenix", { databasePath: f.databasePath, metadata: false }).results.length, 0);
	assert.equal(searchCatalog("session-id-metadata-needle", { databasePath: f.databasePath, namedOnly: true }).results.length, 0);
	assert.equal(searchCatalog("old-metadata-needle", { databasePath: f.databasePath, sinceHours: 24 }).results.length, 0);
	assert.equal(searchCatalog("Renamed Phoenix", { databasePath: f.databasePath, mode: "phrase" }).results[0].matchedField, "name");
	assert.equal(searchCatalog("Phoenix\\s+Session", { databasePath: f.databasePath, mode: "regex" }).results[0].matchedField, "name");
	assert.equal(searchCatalog("cwd-metadata-needle", { databasePath: f.databasePath, cwd: f.cwd }).results.length, 0);
	assert.equal(searchCatalog("cwd-metadata-needle", { databasePath: f.databasePath, cwd: f.cwd, tree: true }).results[0].id, "cwd-session");
	const cli = await runCli(["search", "--database", f.databasePath, "--compact", "--", "Renamed Phoenix"]);
	assert.equal(cli.code, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).results[0].matchKind, "metadata");
	const disabled = await runCli(["search", "--database", f.databasePath, "--no-metadata", "--compact", "--", "Renamed Phoenix"]);
	assert.equal(disabled.code, 0, disabled.stderr); assert.deepEqual(JSON.parse(disabled.stdout).results, []);
});

test("BM25 validation follows unicode61 diacritic folding and phrase prefilters disallowed tool-only entries", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const file = path.join(f.bucket, "diacritics.jsonl"), time = Date.now();
	writeJsonl(file, [header("diacritics", f.cwd, time), message("u", null, time + 1, "user", "A café marker"),
		message("tool", "u", time + 2, "toolResult", [{ type: "text", text: "tool phrase only evidence" }], { toolName: "bash" })]);
	await reconcileCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd });
	const folded = searchCatalog("cafe", { databasePath: f.databasePath });
	assert.equal(folded.results[0].matchedEntryId, "u"); assert.match(folded.results[0].excerpt, /café/u);
	assert.equal(searchCatalog("tool phrase only", { databasePath: f.databasePath, mode: "phrase" }).results.length, 0);
	assert.equal(searchCatalog("tool phrase only", { databasePath: f.databasePath, mode: "phrase", includeTools: true }).results[0].matchedEntryId, "tool");
});

test("explicit CLI path indexes trusted external sessions without exposing or poisoning broad default-root queries", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const time = Date.now(), defaultFile = path.join(f.bucket, "default.jsonl");
	const externalRoot = path.join(f.root, "subagent-runs", "named-run"), external = path.join(externalRoot, "session.jsonl");
	const imageBytes = Buffer.from("external-image");
	writeJsonl(defaultFile, [header("default-session", f.cwd, time), message("d", null, time + 1, "user", "default broad marker")]);
	writeJsonl(external, [header("external-session", path.join(f.root, "external-cwd"), time),
		message("x", null, time + 2, "user", [{ type: "text", text: "external explicit marker" },
			{ type: "image", mimeType: "application/octet-stream", data: imageBytes.toString("base64") }])]);
	let cli = await runCli(["reconcile", "--database", f.databasePath, "--sessions-root", f.sessionsRoot, "--cwd", f.cwd, "--compact"]);
	assert.equal(cli.code, 0, cli.stderr);
	cli = await runCli(["reconcile", "--database", f.databasePath, "--sessions-root", f.sessionsRoot, "--path", external, "--compact"]);
	assert.equal(cli.code, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).created, 1);
	const broadReconcile = await runCli(["reconcile", "--database", f.databasePath, "--sessions-root", f.sessionsRoot, "--all", "--compact"]);
	assert.equal(broadReconcile.code, 0, broadReconcile.stderr); assert.equal(JSON.parse(broadReconcile.stdout).missingMarked, 0);
	const explicitSearch = await runCli(["search", "--database", f.databasePath, "--sessions-root", f.sessionsRoot, "--path", external, "--compact", "--", "external explicit"]);
	assert.equal(explicitSearch.code, 0, explicitSearch.stderr); assert.equal(JSON.parse(explicitSearch.stdout).results[0].id, "external-session");
	const explicitRead = await runCli(["read", "--database", f.databasePath, "--sessions-root", f.sessionsRoot, "--path", external, "--compact"]);
	assert.equal(explicitRead.code, 0, explicitRead.stderr); assert.equal(JSON.parse(explicitRead.stdout).entries[0].id, "x");
	const output = path.join(f.root, "external.bin");
	const explicitImage = await runCli(["image", "--database", f.databasePath, "--sessions-root", f.sessionsRoot, "--path", external,
		"--entry", "x", "--part", "1", "--output", output, "--compact"]);
	assert.equal(explicitImage.code, 0, explicitImage.stderr); assert.deepEqual(fs.readFileSync(output), imageBytes);
	const broadList = await runCli(["list", "--database", f.databasePath, "--sessions-root", f.sessionsRoot, "--compact"]);
	assert.equal(broadList.code, 0, broadList.stderr); assert.deepEqual(JSON.parse(broadList.stdout).results.map((item) => item.id), ["default-session"]);
	const broadExternal = await runCli(["search", "--database", f.databasePath, "--sessions-root", f.sessionsRoot, "--compact", "--", "external explicit"]);
	assert.equal(broadExternal.code, 0, broadExternal.stderr); assert.deepEqual(JSON.parse(broadExternal.stdout).results, []);
	const status = await runCli(["status", "--database", f.databasePath, "--sessions-root", f.sessionsRoot, "--compact"]);
	assert.equal(status.code, 0, status.stderr); assert.equal(JSON.parse(status.stdout).files, 1);
	fs.writeFileSync(external, "{broken external}\n");
	const failed = await runCli(["reconcile", "--database", f.databasePath, "--sessions-root", f.sessionsRoot, "--path", external, "--compact"]);
	assert.equal(failed.code, 2); assert.equal(JSON.parse(failed.stdout).scopeComplete, false);
	const unaffected = await runCli(["search", "--database", f.databasePath, "--sessions-root", f.sessionsRoot, "--compact", "--", "default broad"]);
	assert.equal(unaffected.code, 0, unaffected.stderr); assert.equal(JSON.parse(unaffected.stdout).results[0].id, "default-session");
	const unaffectedStatus = await runCli(["status", "--database", f.databasePath, "--sessions-root", f.sessionsRoot, "--compact"]);
	assert.equal(unaffectedStatus.code, 0, unaffectedStatus.stderr); assert.equal(JSON.parse(unaffectedStatus.stdout).fresh, true);
	assert.deepEqual(JSON.parse(unaffectedStatus.stdout).failures, []);
	fs.unlinkSync(external);
	const afterVanish = await runCli(["list", "--database", f.databasePath, "--sessions-root", f.sessionsRoot, "--compact"]);
	assert.equal(afterVanish.code, 0, afterVanish.stderr); assert.deepEqual(JSON.parse(afterVanish.stdout).results.map((item) => item.id), ["default-session"]);
});

test("status skips integrity by default and runs it only when explicitly requested", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const file = path.join(f.bucket, "status.jsonl");
	writeJsonl(file, [header("status", f.cwd), message("s", null, Date.now(), "user", "status marker")]);
	await reconcileCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd });
	assert.equal(catalogStatus({ databasePath: f.databasePath }).integrity, "not-checked");
	assert.equal(catalogStatus({ databasePath: f.databasePath, integrity: true }).integrity, "ok");
	let cli = await runCli(["status", "--database", f.databasePath, "--compact"]);
	assert.equal(cli.code, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).integrity, "not-checked");
	cli = await runCli(["status", "--database", f.databasePath, "--integrity", "--compact"]);
	assert.equal(cli.code, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).integrity, "ok");
});

test("bounded BM25 candidates preserve exhaustive ordering across ties, filters, metadata, and tools", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const base = Date.now() - 100_000;
	for (let index = 0; index < 24; index++) {
		const file = path.join(f.bucket, `rank-${String(index).padStart(2, "0")}.jsonl`), timestamp = base + index * 1000;
		writeJsonl(file, [header(`rank-${index}`, f.cwd, timestamp),
			message(`u-${index}`, null, timestamp, "user", "boundedrank common content"),
			message(`t-${index}`, `u-${index}`, timestamp + 1, "toolResult", [{ type: "text", text: "boundedtool common evidence" }], { toolName: "bash" }),
		]);
	}
	const named = path.join(f.bucket, "rank-named.jsonl");
	writeJsonl(named, [header("rank-named", f.cwd, base), message("n", null, base, "user", "ordinary"),
		entry("session_info", "named", "n", base + 1, { name: "boundedrank metadata title" })]);
	await reconcileCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd });
	const projection = (response) => response.results.map((item) => ({ id: item.id, matchKind: item.matchKind, matchedEntryId: item.matchedEntryId, matchedField: item.matchedField }));
	for (const [query, options, expectedIds] of [
		["boundedrank", { limit: 5 }, ["rank-named", "rank-23", "rank-22", "rank-21", "rank-20"]],
		["boundedrank", { limit: 5, roles: ["user"] }, ["rank-23", "rank-22", "rank-21", "rank-20", "rank-19"]],
		["boundedtool", { limit: 5, includeTools: true, roles: ["toolResult"] }, ["rank-23", "rank-22", "rank-21", "rank-20", "rank-19"]],
	]) {
		const bounded = searchCatalog(query, { databasePath: f.databasePath, ...options });
		const exhaustive = searchCatalog(query, { databasePath: f.databasePath, ...options, exhaustive: true });
		assert.deepEqual(projection(bounded), projection(exhaustive));
		assert.deepEqual(bounded.results.map((item) => item.id), expectedIds);
		assert.equal(bounded.performance.earlyStopped, true, `${query}: ${JSON.stringify(bounded.performance)}`);
		assert.ok(bounded.performance.contentRowsFetched < exhaustive.performance.contentRowsFetched);
		assert.ok(bounded.performance.candidateRowsScanned < exhaustive.performance.candidateRowsScanned);
	}
	const multiple = searchCatalog("boundedrank", { databasePath: f.databasePath, limit: 2, matchLimit: 2 });
	assert.equal(multiple.performance.earlyStopped, false);
	const recent = searchCatalog("boundedrank", { databasePath: f.databasePath, limit: 2, sort: "recent" });
	assert.equal(recent.performance.earlyStopped, false);
});

test("soft BM25 weights prefer user, then assistant final, then commentary and compaction, then opted-in tools", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const file = path.join(f.bucket, "role-weights.jsonl"), time = Date.now() - 30_000;
	writeJsonl(file, [header("role-weights", f.cwd, time),
		message("tool", null, time + 1, "toolResult", [{ type: "text", text: "roleweight signal" }], { toolName: "bash" }),
		entry("compaction", "summary", "tool", time + 2, { summary: "roleweight signal" }),
		message("commentary", "summary", time + 3, "assistant", [
			{ type: "text", text: "roleweight signal" },
			{ type: "thinking", thinking: "private-thought-never-index" },
			{ type: "toolCall", id: "call", name: "bash", arguments: {} },
		]),
		message("final", "commentary", time + 4, "assistant", "roleweight signal"),
		message("user", "final", time + 5, "user", "roleweight signal"),
	]);
	await reconcileCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd });
	const db = openCatalog(f.databasePath, { readOnly: true });
	try {
		const raw = new Map(db.prepare(`SELECT e.entry_id,bm25(entry_fts) rank FROM entry_fts
JOIN entries e ON e.entry_pk=entry_fts.rowid WHERE entry_fts MATCH ?`).all('"roleweight"* AND "signal"*').map((row) => [row.entry_id, row.rank]));
		assert.equal(raw.size, 5, "every tier must match both query terms");
		assert.ok(Math.max(...raw.values()) / Math.min(...raw.values()) > 0.9, "raw BM25 ranks must remain close");
	} finally { closeCatalog(db); }
	const options = { databasePath: f.databasePath, path: file, matchLimit: 5, includeTools: true };
	const ranked = searchCatalog("roleweight signal", options).results[0].matches.map((match) => match.matchedEntryId);
	assert.deepEqual(ranked.slice(0, 2), ["user", "final"]);
	assert.deepEqual(new Set(ranked.slice(2, 4)), new Set(["commentary", "summary"]));
	assert.equal(ranked[4], "tool");
	const optedOut = searchCatalog("roleweight signal", { ...options, includeTools: false }).results[0].matches;
	assert.equal(optedOut.some((match) => match.matchedEntryId === "tool"), false);
	assert.equal(searchCatalog("private-thought-never-index", options).results.length, 0);
});

test("lexical strength can outrank a soft user boost", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const time = Date.now() - 20_000;
	for (const [id, role, content] of [
		["user", "user", `boostlex signal ${"surrounding context ".repeat(80)}`],
		["assistant", "assistant", "boostlex signal ".repeat(12)],
	]) writeJsonl(path.join(f.bucket, `${id}.jsonl`), [header(id, f.cwd, time), message(id, null, time + 1, role, content)]);
	await reconcileCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd });
	const ranked = searchCatalog("boostlex signal", { databasePath: f.databasePath, metadata: false, limit: 2 });
	assert.deepEqual(ranked.results.map((result) => result.id), ["assistant", "user"]);
});

test("bounded soft BM25 ranking matches exhaustive when a user hit arrives after assistant hits, including multiple matches", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const base = Date.now() - 120_000, target = path.join(f.bucket, "older-user.jsonl");
	writeJsonl(target, [header("older-user", f.cwd, base),
		message("assistant", null, base + 1, "assistant", "latetier signal"),
		message("user", "assistant", base + 2, "user", "latetier signal"),
	]);
	for (let index = 0; index < 24; index++) {
		const time = base + 1000 * (index + 1);
		writeJsonl(path.join(f.bucket, `newer-${index}.jsonl`), [header(`newer-${index}`, f.cwd, time),
			message(`a-${index}`, null, time + 1, "assistant", "latetier signal")]);
	}
	await reconcileCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd });
	for (const matchLimit of [1, 2]) {
		const options = { databasePath: f.databasePath, metadata: false, limit: 2, matchLimit };
		const bounded = searchCatalog("latetier signal", options);
		const exhaustive = searchCatalog("latetier signal", { ...options, exhaustive: true });
		assert.deepEqual(bounded.results.map(({ id, matchedEntryId, matches }) => ({ id, matchedEntryId, matches })),
			exhaustive.results.map(({ id, matchedEntryId, matches }) => ({ id, matchedEntryId, matches })));
		assert.equal(bounded.results[0].id, "older-user");
		assert.equal(bounded.results[0].matchedEntryId, "user");
		if (matchLimit > 1) assert.deepEqual(bounded.results[0].matches.map((match) => match.matchedEntryId), ["user", "assistant"]);
	}
});

test("line framing keeps huge trailing whitespace bounded and corrupt lock metadata fails safely", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const file = path.join(f.bucket, "whitespace.jsonl");
	fs.writeFileSync(file, `${JSON.stringify(header("whitespace", f.cwd))}${" ".repeat(4 * 1024 * 1024)}\n`);
	const scan = await scanSessionFile(file, { sourceRoot: fs.realpathSync(f.sessionsRoot), readBufferBytes: 1024 });
	assert.equal(scan.metrics.records, 0); assert.ok(scan.metrics.maxLineBytes > 4 * 1024 * 1024);
	fs.mkdirSync(path.dirname(f.databasePath), { recursive: true }); fs.writeFileSync(`${f.databasePath}.writer-lock`, "not-a-pid\nnot-a-time\n");
	await assert.rejects(() => reconcileCatalog({ sessionsRoot: f.sessionsRoot, databasePath: f.databasePath, cwd: f.cwd, lockTimeoutMs: 100 }), /corrupt writer lock.*confirming no live writer/i);
});


test("completed appends after the scan snapshot resume even when publish stat is unchanged; partial tails stay cheap", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const file = path.join(f.bucket, "publish-tail.jsonl"), time = Date.now();
	writeJsonl(file, [header("publish-tail", f.cwd, time), message("first", null, time, "user", "opening snapshot")]);
	const partial = JSON.stringify(message("partial", "later", time + 2, "user", "unfinished tail"));
	const original = fs.createReadStream; let injected = false;
	fs.createReadStream = function(source, ...args) {
		if (!injected && source === null) {
			injected = true; appendJsonl(file, [message("later", "first", time + 1, "user", "completed publish needle")]);
			fs.appendFileSync(file, partial);
		}
		return original.call(this, source, ...args);
	};
	let first;
	try { first = await reconcileCatalog({ ...f, all: true }); } finally { fs.createReadStream = original; }
	assert.equal(first.entries, 1); assert.equal(first.deferred, 1);
	assert.equal(searchCatalog("completed publish needle", { ...f }).results.length, 0);
	const resumed = await reconcileCatalog({ ...f, all: true });
	assert.equal(resumed.appended, 1); assert.equal(resumed.entries, 1); assert.equal(resumed.deferred, 1);
	assert.equal(searchCatalog("completed publish needle", { ...f, path: file }).results.length, 1);
	const unchanged = await reconcileCatalog({ ...f, all: true });
	assert.equal(unchanged.unchanged, 1); assert.equal(unchanged.bytesRead, 0);
	fs.appendFileSync(file, "\n");
	assert.equal((await reconcileCatalog({ ...f, all: true })).entries, 1);
});

test("a discovered source disappearing before stat cannot retain a fresh searchable row", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const one = path.join(f.bucket, "a.jsonl"), two = path.join(f.bucket, "b.jsonl");
	writeJsonl(one, [header("one", f.cwd), message("a", null, Date.now(), "user", "kept needle")]);
	writeJsonl(two, [header("two", f.cwd), message("b", null, Date.now(), "user", "vanished needle")]);
	await reconcileCatalog({ ...f, all: true });
	const failed = await reconcileCatalog({ ...f, all: true, onFile(file) { if (file === one) fs.unlinkSync(two); } });
	assert.equal(failed.scopeComplete, false); assert.equal(failed.failed, 1);
	const partial = searchCatalog("vanished needle", { ...f, allowPartial: true });
	assert.equal(partial.results.length, 0); assert.equal(partial.coverage.missingFiles, 1);
	const db = openCatalog(f.databasePath, { readOnly: true });
	try { const row = db.prepare("SELECT index_status,missing_since_ms FROM files WHERE path=?").get(two);
		assert.equal(row.index_status, "stale"); assert.ok(row.missing_since_ms > 0);
	} finally { closeCatalog(db); }
	await reconcileCatalog({ ...f, all: true, missingGraceMs: 0 });
	assert.equal(searchCatalog("kept needle", { ...f }).coverage.scopeComplete, true);
});

test("successful covering repairs retire only covered failed scope receipts, including removed paths", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const childCwd = path.join(f.cwd, "child"), siblingCwd = path.join(f.root, "sibling");
	const child = path.join(f.sessionsRoot, encodeSessionBucket(childCwd), "child.jsonl"), sibling = path.join(f.sessionsRoot, encodeSessionBucket(siblingCwd), "sibling.jsonl");
	const file = path.join(f.bucket, "repair.jsonl"), removed = path.join(f.bucket, "removed.jsonl");
	for (const source of [file, child, sibling, removed]) {
		writeJsonl(source, [{ type: "session", id: "bad" }]);
		assert.equal((await reconcileCatalog({ ...f, path: source })).scopeComplete, false);
	}
	writeJsonl(file, [header("repair", f.cwd), message("r", null, Date.now(), "user", "repair needle")]);
	writeJsonl(child, [header("child", childCwd)]); fs.unlinkSync(removed);
	assert.equal((await reconcileCatalog({ ...f, cwd: f.cwd, tree: true })).scopeComplete, true);
	let db = openCatalog(f.databasePath, { readOnly: true });
	try { assert.deepEqual(db.prepare("SELECT scope_key FROM reconcile_scopes WHERE complete=0").all().map((row) => row.scope_key), [`path:${sibling}`]); }
	finally { closeCatalog(db); }
	assert.equal(searchCatalog("repair needle", { ...f, cwd: undefined, allowPartial: true }).coverage.failedScopes, 1);
	writeJsonl(sibling, [header("sibling", siblingCwd)]);
	assert.equal((await reconcileCatalog({ ...f, all: true, missingGraceMs: 0 })).scopeComplete, true);
	assert.equal(searchCatalog("repair needle", { ...f }).coverage.scopeComplete, true);
});

test("interrupted-write recovery uses indexed visibility ranges and includes post-publish obsolete epochs", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const file = path.join(f.bucket, "visibility.jsonl");
	writeJsonl(file, [header("visibility", f.cwd), message("v", null, Date.now(), "user", "visible needle")]);
	await reconcileCatalog({ ...f, all: true });
	let db = openCatalog(f.databasePath);
	try {
		const row = db.prepare("SELECT * FROM files WHERE path=?").get(file);
		db.prepare("UPDATE files SET active_epoch=2 WHERE file_id=?").run(row.file_id);
		db.prepare("UPDATE entries SET epoch=2 WHERE file_id=?").run(row.file_id);
		const insert = db.prepare("INSERT INTO entries(file_id,epoch,generation,ordinal,type,byte_start,byte_end,source_sha256) VALUES(?,?,?,?,'custom',0,0,'staging')");
		insert.run(row.file_id, 1, 1, 10); insert.run(row.file_id, 3, 1, 11); insert.run(row.file_id, 2, 2, 12);
		const source = fs.readFileSync(new URL("../lib/session-catalog/index.mjs", import.meta.url), "utf8");
		const recovery = source.match(/db\.exec\(`(DELETE FROM entries WHERE entry_pk IN \([\s\S]*?\))`\);/)?.[1];
		assert.ok(recovery);
		const plan = db.prepare(`EXPLAIN QUERY PLAN ${recovery}`).all().map((row) => row.detail);
		assert.equal(plan.filter((detail) => detail.includes("SEARCH e USING COVERING INDEX entries_visible")).length, 3, plan.join("\n"));
		assert.equal(plan.some((detail) => /^SCAN (?:entries|e)\b/u.test(detail)), false, plan.join("\n"));
	} finally { closeCatalog(db); }
	db = openCatalog(f.databasePath);
	try { assert.deepEqual(db.prepare("SELECT epoch,generation FROM entries").all().map((row) => [row.epoch, row.generation]), [[2, 1]]); }
	finally { closeCatalog(db); }
	assert.equal(searchCatalog("visible needle", { ...f }).results.length, 1);
});

test("multi-match BM25 and exact-session search stop safely and match exhaustive results", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const file = path.join(f.bucket, "many-matches.jsonl"), time = Date.now() - 10_000;
	const rows = [header("many-matches", f.cwd, time)];
	for (let index = 0; index < 5000; index++) rows.push(message(`m${index}`, index ? `m${index - 1}` : null, time + index,
		"user", `multibound needle ${"padding ".repeat(40)}`));
	writeJsonl(file, rows);
	await reconcileCatalog({ ...f, all: true });
	for (const pathOption of [{ limit: 1 }, { path: file }]) for (const matchLimit of [2, 10, 50]) {
		const options = { ...f, ...pathOption, matchLimit };
		const bounded = searchCatalog("multibound", options), exhaustive = searchCatalog("multibound", { ...options, exhaustive: true });
		const withoutReceipt = (response) => response.results.map(({ coverage, ...result }) => result);
		assert.deepEqual(withoutReceipt(bounded), withoutReceipt(exhaustive));
		assert.equal(bounded.performance.earlyStopped, true);
		assert.equal(bounded.performance.contentRowsFetched, matchLimit);
		assert.equal(bounded.performance.candidateRowsScanned, matchLimit + 1);
	}
});

test("overlapping equivalent reconciliations reuse only source-rechecked receipts; source and inventory changes reject reuse", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const file = path.join(f.bucket, "coalesce.jsonl"), added = path.join(f.bucket, "added.jsonl"), runner = path.join(f.root, "writer.mjs");
	const modulePath = new URL("../lib/session-catalog/index.mjs", import.meta.url).href;
	fs.writeFileSync(runner, `import fs from 'node:fs'; import {reconcileCatalog} from ${JSON.stringify(modulePath)};
const options=JSON.parse(process.argv[2]), action=process.argv[3];
if(action) options.onFile=()=>{ console.log('ready'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,800);
if(action==='append') fs.appendFileSync(${JSON.stringify(file)},${JSON.stringify(JSON.stringify(message("new", "old", Date.now(), "user", "queued new needle")) + "\n")});
if(action==='add') fs.writeFileSync(${JSON.stringify(added)},${JSON.stringify([header("added", f.cwd), message("new", null, Date.now(), "user", "queued new needle")].map(JSON.stringify).join("\n") + "\n")});
if(action==='remove') fs.unlinkSync(${JSON.stringify(file)}); };
console.log(JSON.stringify(await reconcileCatalog(options)));`);
	const run = (options, action, onReady) => new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [runner, JSON.stringify(options), ...(action ? [action] : [])]);
		let stdout = "", stderr = "", ready = false;
		child.stdout.on("data", (chunk) => { stdout += chunk; if (!ready && stdout.includes("ready\n")) { ready = true; onReady?.(); } });
		child.stderr.on("data", (chunk) => stderr += chunk); child.on("error", reject);
		child.on("close", (code) => { try { assert.equal(code, 0, stderr); resolve(JSON.parse(stdout.trim().split("\n").at(-1))); } catch (error) { reject(error); } });
	});
	for (const action of ["unchanged", "append", "add", "remove"]) {
		fs.rmSync(added, { force: true });
		writeJsonl(file, [header("coalesce", f.cwd), message("old", null, Date.now(), "user", "queued old needle")]);
		await reconcileCatalog({ ...f, all: true, missingGraceMs: 0 });
		let signalReady; const ready = new Promise((resolve) => signalReady = resolve);
		const first = run({ ...f, all: true }, action, signalReady); await ready;
		const queued = [run({ ...f, all: true }), run({ ...f, all: true })];
		await first; const results = await Promise.all(queued);
		if (action === "unchanged") assert.ok(results.every((result) => result.coalesced === true));
		else assert.ok(results.some((result) => !result.coalesced));
		if (action === "append" || action === "add") assert.equal(searchCatalog("queued new needle", { ...f }).results.length, 1);
		if (action === "remove") assert.equal(searchCatalog("queued old needle", { ...f, allowPartial: true }).results.length, 0);
	}
});


test("deep exact BM25 uses indexed parents and one bounded FTS scan, preserving locators, tiers and ties", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const file = path.join(f.bucket, "deep-quota.jsonl"), noise = path.join(f.bucket, "quota-noise.jsonl"), time = Date.now() - 120_000;
	const text = "quota usage ratio";
	const rows = [header("deep-quota", f.cwd, time),
		message("tool", null, time + 1, "toolResult", text, { toolName: "bash" }),
		entry("compaction", "summary", "tool", time + 2, { summary: text }),
		message("commentary", "summary", time + 3, "assistant", [{ type: "text", text }, { type: "toolCall", id: "call", name: "bash", arguments: {} }]),
		message("final0", "commentary", time + 4, "assistant", text),
		message("final1", "final0", time + 5, "assistant", text),
		message("final2", "final1", time + 6, "assistant", text),
		message("user", "final2", time + 7, "user", text)];
	writeJsonl(file, rows); await reconcileCatalog({ ...f, path: file });
	writeJsonl(noise, [header("quota-noise", f.cwd, time), ...Array.from({ length: 8_000 }, (_, i) => message(`noise${i}`, null, time, "user", text))]);
	await reconcileCatalog({ ...f, path: noise });
	// Appended generations span unrelated rowids. The envelope is only an optimization, never the branch filter.
	let parent = "user"; const tail = [];
	for (let i = 0; i < 56_000; i++) {
		const id = `deep${i}`; tail.push(message(id, parent, time + 8 + i, "assistant", "ancestry padding")); parent = id;
	}
	tail.push(message("duplicate", parent, time + 56_008, "assistant", "first duplicate"),
		message("duplicate", "duplicate", time + 56_009, "assistant", "second duplicate"),
		message("duplicate", null, time + 56_010, "user", text));
	appendJsonl(file, tail); await reconcileCatalog({ ...f, path: file });
	const db = openCatalog(f.databasePath, { readOnly: true }); let leaf;
	try {
		const fileRow = db.prepare("SELECT * FROM files WHERE path=?").get(file);
		leaf = db.prepare("SELECT entry_pk,entry_id,ordinal,byte_start FROM entries WHERE file_id=? AND entry_id='duplicate' ORDER BY ordinal LIMIT 1 OFFSET 1").get(fileRow.file_id);
		const source = fs.readFileSync(new URL("../lib/session-catalog/index.mjs", import.meta.url), "utf8");
		const branchSql = source.match(/sql: `(WITH RECURSIVE branch[\s\S]*?)`/)?.[1]; assert.ok(branchSql);
		const params = [leaf.entry_pk, fileRow.file_id, fileRow.active_epoch, fileRow.active_generation,
			fileRow.file_id, fileRow.active_epoch, fileRow.active_generation];
		const plan = db.prepare(`EXPLAIN QUERY PLAN ${branchSql}SELECT COUNT(*) FROM branch`).all(...params).map((row) => row.detail);
		const childLoop = plan.findIndex((detail) => detail === "SCAN child"), parentLoop = plan.findIndex((detail) => detail.includes("SEARCH p USING INDEX entries_id"));
		assert.ok(childLoop >= 0 && parentLoop > childLoop, plan.join("\n"));
		assert.match(plan[parentLoop], /entry_id=\? AND ordinal=\?/u);
		assert.equal(plan.some((detail) => detail.includes("entries_visible")), false, "recursive parents must not scan the file per step");
	} finally { closeCatalog(db); }
	// A synchronous SQLite regression cannot strand the test process: the deep search runs in a capped child.
	const cli = await new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [CLI, "search", "--database", f.databasePath, "--path", file,
			"--leaf", "duplicate", "--leaf-byte-start", String(leaf.byte_start), "--include-tools", "--matches", "6", "--compact", "--", text],
			{ timeout: 5_000, killSignal: "SIGKILL" });
		let stdout = "", stderr = "";
		child.stdout.on("data", (chunk) => stdout += chunk); child.stderr.on("data", (chunk) => stderr += chunk);
		child.on("error", reject); child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
	});
	assert.equal(cli.code, 0, `deep exact search failed or exceeded five seconds (${cli.signal}): ${cli.stderr}`);
	const bounded = JSON.parse(cli.stdout);
	assert.deepEqual(bounded.results[0].matches.map((match) => match.matchedEntryId), ["user", "final0", "final1", "final2", "summary", "commentary"]);
	const options = { databasePath: f.databasePath, path: file, leaf: "duplicate", leafByteStart: leaf.byte_start, includeTools: true, matchLimit: 6 };
	const exhaustive = searchCatalog(text, { ...options, exhaustive: true });
	assert.deepEqual(bounded.results[0].matches, exhaustive.results[0].matches);
	assert.equal(bounded.coverage.leafRef.byteStart, leaf.byte_start);
	const assistants = searchCatalog(text, { ...options, roles: ["assistant"] });
	assert.deepEqual(assistants.results[0].matches.map((match) => match.matchedEntryId), ["final0", "final1", "final2", "commentary"]);
	assert.throws(() => searchCatalog(text, { ...options, leafByteStart: undefined }), /ambiguous leaf/u);
	const latest = searchCatalog(text, { databasePath: f.databasePath, path: file, matchLimit: 6 });
	assert.deepEqual(latest.results[0].matches.map((match) => match.matchedEntryId), ["duplicate"]);
	assert.equal(latest.coverage.branchSelection, "latest-persisted-ancestry-not-live");
});


test("successful covering inventories retire absent unbound failures without clearing other roots, scopes or existing unsafe paths", async (t) => {
	const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	const childCwd = path.join(f.cwd, "child"), siblingCwd = path.join(f.root, "sibling");
	const kept = path.join(f.bucket, "a-kept.jsonl"), absent = path.join(f.bucket, "b-new.jsonl"), unsafe = path.join(f.bucket, "c-unsafe.jsonl");
	const child = path.join(f.sessionsRoot, encodeSessionBucket(childCwd), "child.jsonl"), sibling = path.join(f.sessionsRoot, encodeSessionBucket(siblingCwd), "sibling.jsonl");
	const external = path.join(f.root, "external", "external.jsonl"), broken = path.join(f.bucket, "broken.jsonl");
	writeJsonl(kept, [header("kept", f.cwd), message("k", null, Date.now(), "user", "unbound repair needle")]);
	writeJsonl(absent, [header("absent", f.cwd)]);
	assert.equal((await reconcileCatalog({ ...f, onFile(file) { if (file === kept) fs.unlinkSync(absent); } })).scopeComplete, false);
	// Fail after discovery but before placeholder creation, including a deliberate external source.
	for (const [file, cwd] of [[child, childCwd], [sibling, siblingCwd], [external, f.cwd], [unsafe, f.cwd]]) {
		writeJsonl(file, [header("new", cwd)]); const original = fs.statSync;
		fs.statSync = function(source, options) {
			if (source === file && options?.bigint) fs.unlinkSync(file);
			return original.call(this, source, options);
		};
		try { assert.equal((await reconcileCatalog({ ...f, path: file })).scopeComplete, false); }
		finally { fs.statSync = original; }
	}
	const unbound = () => {
		const db = openCatalog(f.databasePath, { readOnly: true });
		try { return db.prepare("SELECT path FROM file_failures WHERE path NOT IN (SELECT path FROM files) ORDER BY path").all().map((row) => row.path); }
		finally { closeCatalog(db); }
	};
	assert.deepEqual(unbound(), [absent, child, sibling, external, unsafe].sort());
	assert.equal((await reconcileCatalog({ ...f, path: kept })).scopeComplete, true);
	assert.deepEqual(unbound(), [absent, child, sibling, external, unsafe].sort(), "a successful exact path cannot repair other paths");
	writeJsonl(broken, [{ type: "session", id: "invalid" }]);
	assert.equal((await reconcileCatalog({ ...f })).scopeComplete, false);
	assert.ok(unbound().includes(absent), "an incomplete inventory must not retire the missing failure");
	writeJsonl(broken, [header("fixed", f.cwd)]);
	fs.symlinkSync(path.join(f.root, "nonexistent"), unsafe);
	assert.equal((await reconcileCatalog({ ...f })).scopeComplete, true);
	assert.deepEqual(unbound(), [child, sibling, external, unsafe].sort(), "a present dangling symlink is not an absent source");
	fs.unlinkSync(unsafe);
	assert.equal((await reconcileCatalog({ ...f })).scopeComplete, true);
	const repaired = searchCatalog("unbound repair needle", { ...f });
	assert.equal(repaired.coverage.scopeComplete, true); assert.equal(repaired.coverage.failedFiles, 0);
	assert.deepEqual(unbound(), [child, sibling, external].sort());
	assert.equal((await reconcileCatalog({ ...f, tree: true })).scopeComplete, true);
	assert.deepEqual(unbound(), [sibling, external].sort());
	assert.equal((await reconcileCatalog({ ...f, all: true })).scopeComplete, true);
	assert.deepEqual(unbound(), [external]);
	const global = searchCatalog("unbound repair needle", { ...f, cwd: undefined });
	assert.equal(global.coverage.scopeComplete, true); assert.equal(global.coverage.failedFiles, 0);
});

test("coalesced successful inventories repair intervening covered receipts and never reuse stale rows", async (t) => {
	for (const scopeOptions of [{ all: true }, {}]) {
		const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
		const kept = path.join(f.bucket, "kept.jsonl"), absent = path.join(f.bucket, "removed.jsonl");
		const sibling = path.join(f.sessionsRoot, encodeSessionBucket(path.join(f.root, "sibling")), "missing.jsonl");
		const external = path.join(f.root, "external", "missing.jsonl");
		fs.mkdirSync(path.dirname(sibling), { recursive: true }); fs.mkdirSync(path.dirname(external), { recursive: true });
		writeJsonl(kept, [header("kept", f.cwd), message("k", null, Date.now(), "user", "coalesced repair needle")]);
		const options = { ...f, ...scopeOptions };
		assert.equal((await reconcileCatalog(options)).scopeComplete, true);
		let db = openCatalog(f.databasePath, { readOnly: true }), completedAt;
		try { completedAt = db.prepare("SELECT reconciled_at_ms FROM reconcile_scopes WHERE scope_type=?").get(scopeOptions.all ? "all" : "cwd").reconciled_at_ms; }
		finally { closeCatalog(db); }
		writeJsonl(absent, [header("new", f.cwd)]); const originalStat = fs.statSync;
		fs.statSync = function(source, statOptions) {
			if (source === absent && statOptions?.bigint) fs.unlinkSync(absent);
			return originalStat.call(this, source, statOptions);
		};
		try { assert.equal((await reconcileCatalog({ ...f, path: absent })).scopeComplete, false); }
		finally { fs.statSync = originalStat; }
		for (const file of [sibling, external]) assert.equal((await reconcileCatalog({ ...f, path: file })).scopeComplete, false);
		const before = searchCatalog("coalesced repair needle", { ...f, cwd: undefined, allowPartial: true }).coverage;
		assert.equal(before.failedScopes, 2); assert.equal(before.failedFiles, 1);
		// Model a request that began before the successful writer's receipt but acquired the lock after the failed path writer.
		const overlap = async () => {
			const original = Date.now; Date.now = () => completedAt - 1;
			try { return await reconcileCatalog(options); } finally { Date.now = original; }
		};
		const reused = await overlap();
		assert.equal(reused.coalesced, true); assert.equal(reused.scopeComplete, true);
		db = openCatalog(f.databasePath, { readOnly: true });
		try {
			const failed = db.prepare("SELECT scope_key FROM reconcile_scopes WHERE complete=0 ORDER BY scope_key").all().map((row) => row.scope_key);
			assert.deepEqual(failed, (scopeOptions.all ? [external] : [sibling, external]).map((file) => `path:${file}`).sort());
		} finally { closeCatalog(db); }
		const coverage = searchCatalog("coalesced repair needle", { ...f, cwd: undefined, allowPartial: true }).coverage;
		assert.equal(coverage.failedScopes, scopeOptions.all ? 0 : 1); assert.equal(coverage.failedFiles, 0);
		db = openCatalog(f.databasePath);
		try { db.prepare("UPDATE files SET index_status='stale',last_error='intervening failure' WHERE path=?").run(kept); }
		finally { closeCatalog(db); }
		const reindexed = await overlap();
		assert.notEqual(reindexed.coalesced, true); assert.equal(reindexed.rebuilt, 1);
		assert.equal(searchCatalog("coalesced repair needle", { ...f }).coverage.scopeComplete, true);
	}
});

import * as fs from "node:fs";
import { spyOn } from "bun:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import subagentExtension, { findLatestContinuation, type SingleResult, type SubagentDetails } from "./index.ts";
import { getContinuationLocation, listContinuationMetadata, readContinuationManifest, writeContinuationManifest, type ContinuationManifest } from "./continuation-store.ts";

function fixture(t: any) {
	const root = fs.mkdtempSync(join(tmpdir(), "continuation-discovery-"));
	const prior = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	t.after(() => { if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior; fs.rmSync(root, { recursive: true, force: true }); });
	return root;
}
function result(status: SingleResult["status"] = "completed"): SingleResult {
	return { agent: "fixture", agentSource: "user", task: "work", exitCode: status === "completed" ? 0 : 130,
		status, stopReason: status === "completed" ? "stop" : "aborted", stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		messages: [{ role: "assistant", content: [{ type: "text", text: "legacy evidence" }], stopReason: "stop", timestamp: 1 } as any] };
}
function details(mode: SubagentDetails["mode"] = "single", status: SingleResult["status"] = "completed"): SubagentDetails {
	return { mode, agentScope: "user", projectAgentsDir: null, results: [result(status), ...(mode === "single" ? [] : [result(status)])] };
}
function branch(value: SubagentDetails, id = "call") {
	return [
		{ type: "message", id: "assistant", message: { role: "assistant", content: [{ type: "toolCall", id, name: "subagent", arguments: { agent: "fixture", task: "work" } }] } },
		{ type: "message", id: "result", message: { role: "toolResult", toolName: "subagent", toolCallId: id, details: value } },
	];
}
function lifecycle() {
	let agentEnd: any;
	const appended: any[] = [], sent: any[] = [];
	const commands = new Map<string, any>();
	subagentExtension({ events: { on() {}, emit() {} }, registerTool() {}, registerCommand(name: string, command: any) { commands.set(name, command); }, registerShortcut() {},
		on(event: string, handler: any) { if (event === "agent_end") agentEnd = handler; },
		appendEntry(customType: string, data: any) { appended.push({ customType, data }); },
		sendMessage(message: any, options: any) { sent.push({ message, options }); },
	} as any);
	return { agentEnd, appended, commands, sent };
}
function context(entries: any[], sessionId = "owner", sessionFile?: string) {
	return { sessionManager: { getBranch: () => entries, getSessionId: () => sessionId, getSessionFile: () => sessionFile } };
}

for (const mode of ["single", "parallel", "fan-in", "chain"] as const) {
	for (const check of ["findLatestContinuation", "agent_end"]) {
		test(`terminal legacy ${mode}: repeated ${check} does zero result-store writes`, (t) => {
			const root = fixture(t);
			const value = details(mode);
			// No explicit status on one result: retain the original legacy status inference too.
			delete value.results[0].status;
			const entries = branch(value);
			const { agentEnd } = lifecycle();
			const write = spyOn(fs, "writeFileSync");
			try {
				for (let i = 0; i < 3; i++) {
					if (check === "findLatestContinuation") assert.equal(findLatestContinuation(entries, { sessionId: "owner" }), undefined);
					else agentEnd({}, context(entries));
				}
				assert.equal(write.mock.calls.length, 0);
				assert.equal(fs.existsSync(join(root, "subagent-runs", "results")), false);
				assert.equal(value.results[0].messages.length, 1);
			} finally { write.mockRestore(); }
		});
	}
}

function manifest(id: string, owner: string, value = details("single", "interrupted"), status: ContinuationManifest["status"] = "interrupted", updatedAt = 1): ContinuationManifest {
	return { version: 1, id, parentSessionId: owner, parentSessionFile: `/sessions/${owner}.jsonl`, parentBranchAnchor: "assistant",
		parentToolCallId: id, mode: value.mode, args: { agent: "fixture", task: "work" }, details: value, status, createdAt: 1, updatedAt };
}
// Write the original layout directly: no normalization, summary or migration.
function legacyManifest(value: ContinuationManifest, payloadFirst = false) {
	const location = getContinuationLocation(value.id, value.parentSessionId);
	fs.mkdirSync(location.dir, { recursive: true });
	fs.writeFileSync(location.filePath, JSON.stringify(payloadFirst ? { details: value.details, args: value.args, ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== "details" && key !== "args")) } : value));
	return location.filePath;
}
function oversized(mode: SubagentDetails["mode"] = "single") {
	const value = details(mode);
	value.results[0].messages = [{ role: "toolResult", toolCallId: "image", content: [{ type: "image", mimeType: "image/png", data: "x".repeat(8 * 1024 * 1024) }] } as any];
	return value;
}
function watchReads() {
	const payloads: string[] = [];
	const reads: number[] = [];
	const originalFile = fs.readFileSync, originalRead = fs.readSync;
	const file = spyOn(fs, "readFileSync").mockImplementation(((name: any, ...args: any[]) => {
		if (typeof name === "string" && name.endsWith("manifest.json")) payloads.push(name);
		return (originalFile as any)(name, ...args);
	}) as any);
	const read = spyOn(fs, "readSync").mockImplementation(((fd: any, buffer: any, offset: any, length: any, position: any) => {
		const count = originalRead(fd, buffer, offset, length, position); reads.push(count); return count;
	}) as any);
	return { payloads, reads, restore() { file.mockRestore(); read.mockRestore(); } };
}

test("oversized unrelated legacy manifests are rejected by identity without payload reads", (t) => {
	fixture(t);
	for (const mode of ["single", "parallel", "fan-in", "chain"] as const) legacyManifest(manifest(`unrelated-${mode}`, `other-${mode}`, oversized(mode), "ready"));
	const pending = details("parallel", "pending");
	const own = legacyManifest(manifest("call", "owner", pending));
	const lifecycleEntries = branch(details());
	const { agentEnd } = lifecycle();
	const watched = watchReads();
	try {
		const candidate = findLatestContinuation(branch(pending), { sessionId: "owner", sessionFile: "/sessions/owner.jsonl" });
		assert.equal(candidate?.manifest?.parentSessionId, "owner");
		assert.deepEqual(watched.payloads, [own]);
		assert.ok(watched.reads.reduce((a, b) => a + b, 0) < 512 * 1024);
		watched.payloads.length = 0; watched.reads.length = 0;
		// A different owner's terminal result must not settle/remove this owner's call.
		agentEnd({}, context(lifecycleEntries, "another-owner"));
		assert.deepEqual(watched.payloads, []);
		assert.ok(watched.reads.reduce((a, b) => a + b, 0) < 512 * 1024);
		assert.equal(fs.existsSync(own), true);
	} finally { watched.restore(); }
});

test("legacy metadata after oversized payloads is streamed in bounded chunks without JSON hydration or writes", (t) => {
	fixture(t);
	const file = legacyManifest(manifest("unrelated", "other", oversized()), true);
	const bytes = fs.statSync(file).size;
	const watched = watchReads();
	const write = spyOn(fs, "writeFileSync");
	try {
		assert.equal(listContinuationMetadata(undefined, { parentSessionId: "owner" }).length, 0);
		assert.equal(watched.payloads.length, 0);
		assert.ok(watched.reads.reduce((a, b) => a + b, 0) >= bytes - 64 * 1024);
		assert.ok(watched.reads.every((count) => count <= 64 * 1024));
		assert.equal(write.mock.calls.length, 0);
	} finally { watched.restore(); write.mockRestore(); }
});

test("agent_end only hydrates actionable exact-owner manifests and keeps other forks intact", (t) => {
	fixture(t);
	const completed = details("fan-in");
	const own = legacyManifest(manifest("call", "owner", completed, "ready"));
	const fork = legacyManifest(manifest("call", "fork", oversized("chain"), "ready"));
	const wrongFile = legacyManifest({ ...manifest("wrong-file", "owner", oversized()), parentSessionFile: "/sessions/different.jsonl" });
	const dormant = legacyManifest(manifest("pending", "owner", oversized("parallel")));
	const { agentEnd, appended } = lifecycle();
	const watched = watchReads();
	try {
		const entries = branch(completed);
		for (let i = 0; i < 3; i++) agentEnd({}, context(entries, "owner", "/sessions/owner.jsonl"));
		assert.deepEqual(watched.payloads, [own]);
		assert.ok(watched.reads.reduce((a, b) => a + b, 0) < 1024 * 1024);
		assert.equal(appended.length, 1);
		assert.equal(appended[0].data.status, "completed");
		assert.equal(fs.existsSync(own), false);
		for (const file of [fork, wrongFile, dormant]) assert.equal(fs.existsSync(file), true);
		assert.equal(fs.existsSync(join(process.env.PI_CODING_AGENT_DIR!, "subagent-runs", "results")), false);
	} finally { watched.restore(); }
});

for (const mode of ["single", "parallel", "fan-in", "chain"] as const) {
	test(`ready source ${mode} results are adopted across surviving forks before newer pending manifests`, (t) => {
		fixture(t);
		const ready = details(mode);
		ready.results[0].resume = { runId: "source", dir: "/source", filePath: "/source/child.jsonl", baselineEntryId: "baseline" };
		legacyManifest(manifest("call", "source", ready, "ready", 10), true);
		legacyManifest(manifest("call", "newer-pending-source", oversized(mode), "pending", 100));
		for (const fork of ["fork-a", "fork-b"]) {
			legacyManifest(manifest("call", fork, details(mode, "pending"), "pending", 20));
			// Same parent ID but wrong file must not become mutable owner.
			const candidate = findLatestContinuation(branch(details(mode, "interrupted")), { sessionId: fork, sessionFile: `/sessions/${fork}.jsonl` });
			assert.equal(candidate?.manifest?.parentSessionId, fork);
			assert.equal(candidate?.sourceManifest?.parentSessionId, "source");
			assert.equal(candidate?.manifestStatus, "ready");
			assert.ok(candidate?.details.results.every((item) => item.status === "completed" && !item.resume));
		}
		const mismatched = findLatestContinuation(branch(details(mode, "pending")), { sessionId: "fork-a", sessionFile: "/sessions/elsewhere.jsonl" });
		assert.equal(mismatched?.manifest, undefined);
		assert.equal(mismatched?.sourceManifest?.parentSessionId, "source");
	});
}

test("resolved receipts rank as ready, newest ready wins, and source inspection leaves unselected pending payloads unread", (t) => {
	fixture(t);
	const ready = legacyManifest(manifest("call", "source", details(), "ready", 10));
	const resolved = legacyManifest(manifest("call", "resolved-source", details(), "resolved", 11));
	legacyManifest(manifest("call", "newest-pending", oversized(), "pending", 100));
	const own = legacyManifest(manifest("call", "owner", details("single", "pending"), "pending", 20));
	const watched = watchReads();
	try {
		const candidate = findLatestContinuation(branch(details("single", "pending")), { sessionId: "owner" });
		assert.equal(candidate?.sourceManifest?.parentSessionId, "resolved-source");
		assert.equal(candidate?.manifestStatus, "resolved");
		assert.deepEqual(new Set(watched.payloads), new Set([resolved, own]));
		assert.equal(watched.payloads.includes(ready), false);
	} finally { watched.restore(); }
});

test("legacy running results remain recoverable with and without resume handles", (t) => {
	fixture(t);
	for (const resume of [undefined, { runId: "run", dir: "/run", filePath: "/run/child.jsonl", baselineEntryId: "baseline" }]) {
		const value = details("chain", "running");
		value.results[0].resume = resume;
		const candidate = findLatestContinuation(branch(value), { sessionId: "owner" });
		assert.equal(candidate?.details.results[0].status, resume ? "interrupted" : "pending");
	}
});

test("malformed selected manifests and real read errors propagate instead of falling back to stale branch state", (t) => {
	fixture(t);
	const file = legacyManifest(manifest("call", "owner"));
	const valid = fs.readFileSync(file, "utf8");
	for (const malformed of [valid.replace('"details":{', '"details":invalid,'), valid.slice(0, -1), valid + "garbage", valid.replace('"updatedAt":1', '"updatedAt":{}'), valid.replace('"parentSessionId":"owner"', '"parentSessionId":123'), valid.replace('"results":[', '"notResults":[')]) {
		fs.writeFileSync(file, malformed);
		assert.throws(() => findLatestContinuation(branch(details("single", "pending")), { sessionId: "owner" }));
	}
	fs.writeFileSync(file, valid);
	const read = spyOn(fs, "readFileSync").mockImplementation((() => { throw Object.assign(new Error("fixture read denied"), { code: "EACCES" }); }) as any);
	try { assert.throws(() => readContinuationManifest("call", undefined, "owner"), /fixture read denied/); }
	finally { read.mockRestore(); }
});


test("completed legacy custom state and failed parent results do not spill during discovery", (t) => {
	const root = fixture(t);
	const write = spyOn(fs, "writeFileSync");
	try {
		for (const mode of ["single", "parallel", "fan-in", "chain"] as const) {
			const value = details(mode);
			const entries: any[] = [branch(value)[0], { type: "custom", customType: "subagent-continuation", data: { id: "call", status: "interrupted", details: value } }];
			assert.equal(findLatestContinuation(entries), undefined);
			for (const item of value.results) { delete item.status; item.exitCode = 1; item.stopReason = "error"; }
			assert.equal(findLatestContinuation(branch(value)), undefined);
		}
		assert.equal(write.mock.calls.length, 0);
		assert.equal(fs.existsSync(join(root, "subagent-runs", "results")), false);
	} finally { write.mockRestore(); }
});

test("ready fan-in receipt delivery is independently adopted and settled by two surviving forks", async (t) => {
	const root = fixture(t);
	const value = details("fan-in");
	const source = legacyManifest(manifest("call", "source", value, "ready", 10));
	const evidence = fs.readFileSync(source);
	for (const fork of ["fork-a", "fork-b"]) {
		legacyManifest(manifest("call", fork, details("fan-in", "pending"), "pending", 100));
		const { agentEnd, commands, sent } = lifecycle();
		const entries: any[] = branch(details("fan-in", "interrupted"));
		const ctx = { ...context(entries, fork, `/sessions/${fork}.jsonl`), cwd: root, isIdle: () => true, mode: "rpc",
			ui: { setStatus() {}, notify(message: string) { throw new Error(message); } } };
		await commands.get("continue").handler("", ctx);
		assert.deepEqual(sent.map((item) => item.message.customType), ["subagent-continuation-result", "subagent-continuation-trigger"]);
		assert.match(sent[0].message.content, /legacy evidence/);
		const receipt = readContinuationManifest<any, SubagentDetails>("call", undefined, fork)!;
		assert.equal(receipt.status, "ready");
		assert.ok(receipt.details.results.every((item) => item.finalText === "legacy evidence" && !item.resume));
		entries.push({ type: "custom_message", ...sent[0].message });
		agentEnd({}, ctx);
		assert.equal(readContinuationManifest("call", undefined, fork)?.status, "resolved");
		await commands.get("continue").handler("", ctx);
		assert.equal(sent.at(-1).message.customType, "main-continuation");
		assert.deepEqual(fs.readFileSync(source), evidence);
	}
});


test("new manifest writes put discovery metadata before legacy payloads regardless of caller field order", (t) => {
	fixture(t);
	const value = manifest("call", "other", oversized());
	const location = writeContinuationManifest(Object.assign({ details: value.details, args: value.args }, value));
	const watched = watchReads();
	try {
		assert.deepEqual(listContinuationMetadata(undefined, { parentSessionId: "owner" }), []);
		assert.deepEqual(watched.payloads, []);
		assert.ok(watched.reads.reduce((a, b) => a + b, 0) <= 64 * 1024);
	} finally { watched.restore(); }
	assert.equal(readContinuationManifest<any, SubagentDetails>("call", undefined, "other")?.details.results[0].messages.length, 1);
	assert.equal(fs.existsSync(location.filePath), true);
});


test("agent_end receipt targeting preserves distinct manifest and tool-call IDs", (t) => {
	fixture(t);
	const location = legacyManifest({ ...manifest("receipt", "owner", details(), "ready"), parentToolCallId: "different-call" });
	const { agentEnd, appended } = lifecycle();
	agentEnd({}, context([{ type: "custom_message", customType: "subagent-continuation-result", details: { continuationId: "receipt" } }], "owner"));
	assert.equal(readContinuationManifest("receipt", undefined, "owner")?.status, "resolved");
	assert.equal(appended[0].data.id, "receipt");
	assert.equal(fs.existsSync(location), true);
});


test("streaming legacy projection handles chunk-split escapes, UTF-8 and every skipped JSON value type", (t) => {
	fixture(t);
	const owner = 'ownér"\\漢';
	const id = 'call"\\😺';
	const value = manifest(id, owner);
	value.args = { text: ('é漢😺\\"{}[]').repeat(40_000), nested: [{ empty: {}, values: [true, false, null, -0, -1.2e+3, []] }] };
	legacyManifest(value, true);
	const watched = watchReads();
	try {
		const metadata = listContinuationMetadata(undefined, { toolCallIds: new Set([id]), parentSessionId: owner });
		assert.equal(metadata.length, 1);
		assert.equal(metadata[0].id, id);
		assert.equal(metadata[0].parentSessionId, owner);
		assert.equal(metadata[0].status, "interrupted");
		assert.deepEqual(watched.payloads, []);
		assert.ok(watched.reads.every((count) => count <= 64 * 1024));
	} finally { watched.restore(); }
});


const unidentifiedCorruptManifests = [
	["empty", ""],
	["opening brace", "{"],
	["malformed payload before owner", '{"version":1,"details":invalid,"parentSessionId":"historical"}'],
	["incomplete v1 metadata", '{"version":1}'],
] as const;

for (const [name, corrupt] of unidentifiedCorruptManifests) {
	for (const check of ["findLatestContinuation", "agent_end"]) {
		test(`${check} skips unidentified historical ${name} corruption`, (t) => {
			fixture(t);
			const historical = legacyManifest(manifest("historical-call", "historical-owner"));
			fs.writeFileSync(historical, corrupt);
			const own = legacyManifest(manifest("call", "owner", details(), "ready"));
			const { agentEnd, appended } = lifecycle();
			if (check === "findLatestContinuation") {
				assert.equal(findLatestContinuation(branch(details("single", "pending")), { sessionId: "owner" })?.manifest?.parentSessionId, "owner");
			} else {
				agentEnd({}, context(branch(details())));
				assert.equal(appended[0].data.status, "completed");
				assert.equal(fs.existsSync(own), false);
			}
			assert.equal(fs.readFileSync(historical, "utf8"), corrupt);
		});
	}
}

test("unidentified unreadable historical files are best-effort per file", (t) => {
	fixture(t);
	const historical = legacyManifest(manifest("historical-call", "historical-owner"));
	legacyManifest(manifest("call", "owner", details(), "ready"));
	const { agentEnd, appended } = lifecycle();
	const original = fs.openSync;
	const open = spyOn(fs, "openSync").mockImplementation(((file: any, ...args: any[]) => {
		if (file === historical) throw Object.assign(new Error("historical read denied"), { code: "EACCES" });
		return (original as any)(file, ...args);
	}) as any);
	try {
		assert.equal(findLatestContinuation(branch(details("single", "pending")), { sessionId: "owner" })?.id, "call");
		agentEnd({}, context(branch(details())));
		assert.equal(appended[0].data.status, "completed");
	} finally { open.mockRestore(); }
});

test("known owner/candidate file identity keeps even headerless corruption strict", (t) => {
	fixture(t);
	const file = legacyManifest(manifest("call", "owner"));
	const { agentEnd } = lifecycle();
	for (const [, corrupt] of unidentifiedCorruptManifests) {
		fs.writeFileSync(file, corrupt);
		assert.throws(() => findLatestContinuation(branch(details("single", "pending")), { sessionId: "owner" }));
		assert.throws(() => agentEnd({}, context(branch(details()))));
		assert.throws(() => readContinuationManifest("call", undefined, "owner"));
	}
});

test("identified source corruption stays strict without a matching mutable owner", (t) => {
	fixture(t);
	const file = legacyManifest(manifest("call", "source"));
	fs.writeFileSync(file, '{"version":1,"id":"call","parentSessionId":123}');
	assert.throws(() => findLatestContinuation(branch(details("single", "pending")), { sessionId: "fork" }));
});


test("unreadable known candidate files remain strict before metadata is available", (t) => {
	fixture(t);
	const file = legacyManifest(manifest("call", "owner"));
	const { agentEnd } = lifecycle();
	const original = fs.openSync;
	const open = spyOn(fs, "openSync").mockImplementation(((name: any, ...args: any[]) => {
		if (name === file) throw Object.assign(new Error("candidate read denied"), { code: "EACCES" });
		return (original as any)(name, ...args);
	}) as any);
	try {
		assert.throws(() => findLatestContinuation(branch(details("single", "pending")), { sessionId: "owner" }), /candidate read denied/);
		assert.throws(() => agentEnd({}, context(branch(details()))), /candidate read denied/);
	} finally { open.mockRestore(); }
});

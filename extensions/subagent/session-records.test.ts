import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { appendSessionRecord, branchMessages, recoverSessionTail, sessionMetadata } from "./session-records.ts";

test("metadata scans never parse or retain heavy payloads, regardless of top-level key order", (t) => {
	const root = mkdtempSync(join(tmpdir(), "session-metadata-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const file = join(root, "session.jsonl");
	const original = [
		{ type: "session", id: "session", cwd: root, version: 3 },
		{ type: "custom", customType: "boundary", data: {}, id: "a", parentId: null },
		{ message: { role: "toolResult", content: [{ type: "image", data: '👀\\\"{[,:}'.repeat(200_000) }] }, type: "message", id: "b", parentId: "a" },
	].map((record) => JSON.stringify(record)).join("\n");
	writeFileSync(file, original);
	const parse = JSON.parse;
	JSON.parse = ((value: string, ...args: any[]) => { assert.ok(value.length < 65536, "metadata must not hydrate message JSON"); return parse(value, ...args); }) as any;
	let metadata;
	try { metadata = sessionMetadata(file); } finally { JSON.parse = parse; }
	assert.equal(metadata.entries.length, 2);
	assert.equal(metadata.byId.get("b").parentId, "a");
	assert.ok(JSON.stringify(metadata.entries).length < 300);
	assert.equal([...branchMessages(file, "a")][0].content[0].type, "image");
	appendSessionRecord(file, { type: "message", message: { role: "assistant", content: [] } });
	assert.ok(readFileSync(file, "utf8").startsWith(original), "appends preserve exact evidence and original entry IDs/parents");
	assert.equal(sessionMetadata(file).entries.at(-1).parentId, "b");
	assert.throws(() => [...branchMessages(file, "missing")], /boundary is missing/);
	appendFileSync(file, '{"type":"message","id":"still-appending","message":{');
	assert.equal(sessionMetadata(file, true).entries.length, 3);
	assert.throws(() => sessionMetadata(file), /Incomplete/);
});


test("tail recovery never conceals a malformed completed payload, even without a truncated tail", (t) => {
	const root = mkdtempSync(join(tmpdir(), "session-corruption-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const file = join(root, "session.jsonl");
	for (const suffix of ['{"type":"message","id":"bad","parentId":null,"message":invalid}\n', '{"type":"message","id":"bad","parentId":null,"message":{}}\n']) {
		const source = '{"type":"session","id":"session"}\n' + suffix;
		writeFileSync(file, source);
		assert.throws(() => recoverSessionTail(file));
		assert.equal(readFileSync(file, "utf8"), source);
	}
});

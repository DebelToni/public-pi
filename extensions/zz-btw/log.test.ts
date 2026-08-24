import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import test from "node:test";
import { BTW_LOG_SCHEMA_VERSION, BtwRunLogger, payloadDiagnostics } from "./log.ts";

const payload = {
	model: "gpt-5.6-sol",
	prompt_cache_key: "shared-key",
	input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
};

test("payload diagnostics are stable and identify the cache key", () => {
	const first = payloadDiagnostics(payload);
	const second = payloadDiagnostics(structuredClone(payload));
	assert.deepEqual(first, second);
	assert.equal(first.promptCacheKey, "shared-key");
	assert.equal(first.inputItems, 1);
	assert.equal(first.sha256.length, 64);
	assert.ok(first.bytes > 0);
});

test("run logger is disabled by default", () => {
	const original = process.env.PI_BTW_DIAGNOSTICS;
	delete process.env.PI_BTW_DIAGNOSTICS;
	try {
		const logger = new BtwRunLogger("session");
		assert.equal(logger.path, "");
		assert.equal(logger.write("sensitive", { payload }), true);
	} finally {
		if (original === undefined) delete process.env.PI_BTW_DIAGNOSTICS;
		else process.env.PI_BTW_DIAGNOSTICS = original;
	}
});

test("run logger appends ordered JSONL with private file permissions", () => {
	const root = mkdtempSync("/tmp/pi-btw-log-test-");
	try {
		chmodSync(root, 0o755);
		const existingPath = `${root}/session_unsafe.jsonl`;
		writeFileSync(existingPath, "");
		chmodSync(existingPath, 0o644);
		const logger = new BtwRunLogger("session/unsafe", root);
		assert.equal(logger.write("first", { fullPayload: payload }), true);
		assert.equal(logger.write("second", { cacheRead: 2048 }), true);
		const records = readFileSync(logger.path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(records.map((record) => record.event), ["first", "second"]);
		assert.deepEqual(records.map((record) => record.schemaVersion), [BTW_LOG_SCHEMA_VERSION, BTW_LOG_SCHEMA_VERSION]);
		assert.deepEqual(records.map((record) => record.sequence), [0, 1]);
		assert.equal(records[0].runId, records[1].runId);
		assert.equal(records[0].fullPayload.prompt_cache_key, "shared-key");
		assert.equal(statSync(root).mode & 0o777, 0o700);
		assert.equal(statSync(logger.path).mode & 0o777, 0o600);
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;
		assert.equal(logger.write("cannot-serialize", { cyclic }), false);
		assert.match(logger.lastError?.message ?? "", /circular|cyclic/i);
	} finally {
		if (root.startsWith("/tmp/pi-btw-log-test-")) rmSync(root, { recursive: true, force: true });
	}
});

test("run logger accepts a symlinked log directory", () => {
	const parent = mkdtempSync("/tmp/pi-btw-log-test-");
	try {
		const target = `${parent}/target`;
		const root = `${parent}/root`;
		mkdirSync(target);
		symlinkSync(target, root);
		const logger = new BtwRunLogger("session", root);
		assert.equal(logger.path, `${realpathSync(target)}/session.jsonl`);
		assert.equal(logger.write("event"), true);
		assert.equal(statSync(target).mode & 0o777, 0o700);
		assert.equal(statSync(logger.path).mode & 0o777, 0o600);
	} finally {
		if (parent.startsWith("/tmp/pi-btw-log-test-")) rmSync(parent, { recursive: true, force: true });
	}
});

test("run logger refuses an existing symlink log file", () => {
	const root = mkdtempSync("/tmp/pi-btw-log-test-");
	try {
		const target = `${root}/target`;
		writeFileSync(target, "");
		symlinkSync(target, `${root}/session.jsonl`);
		assert.throws(() => new BtwRunLogger("session", root), /symbolic link/);
	} finally {
		if (root.startsWith("/tmp/pi-btw-log-test-")) rmSync(root, { recursive: true, force: true });
	}
});

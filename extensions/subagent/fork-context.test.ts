import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { CURRENT_SESSION_VERSION, SessionManager } from "@earendil-works/pi-coding-agent";
import {
	cloneResumableForkSession,
	parseForkTurns,
	resolveSubagentCwd,
	selectForkMessages,
	writeResumableForkSession,
	writeTemporaryForkSession,
} from "./fork-context.ts";

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function user(text: string, timestamp: number): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

function assistant(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-5.6-sol",
		usage,
		stopReason: "stop",
		timestamp,
	};
}

function toolResult(toolCallId: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text: "result" }],
		isError: false,
		timestamp,
	};
}

function fixture() {
	const messages: AgentMessage[] = [
		{ role: "custom", customType: "startup", content: "startup context", display: false, timestamp: 1 },
		user("u1", 2),
		assistant("a1", 3),
		user("u2", 4),
		{
			...assistant("a2", 5),
			content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "README.md" } }],
			stopReason: "toolUse",
		},
		toolResult("read-1", 6),
		user("u3", 7),
		{
			...assistant("delegating", 8),
			content: [
				{ type: "text", text: "delegating" },
				{ type: "toolCall", id: "subagent-1", name: "subagent", arguments: { agent: "general", task: "review" } },
			],
			stopReason: "toolUse",
		},
		toolResult("subagent-1", 9),
	];
	return messages;
}

test("relative child cwd resolves once against the parent cwd", () => {
	assert.equal(resolveSubagentCwd("/repo", undefined), "/repo");
	assert.equal(resolveSubagentCwd("/repo", "child"), "/repo/child");
	assert.equal(resolveSubagentCwd("/repo", "/other"), "/other");
});

test("forkTurns accepts none, all, and positive integer strings", () => {
	assert.deepEqual(parseForkTurns(undefined), { kind: "none" });
	assert.deepEqual(parseForkTurns(" NONE "), { kind: "none" });
	assert.deepEqual(parseForkTurns("All"), { kind: "all" });
	assert.deepEqual(parseForkTurns("3"), { kind: "recent", turns: 3 });
	for (const invalid of ["", "0", "-1", "1.5", "three"]) {
		assert.throws(() => parseForkTurns(invalid), /forkTurns/);
	}
	assert.throws(() => parseForkTurns("999999999999999999999999"), /too large/);
});

test("all forks completed parent context without the active tool-call message", () => {
	const messages = fixture();
	const selected = selectForkMessages(messages, "subagent-1", "all");
	assert.deepEqual(selected, messages.slice(0, 7));
	assert.notEqual(selected, messages);
	assert.notEqual(selected?.[0], messages[0]);
});

test("recent forks count user turns and drop pre-turn startup context", () => {
	const messages = fixture();
	assert.deepEqual(selectForkMessages(messages, "subagent-1", "2"), messages.slice(3, 7));
	assert.deepEqual(selectForkMessages(messages, "subagent-1", "99"), messages.slice(1, 7));
});

test("none stays clean and inherited modes require the active tool call", () => {
	assert.equal(selectForkMessages(fixture(), "missing", "none"), undefined);
	assert.throws(() => selectForkMessages(fixture(), "missing", "all"), /active subagent tool-call message/);
});

test("temporary child session preserves selected messages and private permissions", async () => {
	const messages: AgentMessage[] = [
		{ role: "compactionSummary", summary: "Earlier work", tokensBefore: 1200, timestamp: 10 },
		assistant("Kept pre-compaction answer", 9),
		user("Current task", 11),
		assistant("Current answer", 12),
	];
	const temporary = await writeTemporaryForkSession("/tmp/fork-child-cwd", messages, "/tmp/parent.jsonl");
	try {
		assert.equal(statSync(temporary.dir).mode & 0o777, 0o700);
		assert.equal(statSync(temporary.filePath).mode & 0o777, 0o600);
		const records = readFileSync(temporary.filePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(records[0].version, CURRENT_SESSION_VERSION);
		assert.equal(records[0].cwd, "/tmp/fork-child-cwd");
		assert.equal(records[0].parentSession, "/tmp/parent.jsonl");
		assert.equal(records[1].type, "compaction");
		assert.equal(records[1].parentId, null);
		assert.equal(records[1].firstKeptEntryId, records[2].id);
		assert.equal(records[2].type, "message");
		assert.equal(records[2].message.content[0].text, "Kept pre-compaction answer");
		assert.equal(records[2].parentId, records[1].id);
		assert.equal(records[3].parentId, records[2].id);
		assert.equal(records[4].parentId, records[3].id);
		const reopened = SessionManager.open(temporary.filePath);
		assert.equal(reopened.getBranch().filter((entry) => entry.type === "compaction").length, 1);
		assert.deepEqual(reopened.buildSessionContext().messages, messages);
	} finally {
		assert.match(path.basename(temporary.dir), /^pi-subagent-session-/);
		rmSync(temporary.dir, { recursive: true, force: true });
	}
});

test("resumable child session uses a private durable root", async () => {
	const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-resume-test-"));
	const root = path.join(temporaryRoot, "runs");
	try {
		const resumable = await writeResumableForkSession(
			"/tmp/resumable-child-cwd",
			[user("inherited", 1)],
			"/tmp/parent.jsonl",
			root,
		);
		assert.match(resumable.runId, /^[0-9a-f-]{36}$/);
		assert.equal(path.dirname(resumable.dir), root);
		assert.equal(statSync(root).mode & 0o777, 0o700);
		assert.equal(statSync(resumable.dir).mode & 0o777, 0o700);
		assert.equal(statSync(resumable.filePath).mode & 0o777, 0o600);
		assert.deepEqual(SessionManager.open(resumable.filePath).buildSessionContext().messages, [user("inherited", 1)]);
	} finally {
		rmSync(temporaryRoot, { recursive: true, force: true });
	}
});

test("fork adoption clones the mutable child transcript into a new private run", async () => {
	const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-clone-test-"));
	try {
		const source = await writeResumableForkSession("/tmp/source", [user("inherited", 1)], undefined, path.join(temporaryRoot, "source"));
		SessionManager.open(source.filePath).appendMessage(user("child progress", 2));
		const cloned = await cloneResumableForkSession(source, path.join(temporaryRoot, "clone"));
		assert.notEqual(cloned.runId, source.runId);
		assert.notEqual(cloned.filePath, source.filePath);
		assert.equal(cloned.baselineEntryId, source.baselineEntryId);
		assert.deepEqual(
			SessionManager.open(cloned.filePath).buildSessionContext().messages,
			SessionManager.open(source.filePath).buildSessionContext().messages,
		);
		assert.equal(statSync(cloned.dir).mode & 0o777, 0o700);
		assert.equal(statSync(cloned.filePath).mode & 0o777, 0o600);
	} finally {
		rmSync(temporaryRoot, { recursive: true, force: true });
	}
});

test("failed session serialization removes its private temporary directory", async () => {
	const listTemporarySessions = () => new Set(
		readdirSync(os.tmpdir()).filter((name) => name.startsWith("pi-subagent-session-")),
	);
	const before = listTemporarySessions();
	const invalid = {
		...toolResult("read-2", 13),
		details: { unsupported: 1n },
	} as unknown as AgentMessage;
	await assert.rejects(
		writeTemporaryForkSession("/tmp/fork-child-cwd", [invalid], undefined),
		/BigInt|serialize/i,
	);
	assert.deepEqual(listTemporarySessions(), before);
});

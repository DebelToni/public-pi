import assert from "node:assert/strict";
import test from "node:test";
import { SubagentMonitorStore, type MonitorTranscriptEntry } from "./monitor.ts";

function queue(store = new SubagentMonitorStore(), task = "delegated exactly") {
	const runId = store.queueRun({
		orchestrationId: "orchestration",
		sessionId: "session",
		kind: "named",
		mode: "single",
		agent: "worker",
		task,
	});
	return { store, runId };
}

function transcript(store: SubagentMonitorStore, runId: string) {
	return store.getRun(runId)!.transcript;
}

function rows(entries: MonitorTranscriptEntry[]) {
	return entries.map((entry) => entry.type === "tool" ? `tool:${entry.toolId}` : `${entry.type}:${entry.text}`);
}

test("queue pins the exact task and metadata revises its labeled transcript row", () => {
	const { store, runId } = queue();
	const first = transcript(store, runId)[0]!;
	assert.deepEqual(first, {
		type: "prompt", id: first.id, revision: 1, text: "delegated exactly", label: "Initial task", pinned: true,
	});

	store.updateMetadata(runId, { task: "replacement task" });
	assert.deepEqual(transcript(store, runId)[0], {
		type: "prompt", id: first.id, revision: 2, text: "replacement task", label: "Initial task", pinned: true,
	});
	assert.equal(store.getRun(runId)!.task, "replacement task");
});

test("creation instructions, named task chronology, and recovery prompts have distinct labels", () => {
	const store = new SubagentMonitorStore();
	const runId = store.queueRun({
		orchestrationId: "named", sessionId: "session", kind: "named", mode: "single", agent: "worker",
		task: "third", creationInstructions: "Private template body", tasks: ["first", "second", "third"],
	});
	store.expectRecoveryPrompt(runId, "Continue saved work safely.");
	store.observeJsonEvent(runId, {
		type: "message_end", message: { role: "user", content: "Continue saved work safely." },
	});
	const prompts = transcript(store, runId).filter((entry): entry is Exclude<MonitorTranscriptEntry, { type: "tool" }> => entry.type === "prompt");
	assert.deepEqual(prompts.map((entry) => [entry.label, entry.text]), [
		["Creation instructions", "Private template body"],
		["Initial task", "first"],
		["Follow-up task 1", "second"],
		["Follow-up task 2", "third"],
		["Recovery prompt", "Continue saved work safely."],
	]);
	assert.equal(prompts.filter((entry) => entry.label === "Creation instructions").length, 1);
});

test("initial Task echo is suppressed while later invocation and steering prompts remain", () => {
	const { store, runId } = queue();
	store.observeJsonEvent(runId, {
		type: "message_end",
		message: { role: "user", content: [{ type: "text", text: "Task: delegated exactly" }] },
	});
	store.observeJsonEvent(runId, {
		type: "message_end",
		message: { role: "user", content: [{ type: "text", text: "Task: delegated exactly" }] },
	});
	store.observeJsonEvent(runId, {
		type: "message_end",
		message: { role: "user", content: "steer here" },
	});
	assert.deepEqual(rows(transcript(store, runId)), [
		"prompt:delegated exactly",
		"prompt:Task: delegated exactly",
		"prompt:steer here",
	]);
});

test("delta-only JSON updates retain source block order and message_end reconciles authoritatively", () => {
	const { store, runId } = queue();
	store.observeJsonEvent(runId, { type: "message_start", message: { role: "assistant", content: [] } });
	store.observeJsonEvent(runId, {
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", contentIndex: 2, delta: "draft" },
	});
	store.observeJsonEvent(runId, {
		type: "message_update",
		assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, id: "read-1", toolName: "read" },
	});
	store.observeJsonEvent(runId, {
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "visible thought" },
	});
	assert.deepEqual(rows(transcript(store, runId)), [
		"prompt:delegated exactly",
		"thinking:visible thought",
		"tool:read-1",
		"text:draft",
	]);
	assert.equal((transcript(store, runId)[1] as any).streaming, true);

	store.observeJsonEvent(runId, {
		type: "message_end",
		message: {
			role: "assistant",
			model: "model",
			content: [
				{ type: "thinking", thinking: "final thought", thinkingSignature: "secret" },
				{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "README.md" } },
				{ type: "text", text: "final answer", textSignature: "secret" },
			],
		},
	});
	const run = store.getRun(runId)!;
	assert.deepEqual(rows(run.transcript), [
		"prompt:delegated exactly",
		"thinking:final thought",
		"tool:read-1",
		"text:final answer",
	]);
	assert.equal(run.transcript.length, 4, "streamed blocks must be updated rather than duplicated");
	assert.equal(run.latestText, "final answer");
	assert.doesNotMatch(JSON.stringify(run), /thinkingSignature|textSignature|secret/);
	assert.equal(run.tools[0]!.argsComplete, true);
	assert.deepEqual(run.tools[0]!.args, { path: "README.md" });
});

test("serialized Pi tool-call updates preserve native identity and one transcript row", async () => {
	const codingAgentEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
	const serializerUrl = new URL("./modes/json-event.js", codingAgentEntry).href;
	const { toJsonEvent } = await import(serializerUrl) as { toJsonEvent(event: any): any };
	const wire = (event: any) => JSON.parse(JSON.stringify(toJsonEvent(event)));
	const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } };
	const toolCall = { type: "toolCall", id: "native-call-id", name: "bash", arguments: {} };
	const assistant = { role: "assistant", content: [{ type: "text", text: "before" }, toolCall], usage };
	const update = (assistantMessageEvent: any, message = assistant) => wire({
		type: "message_update",
		message,
		assistantMessageEvent,
	});
	const { store, runId } = queue();

	const start = update({ type: "toolcall_start", contentIndex: 1, partial: assistant });
	assert.equal(start.assistantMessageEvent.id, "native-call-id");
	assert.equal(start.assistantMessageEvent.toolName, "bash");
	assert.equal("partial" in start.assistantMessageEvent, false);
	assert.equal("message" in start, false);
	store.observeJsonEvent(runId, start);
	let run = store.getRun(runId)!;
	assert.deepEqual(run.tools.map(({ id, name }) => ({ id, name })), [{ id: "native-call-id", name: "bash" }]);
	assert.equal(run.transcript.filter((entry) => entry.type === "tool").length, 1);
	const transcriptId = run.transcript.find((entry) => entry.type === "tool")!.id;

	const partial = { ...assistant, content: [assistant.content[0], { ...toolCall, arguments: { command: "printf wire" } }] };
	store.observeJsonEvent(runId, update({
		type: "toolcall_delta",
		contentIndex: 1,
		delta: '{"command":"printf wire',
		partial,
	}, partial));
	run = store.getRun(runId)!;
	assert.deepEqual(run.tools.map(({ id, name }) => ({ id, name })), [{ id: "native-call-id", name: "bash" }]);
	assert.deepEqual(run.tools[0]!.args, { command: "printf wire" });
	assert.equal(run.tools[0]!.preview, "printf wire");
	assert.equal(run.transcript.filter((entry) => entry.type === "tool").length, 1);

	const finalToolCall = { ...toolCall, arguments: { command: "printf wire" } };
	const finalAssistant = { ...assistant, content: [assistant.content[0], finalToolCall, { type: "text", text: "after" }] };
	store.observeJsonEvent(runId, update({
		type: "toolcall_end",
		contentIndex: 1,
		toolCall: finalToolCall,
		partial: finalAssistant,
	}, finalAssistant));
	run = store.getRun(runId)!;
	assert.deepEqual(run.tools.map(({ id, name }) => ({ id, name })), [{ id: "native-call-id", name: "bash" }]);
	assert.equal(run.tools[0]!.argsComplete, true);
	assert.equal(run.transcript.filter((entry) => entry.type === "tool").length, 1);

	store.observeJsonEvent(runId, wire({ type: "message_end", message: finalAssistant }));
	run = store.getRun(runId)!;
	assert.deepEqual(run.tools.map(({ id, name }) => ({ id, name })), [{ id: "native-call-id", name: "bash" }]);
	assert.equal(run.transcript.filter((entry) => entry.type === "tool").length, 1);
	assert.equal(run.transcript.find((entry) => entry.type === "tool")!.id, transcriptId);
});

test("message_end alone creates all assistant blocks and redacts encrypted thinking", () => {
	const { store, runId } = queue();
	store.observeJsonEvent(runId, {
		type: "message_end",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "one" },
				{ type: "thinking", thinking: "opaque-payload", thinkingSignature: "ciphertext", redacted: true },
				{ type: "text", text: "two" },
			],
		},
	});
	assert.deepEqual(rows(transcript(store, runId)), [
		"prompt:delegated exactly",
		"text:one",
		"thinking:[redacted thinking]",
		"text:two",
	]);
	assert.equal(store.getRun(runId)!.latestText, "one\ntwo");
	assert.doesNotMatch(JSON.stringify(store.getRun(runId)), /opaque-payload|ciphertext/);
});

test("tool preparation, partial results, execution, and tool-result messages update one row in place", () => {
	let now = 10;
	const { store, runId } = queue(new SubagentMonitorStore(() => now));
	store.observeJsonEvent(runId, {
		type: "message_update",
		assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "bash-1", toolName: "bash" },
	});
	const entryId = (transcript(store, runId)[1] as any).id;
	store.observeJsonEvent(runId, {
		type: "message_update",
		assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '{"command":"printf streaming' },
	});
	assert.equal(store.getRun(runId)!.tools[0]!.preview, "printf streaming");
	store.observeJsonEvent(runId, {
		type: "message_update",
		assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '"}' },
	});
	store.observeJsonEvent(runId, {
		type: "message_update",
		assistantMessageEvent: {
			type: "toolcall_end",
			contentIndex: 0,
			toolCall: { id: "bash-1", name: "bash", arguments: { command: "printf ok" } },
		},
	});
	let tool = store.getRun(runId)!.tools[0]!;
	assert.equal(tool.preview, "printf ok");
	assert.equal(tool.argsComplete, true);
	assert.equal(tool.executionStarted, false);

	now = 20;
	store.observeJsonEvent(runId, { type: "tool_execution_start", toolCallId: "bash-1", toolName: "bash", args: { command: "printf ok" } });
	now = 25;
	store.observeJsonEvent(runId, {
		type: "tool_execution_update",
		toolCallId: "bash-1",
		toolName: "bash",
		args: { command: "printf ok" },
		partialResult: {
			content: [{ type: "text", text: "partial" }, { type: "image", data: "base64-secret", mimeType: "image/png" }],
			details: { progress: 1, image: { type: "image", data: "nested-secret", mimeType: "image/png" } },
		},
	});
	tool = store.getRun(runId)!.tools[0]!;
	assert.equal(tool.resultText, "partial\n[image omitted]");
	assert.deepEqual(tool.result?.details, { progress: 1, image: { type: "text", text: "[image omitted]" } });

	now = 30;
	store.observeJsonEvent(runId, {
		type: "tool_execution_end",
		toolCallId: "bash-1",
		toolName: "bash",
		isError: false,
		result: { content: [{ type: "text", text: "complete" }], details: { full: true } },
	});
	store.observeJsonEvent(runId, {
		type: "message_end",
		message: { role: "toolResult", toolCallId: "bash-1", toolName: "bash", isError: false, content: [{ type: "text", text: "authoritative" }], details: { final: true } },
	});
	const run = store.getRun(runId)!;
	tool = run.tools[0]!;
	assert.equal(tool.startedAt, 20);
	assert.equal(tool.endedAt, 30);
	assert.equal(tool.executionStarted, true);
	assert.equal(tool.resultText, "authoritative");
	assert.deepEqual(tool.result, { content: [{ type: "text", text: "authoritative" }], details: { final: true }, isError: false });
	assert.equal(run.transcript.filter((entry) => entry.type === "tool").length, 1);
	assert.equal((run.transcript[1] as any).id, entryId);
	assert.doesNotMatch(JSON.stringify(run), /base64-secret|nested-secret/);
});

test("redacted streamed thinking stays redacted through later deltas and its authoritative end", () => {
	const { store, runId } = queue();
	store.observeJsonEvent(runId, {
		type: "message_update",
		assistantMessageEvent: { type: "thinking_start", contentIndex: 0, redacted: true, content: "start-secret" },
	});
	assert.doesNotMatch(JSON.stringify(store.getRun(runId)), /start-secret/);
	store.observeJsonEvent(runId, {
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "delta-secret" },
	});
	assert.doesNotMatch(JSON.stringify(store.getRun(runId)), /start-secret|delta-secret/);
	store.observeJsonEvent(runId, {
		type: "message_update",
		assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "end-secret" },
	});
	assert.doesNotMatch(JSON.stringify(store.getRun(runId)), /start-secret|delta-secret|end-secret/);
	store.observeJsonEvent(runId, {
		type: "message_end",
		message: { role: "assistant", content: [{ type: "thinking", thinking: "authoritative-secret" }] },
	});
	assert.deepEqual(rows(transcript(store, runId)), ["prompt:delegated exactly", "thinking:[redacted thinking]"]);
	assert.doesNotMatch(JSON.stringify(store.getRun(runId)), /start-secret|delta-secret|end-secret|authoritative-secret/);
});

test("authoritative assistant content places an already executing tool at its source index", () => {
	const { store, runId } = queue();
	store.observeJsonEvent(runId, {
		type: "tool_execution_start",
		toolCallId: "read-early",
		toolName: "read",
		args: { path: "early.txt" },
	});
	store.observeJsonEvent(runId, {
		type: "message_end",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "before tool" },
				{ type: "toolCall", id: "read-early", name: "read", arguments: { path: "early.txt" } },
				{ type: "text", text: "after tool" },
			],
		},
	});
	assert.deepEqual(rows(transcript(store, runId)), [
		"prompt:delegated exactly",
		"text:before tool",
		"tool:read-early",
		"text:after tool",
	]);
	assert.equal(store.getRun(runId)!.tools.length, 1);
});

test("empty failed and truncated assistant messages append one public status while the run stays active", () => {
	const { store, runId } = queue();
	store.markStarting(runId);
	store.observeJsonEvent(runId, {
		type: "message_end",
		message: { role: "assistant", stopReason: "error", errorMessage: "provider temporarily unavailable", content: [] },
	});
	assert.equal(store.getRun(runId)!.phase, "starting");
	store.observeJsonEvent(runId, {
		type: "message_end",
		message: { role: "assistant", stopReason: "length", content: [] },
	});
	assert.deepEqual(rows(transcript(store, runId)), [
		"prompt:delegated exactly",
		"text:provider temporarily unavailable",
		"text:Response truncated: output length limit reached.",
	]);

	store.observeJsonEvent(runId, {
		type: "message_end",
		message: {
			role: "assistant",
			stopReason: "error",
			errorMessage: "already public",
			content: [{ type: "text", text: "Error: already public" }],
		},
	});
	assert.equal(rows(transcript(store, runId)).filter((row) => row.includes("already public")).length, 1);
});

test("legacy updates default a missing contentIndex to zero and stream state closes on a new message", () => {
	const { store, runId } = queue();
	store.observeJsonEvent(runId, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "legacy" } });
	assert.equal((transcript(store, runId)[1] as any).streaming, true);
	store.observeJsonEvent(runId, { type: "message_start", message: { role: "assistant", content: [] } });
	assert.equal((transcript(store, runId)[1] as any).streaming, undefined);
	store.observeJsonEvent(runId, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "second" } });
	assert.equal(store.getRun(runId)!.latestText, "legacy\nsecond");
});

test("retention pins creation instructions and every numbered task while bounding live history", () => {
	const store = new SubagentMonitorStore();
	const runId = store.queueRun({
		orchestrationId: "orchestration", sessionId: "session", kind: "named", mode: "single", agent: "worker",
		task: "third", creationInstructions: "instructions", tasks: ["first", "second", "third"],
	});
	for (let index = 0; index < 100; index++) {
		store.observeJsonEvent(runId, {
			type: "tool_execution_start",
			toolCallId: `tool-${index}`,
			toolName: "read",
			args: { path: `${index}.txt` },
		});
	}
	let run = store.getRun(runId)!;
	assert.equal(run.tools.length, 80);
	assert.deepEqual(
		run.transcript.slice(0, 4).map((entry) => entry.type === "tool" ? [] : [entry.label, entry.text, entry.pinned]),
		[
			["Creation instructions", "instructions", true],
			["Initial task", "first", true],
			["Follow-up task 1", "second", true],
			["Follow-up task 2", "third", true],
		],
	);
	assert.equal(run.omittedEntries, 20);

	for (let index = 0; index < 220; index++) {
		store.observeJsonEvent(runId, {
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: `message-${index}` }] },
		});
	}
	run = store.getRun(runId)!;
	assert.ok(run.transcript.length <= 244);
	assert.ok(run.tools.length <= 80);
	assert.deepEqual(run.transcript.slice(0, 4).map((entry) => entry.type === "tool" ? undefined : entry.label), [
		"Creation instructions", "Initial task", "Follow-up task 1", "Follow-up task 2",
	]);
	assert.ok(run.omittedEntries > 20);
	const before = { tools: run.tools.length, transcript: run.transcript.length, omitted: run.omittedEntries };
	store.observeJsonEvent(runId, {
		type: "message_end",
		message: { role: "toolResult", toolCallId: "tool-0", toolName: "read", isError: false, content: [{ type: "text", text: "late stale result" }] },
	});
	run = store.getRun(runId)!;
	assert.deepEqual({ tools: run.tools.length, transcript: run.transcript.length, omitted: run.omittedEntries }, before);
	assert.doesNotMatch(JSON.stringify(run), /late stale result/);
});

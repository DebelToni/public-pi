import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "bun:test";
import { installAgentTimeTelemetry } from "./index.js";

type Handler = (event: any, context: ExtensionContext) => unknown;

function harness() {
	const handlers = new Map<string, Handler[]>();
	const records: any[] = [];
	let closed = 0;
	let now = 1_000;
	const pi = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	} as unknown as ExtensionAPI;
	const context = {
		cwd: "/tmp/project",
		sessionManager: {
			getSessionId: () => "session-1",
			getSessionFile: () => "/tmp/session.jsonl",
		},
		ui: { notify() {} },
	} as unknown as ExtensionContext;
	installAgentTimeTelemetry(pi, {
		now: () => now++,
		monotonic: () => now * 2,
		randomId: () => `id-${now}`,
		createWriter: () => ({
			processId: "process-1",
			write: (record) => records.push(record),
			close: () => { closed++; },
		}),
	});
	const emit = async (event: string, value: any = {}) => {
		for (const handler of handlers.get(event) ?? []) await handler(value, context);
	};
	return { records, emit, get closed() { return closed; } };
}

describe("agent-time telemetry", () => {
	test("records timing metadata without prompt, output, or tool arguments", async () => {
		const h = harness();
		await h.emit("session_start");
		await h.emit("before_agent_start", { prompt: "private prompt" });
		await h.emit("agent_start");
		await h.emit("turn_start", { turnIndex: 0 });
		await h.emit("before_provider_request", { payload: { private: "payload" } });
		await h.emit("after_provider_response", { status: 200, headers: { private: "header" } });
		const assistant = {
			role: "assistant",
			content: [{ type: "text", text: "private answer" }],
			timestamp: 900,
			provider: "codex-pi1",
			model: "gpt-5.6-sol",
			api: "openai-codex-responses",
			stopReason: "toolUse",
			responseId: "response-1",
			usage: { input: 10, output: 2, cacheRead: 8, cacheWrite: 0, totalTokens: 20, cost: { total: 0.1 } },
		};
		await h.emit("message_start", { message: assistant });
		await h.emit("message_update", {
			message: assistant,
			assistantMessageEvent: { type: "text_delta", delta: "private delta" },
		});
		await h.emit("message_update", {
			message: assistant,
			assistantMessageEvent: { type: "text_delta", delta: "second private delta" },
		});
		await h.emit("message_end", { message: assistant });
		await h.emit("tool_execution_start", { toolCallId: "call-1", toolName: "bash", args: { command: "private" } });
		await h.emit("tool_execution_end", { toolCallId: "call-1", toolName: "bash", isError: false, result: { private: true } });
		await h.emit("turn_end", { message: assistant });
		await h.emit("agent_end");
		await h.emit("agent_settled");
		await h.emit("session_shutdown");

		expect(h.closed).toBe(1);
		const activityStart = h.records.find((record) => record.type === "activity_start");
		const activityEnd = h.records.find((record) => record.type === "activity_end");
		expect(activityStart.activityId).toBe(activityEnd.activityId);
		expect(h.records.filter((record) => record.type === "assistant_first_meaningful_update")).toHaveLength(1);
		expect(h.records.find((record) => record.type === "assistant_message_end")).toMatchObject({
			responseId: "response-1",
			stopReason: "toolUse",
			usage: { input: 10, output: 2, cacheRead: 8, cost: 0.1 },
		});
		expect(h.records.find((record) => record.type === "tool_execution_start")).toMatchObject({
			toolCallId: "call-1",
			toolName: "bash",
		});
		const serialized = JSON.stringify(h.records);
		for (const secret of ["private prompt", "private answer", "private delta", "private header", "private"]) {
			expect(serialized).not.toContain(secret);
		}
	});

	test("records compaction and tree intervals with stable operation IDs", async () => {
		const h = harness();
		await h.emit("session_start");
		await h.emit("session_before_compact", { reason: "manual" });
		await h.emit("session_compact", { reason: "manual" });
		await h.emit("session_before_tree");
		await h.emit("session_tree");
		const start = h.records.find((record) => record.type === "compaction_start");
		const end = h.records.find((record) => record.type === "compaction_end");
		expect(start.compactionId).toBe(end.compactionId);
		const treeStart = h.records.find((record) => record.type === "tree_navigation_start");
		const treeEnd = h.records.find((record) => record.type === "tree_navigation_end");
		expect(treeStart.treeId).toBe(treeEnd.treeId);
	});
});

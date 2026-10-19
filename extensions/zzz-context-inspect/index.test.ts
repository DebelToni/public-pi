import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createContextInspector, tmuxOpenArgs, writeInspection } from "./index.ts";

function fixture() {
	const entries: any[] = [
		{ type: "model_change", id: "model001", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", provider: "test", modelId: "model" },
		{ type: "message", id: "user0001", parentId: "model001", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "Find the exact context" }], timestamp: 1 } },
		{ type: "message", id: "asst0001", parentId: "user0001", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "Inspect the prompt chain" }, { type: "toolCall", id: "call-1", name: "read", arguments: { path: "/tmp/example" } }, { type: "text", text: "Reading it now." }], provider: "test", model: "model", api: "test-api", stopReason: "toolUse", timestamp: 2 } },
		{ type: "message", id: "tool0001", parentId: "asst0001", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "complete tool output" }], details: { privateRendererState: "x".repeat(25_000) }, isError: false, timestamp: 3 } },
		{ type: "custom", id: "custom01", parentId: "tool0001", timestamp: "2026-01-01T00:00:04.000Z", customType: "test-state", data: { count: 1 } },
	];
	const branch = entries;
	const contextEntries = entries.slice(0, 4);
	const sessionManager = {
		getSessionId: () => "session-test",
		getSessionFile: () => "/tmp/source-session.jsonl",
		getLeafId: () => "custom01",
		getHeader: () => ({ type: "session", version: 3, id: "session-test", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp/project" }),
		getEntries: () => entries,
		getBranch: () => branch,
		buildContextEntries: () => contextEntries,
	};
	const context: any = {
		cwd: "/tmp/project",
		mode: "tui",
		model: { provider: "test", id: "model", api: "test-api" },
		thinkingLevel: "high",
		sessionManager,
		getSystemPrompt: () => "BASE SYSTEM PROMPT",
		getSystemPromptOptions: () => ({
			cwd: "/tmp/project",
			selectedTools: ["read"],
			toolSnippets: { read: "Read files" },
			promptGuidelines: ["Use read"],
			contextFiles: [{ path: "/tmp/AGENTS.md", content: "secret context content" }],
			skills: [{ name: "test-skill", filePath: "/tmp/SKILL.md", description: "Test" }],
		}),
	};
	return { context, entries };
}

test("writes searchable context, thinking, tools, tags, and exact provider snapshot", async () => {
	const root = mkdtempSync(join(tmpdir(), "context-inspect-"));
	const handlers = new Map<string, (...args: any[]) => any>();
	const extension = createContextInspector({ root });
	extension({
		on(name: string, handler: (...args: any[]) => any) {
			handlers.set(name, handler);
		},
		registerCommand() {},
	} as any);
	const { context } = fixture();

	try {
		await handlers.get("before_agent_start")?.({ systemPrompt: "FINAL SYSTEM PROMPT" }, context);
		await handlers.get("context")?.({ messages: [{ role: "user", content: "provider-visible" }] }, context);
		await handlers.get("before_provider_request")?.({ payload: { model: "model", instructions: "FINAL SYSTEM PROMPT", input: [{ role: "user", content: "provider-visible" }], tools: [{ name: "read" }] } }, context);

		const result = await writeInspection(context, { root });
		const markdown = readFileSync(result.markdownPath, "utf8");
		const exact = readFileSync(join(result.outputDir, "provider-request.json"), "utf8");

		assert.equal(result.capturePresent, true);
		assert.match(markdown, /FINAL SYSTEM PROMPT/);
		assert.match(markdown, /Thinking trace[\s\S]*Inspect the prompt chain/);
		assert.match(markdown, /Tool call: read[\s\S]*\/tmp\/example/);
		assert.match(markdown, /complete tool output/);
		assert.match(markdown, /`active-branch` `model-context`/);
		assert.match(markdown, /Custom entries are persisted extension state and are not sent to the model/);
		assert.doesNotMatch(markdown, /secret context content/);
		assert.match(markdown, /characters omitted from readable preview/);
		assert.match(exact, /provider-visible/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("falls back cleanly before the first captured provider request", async () => {
	const root = mkdtempSync(join(tmpdir(), "context-inspect-no-capture-"));
	const { context } = fixture();
	try {
		const result = await writeInspection(context, { root });
		const markdown = readFileSync(result.markdownPath, "utf8");
		assert.equal(result.capturePresent, false);
		assert.match(markdown, /No provider request has been captured/);
		assert.match(markdown, /BASE SYSTEM PROMPT/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("tmux opens read-only Neovim in a new named window", () => {
	assert.deepEqual(tmuxOpenArgs("/tmp/context.md", "/tmp/project"), [
		"new-window", "-n", "context-inspect", "-c", "/tmp/project", "nvim", "-R", "/tmp/context.md",
	]);
});

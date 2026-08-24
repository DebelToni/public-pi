import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClassification } from "./classifier.js";
import { jumpToPane } from "./index.js";
import { discoverTmuxAgents, type AgentInboxItem, type TmuxAgentPane } from "./snapshot.js";
import { provisionalClassification, readPaneContext } from "./transcript.js";
import { AgentsInboxComponent } from "./ui.js";

function message(id: string, parentId: string | null, value: any) {
	return JSON.stringify({ type: "message", id, parentId, timestamp: new Date().toISOString(), message: value });
}

function assistant(content: any[], stopReason: string) {
	return { role: "assistant", content, stopReason, timestamp: Date.now(), provider: "codex-pro", model: "gpt-5.6-sol" };
}

function pane(overrides: Partial<TmuxAgentPane> = {}): TmuxAgentPane {
	return {
		tmuxSessionId: "$2",
		tmuxSessionName: "AI",
		windowId: "@4",
		windowIndex: 3,
		paneId: "%7",
		paneIndex: 0,
		panePid: 100,
		piPid: 101,
		processState: "S+",
		cwd: "/tmp/project",
		title: "Project",
		sessionId: "12345678-1234-1234-1234-123456789abc",
		telemetryFile: "/tmp/telemetry.jsonl",
		runtime: { running: false, lastEvent: "activity_end" },
		...overrides,
	};
}

function item(category: AgentInboxItem["category"], paneId: string, windowIndex: number): AgentInboxItem {
	return {
		...pane({ paneId, windowId: `@${windowIndex}`, windowIndex, title: `Task ${windowIndex}` }),
		context: {
			previousAssistant: "previous",
			lastPrompt: "do task",
			tools: "none",
			current: "done",
			hasFinalOutput: true,
			unmatchedToolCall: false,
			lastToolError: false,
		},
		category,
		status: `task ${windowIndex}`,
		pending: false,
		fingerprint: paneId,
	};
}

describe("agents inbox", () => {
	test("discovers a top-level Pi process and maps telemetry to its session", () => {
		const root = mkdtempSync(join(tmpdir(), "agents-inbox-"));
		const agentDir = join(root, "agent");
		const sessionId = "12345678-1234-1234-1234-123456789abc";
		const telemetry = join(agentDir, "agent-time-telemetry", sessionId, "run.jsonl");
		const session = join(agentDir, "sessions", "--tmp-project--", `now_${sessionId}.jsonl`);
		mkdirSync(join(agentDir, "agent-time-telemetry", sessionId), { recursive: true });
		mkdirSync(join(agentDir, "sessions", "--tmp-project--"), { recursive: true });
		writeFileSync(telemetry, [
			JSON.stringify({ type: "telemetry_header", sessionId, processKind: "topLevel" }),
			JSON.stringify({ type: "activity_start", atMs: 10 }),
			JSON.stringify({ type: "tool_execution_start", toolCallId: "call", toolName: "bash", atMs: 20, runId: "run" }),
		].join("\n") + "\n");
		writeFileSync(session, "");
		const run = (command: string) => {
			if (command === "tmux") return "$2\tAI\t@4\t3\t%7\t0\t100\tnode\t/tmp/project\t● Project\t0\n";
			if (command === "ps") return " 100 1 Ss -zsh\n 101 100 S+ pi\n";
			if (command === "lsof") return `p101\nn${telemetry}\n`;
			if (command === "find") return `${session}\n`;
			throw new Error(command);
		};
		const found = discoverTmuxAgents({ run: run as any, agentDir });
		expect(found).toHaveLength(1);
		expect(found[0]).toMatchObject({ paneId: "%7", piPid: 101, sessionId, sessionFile: session, title: "Project" });
		expect(found[0].runtime.running).toBe(true);
		expect(found[0].runtime.activeTool?.name).toBe("bash");
	});

	test("keeps a directly-run Pi pane visible when telemetry is unavailable", () => {
		const root = mkdtempSync(join(tmpdir(), "agents-unmapped-"));
		const agentDir = join(root, "agent");
		mkdirSync(join(agentDir, "sessions"), { recursive: true });
		const run = (command: string) => {
			if (command === "tmux") return "$9\tDirect\t@9\t1\t%9\t0\t200\tpi\t/tmp/direct\tpi\t0\n";
			if (command === "ps") return " 200 1 S+ pi\n";
			if (command === "lsof") return "p200\n";
			if (command === "find") throw new Error("sessions directory missing");
			throw new Error(command);
		};
		const found = discoverTmuxAgents({ run: run as any, agentDir });
		expect(found).toHaveLength(1);
		expect(found[0]).toMatchObject({ paneId: "%9", piPid: 200, sessionFile: undefined, telemetryFile: undefined });
		expect(found[0].runtime.lastEvent).toBe("telemetry unavailable");
	});

	test("extracts precisely the requested turn context from the active branch", () => {
		const root = mkdtempSync(join(tmpdir(), "agents-context-"));
		const path = join(root, "session.jsonl");
		const lines = [
			JSON.stringify({ type: "session", version: 3, id: "session", cwd: root }),
			message("a", null, assistant([{ type: "text", text: "Earlier answer" }], "stop")),
			JSON.stringify({ type: "custom", customType: "state", data: { id: "nested-id-must-not-win" }, id: "x", parentId: "a", timestamp: new Date().toISOString() }),
			message("b", "x", { role: "user", content: "Fix the failing build", timestamp: Date.now() }),
			message("c", "b", assistant([{ type: "toolCall", id: "call", name: "bash", arguments: { command: "npm test", timeout: 3 } }], "toolUse")),
			message("d", "c", { role: "toolResult", toolCallId: "call", toolName: "bash", content: [{ type: "text", text: "42 tests passed" }], isError: false, timestamp: Date.now() }),
			message("e", "d", assistant([{ type: "text", text: "Build fixed and tests pass." }], "stop")),
		];
		writeFileSync(path, lines.join("\n") + "\n");
		const context = readPaneContext(pane({ sessionFile: path }));
		expect(context.previousAssistant).toBe("Earlier answer");
		expect(context.lastPrompt).toBe("Fix the failing build");
		expect(context.tools).toContain("npm test");
		expect(context.tools).toContain("42 tests passed");
		expect(context.current).toBe("Build fixed and tests pass.");
		expect(context.finalStopReason).toBe("stop");
	});

	test("skips multi-megabyte duplicated details while walking the active branch", () => {
		const root = mkdtempSync(join(tmpdir(), "agents-huge-context-"));
		const path = join(root, "session.jsonl");
		const repeated = "x".repeat(1_200_000);
		const childMessages = [
			assistant([{ type: "toolCall", id: "old", name: "exa_search", arguments: { query: "old search" } }], "toolUse"),
			{ role: "toolResult", toolCallId: "old", toolName: "exa_search", content: [{ type: "text", text: repeated }], isError: false },
			assistant([{ type: "toolCall", id: "read", name: "read", arguments: { path: "checkpoint.md" } }], "toolUse"),
			{ role: "toolResult", toolCallId: "read", toolName: "read", content: [{ type: "text", text: "contents" }], isError: false },
			assistant([{ type: "toolCall", id: "bash", name: "bash", arguments: { command: "test -f checkpoint.bin" } }], "toolUse"),
			{ role: "toolResult", toolCallId: "bash", toolName: "bash", content: [{ type: "text", text: "missing" }], isError: true },
			assistant([{ type: "toolCall", id: "write", name: "write", arguments: { path: "report.md" } }], "toolUse"),
			{ role: "toolResult", toolCallId: "write", toolName: "write", content: [{ type: "text", text: "saved" }], isError: false },
		];
		const details = { results: [{ agent: "researcher", status: "completed", messages: childMessages }], logs: repeated };
		const lines = [
			JSON.stringify({ type: "session", version: 3, id: "session", cwd: root }),
			message("a", null, assistant([{ type: "text", text: "Earlier answer" }], "stop")),
			message("b", "a", { role: "user", content: "Investigate the checkpoint", timestamp: Date.now() }),
			message("c", "b", assistant([{ type: "toolCall", id: "call", name: "subagent", arguments: { task: "research" } }], "toolUse")),
			message("d", "c", { role: "toolResult", toolCallId: "call", toolName: "subagent", content: [{ type: "text", text: "Research complete" }], details, isError: false, timestamp: Date.now() }),
			JSON.stringify({ type: "custom", customType: "subagent-continuation", data: { details, id: "nested-id" }, id: "x", parentId: "d", timestamp: new Date().toISOString() }),
		];
		let parent = "x";
		for (let index = 0; index < 30; index++) {
			const callId = `later-call-${index}`;
			const assistantId = `later-assistant-${index}`;
			const resultId = `later-result-${index}`;
			lines.push(message(assistantId, parent, assistant([{ type: "toolCall", id: callId, name: "read", arguments: { path: `later-${index}.md` } }], "toolUse")));
			lines.push(message(resultId, assistantId, { role: "toolResult", toolCallId: callId, toolName: "read", content: [{ type: "text", text: "ok" }], isError: false, timestamp: Date.now() }));
			parent = resultId;
		}
		lines.push(message("e", parent, assistant([{ type: "text", text: "Checkpoint options found." }], "stop")));
		writeFileSync(path, lines.join("\n") + "\n");
		const context = readPaneContext(pane({ sessionFile: path }));
		expect(context.contextUnavailable).toBeFalsy();
		expect(context.lastPrompt).toBe("Investigate the checkpoint");
		expect(context.tools).toContain("subagent ran; child history omitted");
		expect(context.tools).toContain("read(");
		expect(context.tools).toContain("bash(");
		expect(context.tools).toContain("write(");
		expect(context.tools).not.toContain("exa_search(");
		expect(context.tools).not.toContain(repeated.slice(0, 1000));
		expect(context.current).toBe("Checkpoint options found.");
		expect(context.hasFinalOutput).toBe(true);
	});

	test("forbids ready when a turn ends with a tool result instead of a final answer", () => {
		const root = mkdtempSync(join(tmpdir(), "agents-missing-final-"));
		const path = join(root, "session.jsonl");
		writeFileSync(path, [
			message("a", null, { role: "user", content: "Inspect it", timestamp: Date.now() }),
			message("b", "a", assistant([{ type: "toolCall", id: "call", name: "read", arguments: { path: "file.md" } }], "toolUse")),
			message("c", "b", { role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "contents" }], isError: false, timestamp: Date.now() }),
		].join("\n") + "\n");
		const agentPane = pane({ sessionFile: path, runtime: { running: false, lastEvent: "activity_end" } });
		const context = readPaneContext(agentPane);
		expect(context.hasFinalOutput).toBe(false);
		expect(provisionalClassification(agentPane, context)).toEqual({ category: "attention", status: "final response missing" });
	});

	test("marks an over-time active command as needing attention", () => {
		const context = {
			previousAssistant: "",
			lastPrompt: "run it",
			tools: "bash",
			current: "bash",
			hasFinalOutput: false,
			lastToolTimeoutMs: 1000,
			unmatchedToolCall: true,
			lastToolError: false,
		};
		const result = provisionalClassification(pane({ sessionFile: "/tmp/session.jsonl", runtime: { running: true, activeTool: { id: "call", name: "bash", startedAt: 1000 } } }), context, 8000);
		expect(result).toEqual({ category: "attention", status: "command exceeded its timeout" });
	});

	test("parses consistent Luna JSON and rejects ordinary work labeled attention", () => {
		expect(parseClassification('```json\n{"category":"needs attention","basis":"waiting","status":"Waiting for database choice, please."}\n```'))
			.toEqual({ category: "attention", basis: "waiting", status: "waiting for database choice please" });
		expect(parseClassification('{"category":"attention","basis":"stuck","status":"subagents auditing repository files"}'))
			.toBeUndefined();
		expect(parseClassification('{"category":"attention","basis":"stuck","status":"subagent read appears stuck"}'))
			.toEqual({ category: "attention", basis: "stuck", status: "subagent read appears stuck" });
	});

	test("navigates categories with h/l, rows with j/k, and selects with enter", () => {
		const items = [item("working", "%1", 1), item("ready", "%2", 2), item("ready", "%3", 3)];
		let selected: AgentInboxItem | undefined;
		const tui = { requestRender() {} };
		const identity = (text: string) => text;
		const theme = { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text, bold: identity } as any;
		const component = new AgentsInboxComponent(tui, theme, items, (value) => { selected = value; });
		component.handleInput("l");
		component.handleInput("j");
		component.handleInput("\r");
		expect(selected?.paneId).toBe("%3");
	});

	test("renders full-width category sections and wraps complete statuses", () => {
		const agents = [item("working", "%1", 1), item("ready", "%2", 2), item("attention", "%3", 3)];
		agents[0].status = "reviewing the complete integration test failure before editing";
		const identity = (text: string) => text;
		const theme = { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text, bold: identity } as any;
		const rendered = new AgentsInboxComponent({ requestRender() {}, terminal: { rows: 24 } }, theme, agents, () => {}).render(50);
		const text = rendered.join("\n");
		expect(text.indexOf("WORKING")).toBeLessThan(text.indexOf("READY"));
		expect(text.indexOf("READY")).toBeLessThan(text.indexOf("NEEDS ATTENTION"));
		for (const word of agents[0].status.split(" ")) expect(text).toContain(word);
		expect(rendered).toHaveLength(24);
	});

	test("strips terminal control sequences from rendered pane data", () => {
		const unsafe = item("ready", "%8", 8);
		unsafe.title = "\u001b]2;owned\u0007title";
		unsafe.status = "\u001b[31mred\u001b[0m";
		const identity = (text: string) => text;
		const theme = { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text, bold: identity } as any;
		const rendered = new AgentsInboxComponent({ requestRender() {} }, theme, [unsafe], () => {}).render(150).join("\n");
		expect(rendered).not.toContain("\u001b");
		expect(rendered).toContain("title");
		expect(rendered).toContain("red");
	});

	test("jumps using exact window, pane, and session ids", () => {
		const calls: string[][] = [];
		jumpToPane(item("ready", "%7", 4), (args) => calls.push(args));
		expect(calls).toEqual([
			["select-window", "-t", "$2:@4"],
			["select-pane", "-t", "%7"],
			["switch-client", "-t", "$2"],
		]);
	});
});

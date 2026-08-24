import { SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	insertionArguments,
	parseTmuxWindow,
	parseTmuxWindowIds,
	piLaunchCommand,
	prepareForkSession,
	shellQuote,
} from "./fork-tmux.js";
import { installForkTmux } from "./index.js";

describe("fork-tmux helpers", () => {
	test("quotes arbitrary prompt text as one shell argument", () => {
		const value = "don't expand $HOME; `false`\nsecond line";
		const result = Bun.spawnSync(["/bin/sh", "-c", `printf %s ${shellQuote(value)}`]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toBe(value);
		const command = piLaunchCommand("/tmp/pi path", "/tmp/session's.jsonl", "/tmp/private prompt.md");
		expect(command).not.toContain(value);
		expect(command).not.toContain(" -- ");
		expect(command).toContain("PI_SKIP_LOCAL_PATCH_CHECK=1 '/tmp/pi path' --session '/tmp/session'\"'\"'s.jsonl' --fork-tmux-prompt-file '/tmp/private prompt.md'");
	});

	test("builds an atomic insertion immediately after the stable current window", () => {
		const args = insertionArguments(
			{ sessionId: "$7", windowId: "@12", windowIndex: 3 },
			"/tmp/project path",
			"exec pi",
		);
		expect(args).toEqual([
			"new-window", "-a", "-t", "$7:@12", "-c", "/tmp/project path",
			"-n", "fork", "-P", "-F", "#{session_id}|#{window_id}|#{window_index}", "exec pi",
		]);
		expect(args).not.toContain("-d");
		expect(parseTmuxWindow("$7|@14|4\n")).toEqual({ sessionId: "$7", windowId: "@14", windowIndex: 4 });
		expect(parseTmuxWindowIds("@12\n@14\n")).toEqual(new Set(["@12", "@14"]));
	});

	test("copies through a separately opened manager instead of mutating the live manager", () => {
		const source = {
			getSessionFile: () => "/tmp/source.jsonl",
			getSessionDir: () => "/tmp/sessions",
			getLeafId: () => "leaf1234",
			getCwd: () => "/tmp/project",
		};
		let opened: unknown;
		const result = prepareForkSession(
			source,
			(path, sessionDir) => {
				opened = { path, sessionDir };
				return { createBranchedSession: (leafId) => leafId === "leaf1234" ? "/tmp/fork.jsonl" : undefined };
			},
			(path) => path === "/tmp/source.jsonl" || path === "/tmp/fork.jsonl",
		);
		expect(opened).toEqual({ path: "/tmp/source.jsonl", sessionDir: "/tmp/sessions" });
		expect(result).toEqual({ forkFile: "/tmp/fork.jsonl", cwd: "/tmp/project" });
	});

	test("leaves the persisted source JSONL and live manager unchanged", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-fork-tmux-test-"));
		try {
			const source = SessionManager.create(root, root);
			source.appendMessage({ role: "user", content: "original prompt", timestamp: Date.now() });
			source.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "original answer" }],
				api: "openai-codex-responses",
				provider: "codex-pi1",
				model: "gpt-5.6-sol",
				stopReason: "stop",
				timestamp: Date.now(),
				usage: {
					input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			});
			const sourceFile = source.getSessionFile();
			if (!sourceFile) throw new Error("test source was not persisted");
			const sourceId = source.getSessionId();
			const before = readFileSync(sourceFile, "utf8");
			const fork = prepareForkSession(source, (path, dir) => SessionManager.open(path, dir), existsSync);
			expect(readFileSync(sourceFile, "utf8")).toBe(before);
			expect(source.getSessionFile()).toBe(sourceFile);
			expect(source.getSessionId()).toBe(sourceId);
			expect(fork.forkFile).not.toBe(sourceFile);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

function commandHarness(failLaunch = false) {
	let command: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> } | undefined;
	const pi = {
		on() {},
		registerFlag() {},
		getFlag() { return undefined; },
		sendUserMessage() {},
		registerCommand(name: string, value: typeof command) {
			expect(name).toBe("fork-tmux");
			command = value;
		},
	} as unknown as ExtensionAPI;
	const tmuxCalls: string[][] = [];
	const removed: string[] = [];
	const notices: Array<{ message: string; level: string }> = [];
	let waited = 0;
	const sessionManager = {
		getSessionFile: () => "/tmp/source.jsonl",
		getSessionDir: () => "/tmp/sessions",
		getLeafId: () => "leaf1234",
		getCwd: () => "/tmp/project",
	};
	const context = {
		mode: "tui",
		sessionManager,
		waitForIdle: async () => { waited++; },
		ui: { notify: (message: string, level: string) => notices.push({ message, level }) },
	} as unknown as ExtensionCommandContext;

	installForkTmux(pi, {
		tmuxPane: () => "%9",
		piPath: "/tmp/pi path",
		fileExists: (path) => path === "/tmp/source.jsonl" || path === "/tmp/fork.jsonl" || path === "/tmp/pi path",
		openSession: (path, sessionDir) => {
			expect({ path, sessionDir }).toEqual({ path: "/tmp/source.jsonl", sessionDir: "/tmp/sessions" });
			return { createBranchedSession: (leafId) => leafId === "leaf1234" ? "/tmp/fork.jsonl" : undefined };
		},
		removeFile: (path) => { removed.push(path); },
		createPromptFile: (prompt) => {
			expect(prompt).toBe(failLaunch ? "new direction" : "compare 'both' approaches");
			return "/tmp/private-prompt.md";
		},
		schedulePromptCleanup: (path) => { expect(path).toBe("/tmp/private-prompt.md"); },
		runTmux: (args) => {
			tmuxCalls.push(args);
			if (args[0] === "display-message") return "$2|@8|5";
			if (args[0] === "list-windows") return "@8\n@9";
			if (failLaunch) throw new Error("fake tmux failure");
			return "$2|@10|6";
		},
	});
	if (!command) throw new Error("command was not registered");
	return { command, context, tmuxCalls, removed, notices, waited: () => waited };
}

describe("/fork-tmux", () => {
	test("forks the exact branch into the next selected tmux window", async () => {
		const harness = commandHarness();
		await harness.command.handler("compare 'both' approaches", harness.context);
		expect(harness.waited()).toBe(1);
		expect(harness.tmuxCalls).toHaveLength(3);
		expect(harness.tmuxCalls[2].slice(0, 6)).toEqual(["new-window", "-a", "-t", "$2:@8", "-c", "/tmp/project"]);
		const command = harness.tmuxCalls[2].at(-1) ?? "";
		expect(command).toContain("'/tmp/pi path' --session '/tmp/fork.jsonl' --fork-tmux-prompt-file '/tmp/private-prompt.md'");
		expect(command).not.toContain("compare 'both' approaches");
		expect(harness.removed).toEqual([]);
		expect(harness.notices).toEqual([]);
	});

	test("removes only the unused fork file when tmux definitively fails", async () => {
		const harness = commandHarness(true);
		await harness.command.handler("new direction", harness.context);
		expect(harness.removed).toEqual(["/tmp/fork.jsonl", "/tmp/private-prompt.md"]);
		expect(harness.notices.at(-1)).toEqual({
			message: "Could not create the forked tmux window: fake tmux failure",
			level: "error",
		});
	});

	test("the child submits exact prompt text and deletes it only after durable user-message ingestion", async () => {
		const handlers = new Map<string, Array<(event: any, ctx: any) => void>>();
		const sent: string[] = [];
		const removed: string[] = [];
		const promptFile = "/tmp/pi-fork-tmux-123-12345678-1234-1234-1234-123456789abc.md";
		const pi = {
			registerFlag() {},
			getFlag: () => promptFile,
			on(event: string, handler: (event: any, ctx: any) => void) {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			},
			registerCommand() {},
			sendUserMessage: (prompt: string) => { sent.push(prompt); },
		} as unknown as ExtensionAPI;
		installForkTmux(pi, {
			fileExists: (path) => path === promptFile,
			isPromptFile: (path) => path === promptFile,
			readPromptFile: () => "- exact @message with 'quotes'",
			removeFile: (path) => { removed.push(path); },
		});
		const context = { ui: { notify() {} } };
		for (const handler of handlers.get("session_start") ?? []) handler({}, context);
		await Bun.sleep(5);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toEndWith("- exact @message with 'quotes'");
		expect(sent[0]).not.toBe("- exact @message with 'quotes'");
		expect(removed).toEqual([]);
		let transformed: unknown;
		for (const handler of handlers.get("input") ?? []) {
			transformed = handler({ source: "extension", text: sent[0] }, context) ?? transformed;
		}
		expect(transformed).toEqual({ action: "transform", text: "- exact @message with 'quotes'" });
		for (const handler of handlers.get("message_end") ?? []) {
			handler({ message: { role: "user", content: [{ type: "text", text: "- exact @message with 'quotes'" }] } }, context);
		}
		expect(removed).toEqual([promptFile]);
	});
});

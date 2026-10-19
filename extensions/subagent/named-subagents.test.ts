import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "./agents.ts";
import { registerNamedSubagentTools } from "./named-subagents.ts";
import { getPiInvocation, runSingleAgent, sizedModel, subagentEnvironment, type SingleResult } from "./index.ts";
import { SubagentMonitorStore } from "./monitor.ts";

type Tool = { execute: (...args: any[]) => Promise<any> };

function assistant(text: string): any {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-codex-responses",
		provider: "codex-pi7",
		model: "gpt-6-luna",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function harness(runSingleAgent: (...args: any[]) => Promise<SingleResult>, monitor?: SubagentMonitorStore) {
	const tools = new Map<string, Tool>();
	const pi = {
		registerTool(tool: Tool & { name: string }) { tools.set(tool.name, tool); },
		appendEntry() {},
	} as unknown as ExtensionAPI;
	registerNamedSubagentTools(pi, { runSingleAgent: runSingleAgent as any, sizedModel, monitor });
	return tools;
}

function context(project: string, sessionId: string, toolCallId: string) {
	const sessionFile = join(project, "parent.jsonl");
	writeFileSync(sessionFile, "");
	const messages: AgentMessage[] = [
		{ role: "user", content: [{ type: "text", text: "parent context" }], timestamp: 1 },
		{
			role: "assistant",
			content: [{ type: "toolCall", id: toolCallId, name: "create_subagent", arguments: {} }],
			api: "openai-codex-responses",
			provider: "codex-pi7",
			model: "gpt-6.1-sol",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse",
			timestamp: 2,
		},
	];
	return {
		cwd: project,
		hasUI: false,
		isProjectTrusted: () => true,
		model: { provider: "codex-pi7" },
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => sessionFile,
			buildSessionContext: () => ({ messages }),
		},
		ui: { confirm: async () => true },
	};
}

test("size aliases select Luna/high, Sol/low, and Sol/high", () => {
	assert.equal(sizedModel("small", "codex-pi7"), "codex-pi7/gpt-6-luna:high");
	assert.equal(sizedModel("big", "codex-pi7"), "codex-pi7/gpt-6.1-sol:low");
	assert.equal(sizedModel("biggest", "codex-pi7"), "codex-pi7/gpt-6.1-sol:high");
	assert.equal(sizedModel("small", "codex-pro"), "codex-pro/gpt-6-luna:high");
	assert.equal(sizedModel("big", "codex-pro"), "codex-pro/gpt-6.1-sol:low");
	assert.equal(sizedModel("biggest", "codex-pro"), "codex-pro/gpt-6.1-sol:high");
	assert.equal(sizedModel("small", "anthropic"), "openai-codex/gpt-6-luna:high");
	assert.equal(sizedModel("biggest", "anthropic"), "openai-codex/gpt-6.1-sol:high");
});

test("named subagents default to Sol/low but respect explicit template sizes", async (t) => {
	const root = mkdtempSync(join(process.env.HOME!, "tmp/pi-named-default-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	writeFileSync(join(agentDir, "agents", "general.md"), "---\nname: general\ndescription: General helper\n---\nGeneral instructions.\n");
	writeFileSync(join(agentDir, "agents", "scout.md"), "---\nname: scout\ndescription: Bulk discovery\nsize: small\n---\nScout instructions.\n");
	mkdirSync(join(root, ".agents", "subagents"), { recursive: true });
	writeFileSync(join(root, ".agents", "subagents", "project-guide.md"), "---\nname: project-guide\ndescription: Project helper\nsize: small\n---\nProject instructions.\n");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	});
	const tools = harness(async () => { throw new Error("Creation must not launch a child"); });
	const ctx = context(root, "default-parent", "create-default");
	for (const [template, size] of [["general", "big"], ["scout", "small"]]) {
		const result = await tools.get("create_subagent")!.execute(
			`create-${template}`, { name: template, template }, undefined, undefined, ctx,
		);
		assert.equal(result.details.size, size);
	}
	for (const hasUI of [false, true]) {
		const result = await tools.get("create_subagent")!.execute(
			`create-project-${hasUI}`, { name: `project-${hasUI}`, template: "project-guide" }, undefined, undefined,
			{ ...ctx, hasUI, ui: { confirm() { throw new Error("Trusted templates must not prompt"); } } },
		);
		assert.equal(result.details.template, "project-guide");
		assert.equal(result.details.size, "small");
	}
	await assert.rejects(
		tools.get("create_subagent")!.execute(
			"untrusted-project", { name: "untrusted", template: "project-guide" }, undefined, undefined,
			{ ...ctx, isProjectTrusted: () => false },
		),
		/Unknown template: project-guide/,
	);
});

test("Ultra subagents re-enter the launcher instead of bypassing managed providers", (t) => {
	const root = mkdtempSync("/tmp/pi-subagent-ultra-launcher-");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const launcher = join(root, "launcher", "launcher.mjs");
	mkdirSync(dirname(launcher), { recursive: true });
	writeFileSync(launcher, "");
	mkdirSync(join(root, "node_modules", "pi", "dist"), { recursive: true });
	writeFileSync(join(root, "node_modules", "pi", "dist", "cli.js"), "");
	assert.deepEqual(
		getPiInvocation(["--model", "codex-pro/gpt-6.1-sol:high"], {
			currentScript: join(root, "node_modules", "pi", "dist", "cli.js"),
			execPath: "/opt/node",
			ultraReleaseRoot: root,
		}),
		{
			command: "/opt/node",
			args: [realpathSync(launcher), "--model", "codex-pro/gpt-6.1-sol:high"],
		},
	);
	assert.deepEqual(subagentEnvironment({
		PI_SUBAGENT: "0",
		PI_CODEX_ULTRA_UPDATE_CHECKED: "stale-release",
		KEEP: "yes",
	}), { PI_SUBAGENT: "1", KEEP: "yes", NODE_OPTIONS: "--max-old-space-size=8192" });
});

test("named subagent retains configuration across invokes and exports without conversation", async (t) => {
	const root = mkdtempSync("/tmp/pi-named-subagent-");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	const project = join(root, "project");
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	mkdirSync(join(project, ".git"), { recursive: true });
	mkdirSync(join(project, "nested"), { recursive: true });
	writeFileSync(join(agentDir, "agents", "general.md"), `---\nname: general\ndescription: General helper\nsize: small\ncapabilities: general\n---\n\nGlobal general instructions.\n`);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	});

	const calls: any[][] = [];
	const monitor = new SubagentMonitorStore();
	const run = async (...args: any[]) => {
		calls.push(args);
		const monitored = args[12].monitor;
		monitored?.store.markStarting(monitored.runId);
		const interrupted = calls.length === 1;
		const result = {
			agent: args[2], agentSource: "user", task: args[3], exitCode: interrupted ? 130 : 0,
			messages: [assistant(`answer:${args[3]}`)], stderr: "", status: interrupted ? "interrupted" : "completed", stopReason: interrupted ? "aborted" : "stop",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 2, turns: 1 },
		} as SingleResult;
		if (monitored?.finalize !== false) monitored?.store.finishFromResult(monitored.runId, result);
		return result;
	};
	const tools = harness(run, monitor);
	const ctx = context(project, "parent-session", "create-call");

	await tools.get("create_subagent")!.execute(
		"create-call",
		{ name: "api-expert", template: "general", size: "biggest", instructions: "Custom API instructions.", cwd: ".", history: "1", context: "cwd-only" },
		undefined,
		undefined,
		ctx,
	);
	await tools.get("invoke_subagent")!.execute("invoke-1", { name: "api-expert", prompt: "first private prompt" }, undefined, undefined, ctx);
	await tools.get("invoke_subagent")!.execute("invoke-2", { name: "api-expert", prompt: "second private prompt" }, undefined, undefined, ctx);

	assert.equal(calls.length, 3);
	assert.equal(calls[0][3], "first private prompt");
	assert.equal(calls[1][3], "first private prompt");
	assert.equal(calls[1][12].monitor.finalize, false);
	assert.equal(calls[2][3], "second private prompt");
	assert.equal(calls[0][6], "codex-pi7/gpt-6.1-sol:high");
	assert.equal(calls[0][4], project);
	assert.equal(calls[0][5], "cwd-only");
	assert.equal(calls[0][12].existingSession.filePath, calls[2][12].existingSession.filePath);
	assert.equal(calls[0][1][0].systemPrompt, "Custom API instructions.");
	assert.deepEqual(monitor.getSummary("parent-session"), { total: 0, queued: 0, active: 0 });
	const seededMessages = SessionManager.open(calls[0][12].existingSession.filePath).buildSessionContext().messages;
	assert.equal((seededMessages[0] as any).content[0].text, "parent context");

	await tools.get("export_subagent")!.execute(
		"export-1",
		{ name: "api-expert", description: "Project API specialist" },
		undefined,
		undefined,
		{ ...ctx, cwd: join(project, "nested") },
	);
	const exported = join(project, ".agents", "subagents", "api-expert.md");
	const markdown = readFileSync(exported, "utf8");
	assert.match(markdown, /size: biggest/);
	assert.match(markdown, /capabilities: general/);
	assert.match(markdown, /tools: read, grep, find, ls, bash, grep_current_session, grep_session_bank, read_session, ask_session, search_context/);
	assert.match(markdown, /cwd: "\."/);
	assert.match(markdown, /Custom API instructions/);
	assert.doesNotMatch(markdown, /first private prompt|second private prompt|parent context/);

	const discovered = discoverAgents(project, "both").agents.find((agent) => agent.name === "api-expert");
	assert.equal(discovered?.source, "project");
	assert.equal(discovered?.size, "biggest");
	assert.equal(discovered?.cwd, ".");
	assert.equal(discovered?.cwdBase, project);
	assert.equal(discovered?.history, "1");
	assert.equal(discovered?.contextMode, "cwd-only");
	await assert.rejects(
		tools.get("export_subagent")!.execute("export-2", { name: "api-expert", description: "Replacement" }, undefined, undefined, ctx),
		/Refusing to overwrite/,
	);
});

test("export refuses a symlinked project agent directory", async (t) => {
	const root = mkdtempSync("/tmp/pi-named-export-symlink-");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const config = join(root, "agent");
	const project = join(root, "project");
	const outside = join(root, "outside");
	mkdirSync(join(config, "agents"), { recursive: true });
	mkdirSync(join(project, ".git"), { recursive: true });
	mkdirSync(outside, { recursive: true });
	writeFileSync(join(config, "agents", "general.md"), `---\nname: general\ndescription: General\nsize: small\ncapabilities: general\n---\nSafe instructions.\n`);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = config;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	});
	const tools = harness(async (...args: any[]) => ({
		agent: args[2], agentSource: "user", task: args[3], exitCode: 0, messages: [assistant("done")], stderr: "", status: "completed", stopReason: "stop",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 2, turns: 1 },
	}) as SingleResult);
	const ctx = context(project, "symlink-parent", "create-symlink");
	await tools.get("create_subagent")!.execute("create-symlink", { name: "safe", template: "general" }, undefined, undefined, ctx);
	symlinkSync(outside, join(project, ".agents"));
	await assert.rejects(
		tools.get("export_subagent")!.execute("export-symlink", { name: "safe", description: "Safe" }, undefined, undefined, ctx),
		/Unsafe export directory/,
	);
});

test("real named child session retains its own conversation between invokes", async (t) => {
	const root = mkdtempSync("/tmp/pi-named-thread-");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const config = join(root, "agent");
	const project = join(root, "project");
	mkdirSync(join(config, "agents"), { recursive: true });
	mkdirSync(project, { recursive: true });
	writeFileSync(join(config, "agents", "general.md"), `---\nname: general\ndescription: General\nsize: small\ncapabilities: general\n---\nThread instructions.\n`);
	const child = join(root, "thread-child.mjs");
	writeFileSync(child, `
import { appendFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
const args = process.argv.slice(2);
const session = args[args.indexOf("--session") + 1];
const prompt = args.at(-1);
const records = readFileSync(session, "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse);
const priorMessages = records.filter(record => record.type === "message").length;
let parentId = [...records].reverse().find(record => record.id)?.id ?? null;
const append = message => {
  const id = randomUUID();
  appendFileSync(session, JSON.stringify({ type: "message", id, parentId, timestamp: new Date().toISOString(), message }) + "\\n");
  parentId = id;
};
const user = { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = { role: "assistant", content: [{ type: "text", text: "prior=" + priorMessages + " " + prompt }], api: "fake", provider: "fake", model: "fake", usage, stopReason: "stop", timestamp: Date.now() };
append(user); append(assistant);
process.stdout.write(JSON.stringify({ type: "message_end", message: user }) + "\\n");
process.stdout.write(JSON.stringify({ type: "message_end", message: assistant }) + "\\n");
`, { mode: 0o700 });
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousScript = process.argv[1];
	process.env.PI_CODING_AGENT_DIR = config;
	process.argv[1] = child;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		process.argv[1] = previousScript;
	});
	const monitor = new SubagentMonitorStore();
	const captured = new Map<string, Array<{ label?: string; text: string }>>();
	monitor.subscribe(() => {
		for (const run of monitor.getRuns("thread-parent")) {
			if (!captured.has(run.id)) captured.set(run.id, run.transcript.filter((entry): entry is Exclude<(typeof run.transcript)[number], { type: "tool" }> => entry.type === "prompt").map((entry) => ({ label: entry.label, text: entry.text })));
		}
	});
	const tools = harness(runSingleAgent as any, monitor);
	const ctx = context(project, "thread-parent", "create-thread");
	await tools.get("create_subagent")!.execute("create-thread", { name: "thread", template: "general", history: "none", context: "none" }, undefined, undefined, ctx);
	const first = await tools.get("invoke_subagent")!.execute("invoke-a", { name: "thread", prompt: "first" }, undefined, undefined, ctx);
	const second = await tools.get("invoke_subagent")!.execute("invoke-b", { name: "thread", prompt: "second" }, undefined, undefined, ctx);
	const repeated = await tools.get("invoke_subagent")!.execute("invoke-repeat", { name: "thread", prompt: "first" }, undefined, undefined, ctx);
	const aborted = new AbortController();
	aborted.abort();
	await tools.get("invoke_subagent")!.execute("invoke-c", { name: "thread", prompt: "first" }, aborted.signal, undefined, ctx);
	const fourth = await tools.get("invoke_subagent")!.execute("invoke-d", { name: "thread", prompt: "fourth" }, undefined, undefined, ctx);
	assert.equal(first.content[0].text, "prior=0 Task: first");
	assert.equal(second.content[0].text, "prior=2 Task: second");
	assert.equal(repeated.content[0].text, "prior=4 Task: first");
	assert.equal(fourth.content[0].text, "prior=8 Task: fourth");
	const histories = [...captured.values()];
	assert.equal(histories.length, 5);
	assert.deepEqual(histories[0], [
		{ label: "Creation instructions", text: "Thread instructions." },
		{ label: "Initial task", text: "first" },
	]);
	assert.deepEqual(histories[1].map((entry) => entry.label), ["Creation instructions", "Initial task", "Follow-up task 1"]);
	assert.deepEqual(histories[2].map((entry) => entry.label), ["Creation instructions", "Initial task", "Follow-up task 1", "Follow-up task 2"]);
	assert.deepEqual(histories[4].map((entry) => entry.label), [
		"Creation instructions", "Initial task", "Follow-up task 1", "Follow-up task 2", "Follow-up task 3", "Follow-up task 4",
	]);
	assert.deepEqual(histories[4].slice(1).map((entry) => entry.text), ["first", "second", "first", "first", "fourth"]);
	assert.doesNotMatch(JSON.stringify(histories), /parent context/);
});

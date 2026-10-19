import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import subagentExtension from "./index.ts";

test("main agent sees size aliases, instructions, named tools, and trusted project exports", async (t) => {
	const project = mkdtempSync("/tmp/pi-subagent-schema-");
	t.after(() => rmSync(project, { recursive: true, force: true }));
	const exportedDir = join(project, ".agents", "subagents");
	const legacyDir = join(project, ".pi", "agents");
	mkdirSync(exportedDir, { recursive: true });
	mkdirSync(legacyDir, { recursive: true });
	writeFileSync(join(exportedDir, "api-expert.md"), `---\nname: api-expert\ndescription: Project API expert\nsize: small\ncapabilities: research\n---\nProject instructions.\n`);
	writeFileSync(join(legacyDir, "legacy-reviewer.md"), `---\nname: legacy-reviewer\ndescription: Legacy project reviewer\nsize: big\ncapabilities: general\n---\nLegacy instructions.\n`);

	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const shortcuts = new Map<string, any>();
	const handlers = new Map<string, Array<(event: any, ctx: any) => void>>();
	const pi = {
		registerTool(tool: any) { tools.set(tool.name, tool); },
		registerCommand(name: string, command: any) { commands.set(name, command); },
		registerShortcut(key: string, shortcut: any) { shortcuts.set(key, shortcut); },
		on(name: string, handler: (event: any, ctx: any) => void) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		events: { on() { return () => {}; }, emit() {} },
		appendEntry() {},
		sendMessage() {},
	} as unknown as ExtensionAPI;
	subagentExtension(pi);

	assert.deepEqual([...tools.keys()].sort(), ["create_subagent", "export_subagent", "invoke_subagent", "subagent"]);
	assert.ok(commands.has("subagents"));
	assert.equal(commands.has("agents"), false);
	assert.ok(shortcuts.has("alt+a"));
	assert.equal(typeof tools.get("subagent").renderResult, "function");
	assert.equal(typeof tools.get("create_subagent").renderResult, "function");
	assert.equal(typeof tools.get("invoke_subagent").renderResult, "function");
	const invokeTool = tools.get("invoke_subagent");
	assert.match(invokeTool.description, /continue: true instead of a prompt to resume its unfinished work without adding a new task/);
	assert.deepEqual(invokeTool.parameters.required, ["name"]);
	assert.match(invokeTool.parameters.properties.prompt.description, /mutually exclusive/);
	assert.match(invokeTool.parameters.properties.continue.description, /without sending a follow-up prompt/);
	const properties = tools.get("subagent").parameters.properties;
	assert.deepEqual(properties.size.enum, ["small", "big", "biggest"]);
	assert.deepEqual(properties.tasks.items.properties.size.enum, ["small", "big", "biggest"]);
	assert.deepEqual(properties.chain.items.properties.size.enum, ["small", "big", "biggest"]);
	assert.deepEqual(properties.then.properties.size.enum, ["small", "big", "biggest"]);
	assert.match(properties.then.description, /Waits for every task/);
	assert.ok(properties.instructions);
	assert.equal(properties.model, undefined);
	assert.equal(properties.confirmProjectAgents, undefined);
	assert.match(tools.get("subagent").description, /general \[big\/user\]/);
	for (const schema of [properties.size, properties.tasks.items.properties.size, properties.chain.items.properties.size, properties.then.properties.size, tools.get("create_subagent").parameters.properties.size]) {
		assert.match(schema.description, /Luna\/high/);
		assert.match(schema.description, /Sol\/low/);
		assert.match(schema.description, /biggest = GPT-6\.1 Sol\/high/);
		assert.doesNotMatch(schema.description, /Astra/);
		assert.match(schema.description, /default/);
	}

	for (const handler of handlers.get("session_start") ?? []) {
		await handler({}, {
			cwd: project,
			isProjectTrusted: () => true,
			sessionManager: { getSessionId: () => "schema-session", getBranch: () => [] },
			ui: { setStatus() {} },
		});
	}
	assert.match(tools.get("subagent").description, /api-expert \[small\/project\]/);
	assert.match(tools.get("subagent").description, /legacy-reviewer \[big\/project\]/);
	assert.match(tools.get("create_subagent").description, /api-expert \[small\/project\]/);
	assert.deepEqual(tools.get("create_subagent").parameters.properties.size.enum, ["small", "big", "biggest"]);
	const invalidFanIn = await tools.get("subagent").execute(
		"invalid-fan-in",
		{ then: { agent: "general", task: "synthesize" } },
		undefined,
		undefined,
		{ cwd: project, isProjectTrusted: () => true },
	);
	assert.match(invalidFanIn.content[0].text, /Provide exactly one mode/);
	const rejected = await tools.get("subagent").execute(
		"project-call",
		{ agent: "api-expert", task: "inspect", agentScope: "project", contextMode: "none" },
		undefined,
		undefined,
		{ cwd: project, hasUI: false, isProjectTrusted: () => false, sessionManager: {} },
	);
	assert.match(rejected.content[0].text, /project is not trusted/);
});

for (const [size, expectedModel, agentScope, hasUI] of [
	["small", "gpt-6-luna:high", "user", false],
	["big", "gpt-6.1-sol:low", "user", false],
	["biggest", "gpt-6.1-sol:high", "user", false],
	[undefined, "gpt-6.1-sol:low", "user", false],
	[undefined, "gpt-6.1-sol:low", "project", false],
	[undefined, "gpt-6.1-sol:low", "both", true],
] as const) {
test(`one-off instructions and launch without approval; size=${size ?? "default"}, scope=${agentScope}, UI=${hasUI}`, async (t) => {
	const root = mkdtempSync("/tmp/pi-subagent-one-off-");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const config = join(root, "config");
	mkdirSync(join(config, "agents"), { recursive: true });
	const template = `---\nname: general\ndescription: General\ncapabilities: general\n---\nOriginal instructions.\n`;
	writeFileSync(join(config, "agents", "general.md"), template);
	mkdirSync(join(root, ".agents", "subagents"), { recursive: true });
	writeFileSync(join(root, ".agents", "subagents", "general.md"), template);
	const log = join(root, "child.json");
	const child = join(root, "fake-child.mjs");
	writeFileSync(child, `
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const promptFile = args[args.indexOf("--append-system-prompt") + 1];
writeFileSync(process.env.PI_SUBAGENT_TEST_LOG, JSON.stringify({ args, instructions: readFileSync(promptFile, "utf8") }));
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const message = { role: "assistant", content: [{ type: "text", text: "done" + "x".repeat(150) + "FINAL_END" }], api: "fake", provider: "fake", model: "fake", usage, stopReason: "stop", timestamp: Date.now() };
process.stdout.write(JSON.stringify({ type: "message_end", message }) + "\\n");
`, { mode: 0o700 });
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousLog = process.env.PI_SUBAGENT_TEST_LOG;
	const previousScript = process.argv[1];
	process.env.PI_CODING_AGENT_DIR = config;
	process.env.PI_SUBAGENT_TEST_LOG = log;
	process.argv[1] = child;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousLog === undefined) delete process.env.PI_SUBAGENT_TEST_LOG;
		else process.env.PI_SUBAGENT_TEST_LOG = previousLog;
		process.argv[1] = previousScript;
	});

	const tools = new Map<string, any>();
	const pi = {
		registerTool(tool: any) { tools.set(tool.name, tool); },
		registerCommand() {},
		registerShortcut() {},
		on() {},
		events: { on() { return () => {}; }, emit() {} },
		appendEntry() {},
		sendMessage() {},
	} as unknown as ExtensionAPI;
	subagentExtension(pi);
	const parentFile = join(root, "parent.jsonl");
	writeFileSync(parentFile, "");
	const result = await tools.get("subagent").execute(
		"one-off-call",
		{ agent: "general", task: "inspect", instructions: "Replacement instructions.", size, agentScope, contextMode: "none" },
		undefined,
		undefined,
		{
			cwd: root,
			hasUI,
			ui: { confirm() { throw new Error("Trusted subagents must not prompt"); } },
			isProjectTrusted: () => true,
			model: { provider: "codex-pi7" },
			sessionManager: {
				getSessionId: () => "one-off-parent",
				getSessionFile: () => parentFile,
				getLeafId: () => null,
				buildSessionContext: () => ({ messages: [] }),
			},
		},
	);
	const fullOutput = "done" + "x".repeat(150) + "FINAL_END";
	assert.equal(result.content[0].text, fullOutput);
	assert.equal(result.details.results[0].finalText, fullOutput);
	assert.equal(result.details.results[0].agentSource, agentScope === "user" ? "user" : "project");
	const childRun = JSON.parse(readFileSync(log, "utf8"));
	assert.deepEqual(childRun.args.slice(childRun.args.indexOf("--model"), childRun.args.indexOf("--model") + 2), ["--model", `codex-pi7/${expectedModel}`]);
	assert.equal(childRun.instructions, "Replacement instructions.");
	assert.equal(childRun.args.at(-1), "Task: inspect");
	const parallel = await tools.get("subagent").execute("parallel-preview", { tasks: [{ agent: "general", task: "inspect" }], agentScope: "user", contextMode: "none" }, undefined, undefined, {
		cwd: root, hasUI: false,
		sessionManager: { getSessionId: () => "one-off-parent", getSessionFile: () => parentFile, getLeafId: () => null },
	});
	assert.equal(parallel.content[0].text, `Parallel: 1/1 succeeded\n\n[general] completed: ${fullOutput.slice(0, 100)}...`);
	assert.equal(parallel.details.results[0].finalText, fullOutput);
});
}

test("fan-in waits for every upstream and gives one instructed downstream all ordered outputs and session IDs", async (t) => {
	const root = mkdtempSync("/tmp/pi-subagent-fan-in-");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const config = join(root, "config");
	mkdirSync(join(config, "agents"), { recursive: true });
	writeFileSync(join(config, "agents", "general.md"), `---\nname: general\ndescription: General\nmodel: fake/fake-1\n---\nOriginal instructions.\n`);
	const log = join(root, "events.jsonl");
	const child = join(root, "fan-in-child.mjs");
	writeFileSync(child, `
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const prompt = args.at(-1);
const record = (value) => appendFileSync(process.env.PI_SUBAGENT_TEST_LOG, JSON.stringify({ at: Date.now(), ...value }) + "\\n");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const emit = (content, stopReason = "stop", errorMessage) => {
  const message = { role: "assistant", content: content.map((text) => ({ type: "text", text })), api: "fake", provider: "fake", model: "fake", usage, stopReason, errorMessage, timestamp: Date.now() };
  process.stdout.write(JSON.stringify({ type: "message_end", message }) + "\\n");
};
record({ event: "start", prompt });
if (prompt.startsWith("Task: slow-upstream")) {
  await sleep(120);
  emit(["slow-part-one", "slow-part-two"]);
} else if (prompt.startsWith("Task: fast-upstream")) {
  await sleep(10);
  emit(["fast-result"]);
} else if (prompt.startsWith("Task: failed-upstream")) {
  await sleep(30);
  emit(["failure-evidence"], "error", "expected upstream failure");
  process.exitCode = 1;
} else if (prompt.startsWith("Task: synthesize-all")) {
  const refs = JSON.parse(process.env.PI_UPSTREAM_SESSION_REFS ?? "{}");
  const files = Object.values(refs);
  const idsMatch = Object.entries(refs).every(([id, file]) => {
    if (!existsSync(file)) return false;
    return JSON.parse(readFileSync(file, "utf8").split("\\n", 1)[0]).id === id;
  });
  const promptFile = args[args.indexOf("--append-system-prompt") + 1];
  const toolsIndex = args.indexOf("--tools");
  record({ event: "downstream", prompt, refs, refsExist: files.every(existsSync), idsMatch, tools: toolsIndex < 0 ? null : args[toolsIndex + 1], instructions: readFileSync(promptFile, "utf8") });
  emit(["synthesis-complete"]);
} else {
  emit(["unexpected task"], "error", "unexpected task");
  process.exitCode = 1;
}
record({ event: "end", prompt });
`, { mode: 0o700 });

	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousLog = process.env.PI_SUBAGENT_TEST_LOG;
	const previousScript = process.argv[1];
	process.env.PI_CODING_AGENT_DIR = config;
	process.env.PI_SUBAGENT_TEST_LOG = log;
	process.argv[1] = child;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousLog === undefined) delete process.env.PI_SUBAGENT_TEST_LOG;
		else process.env.PI_SUBAGENT_TEST_LOG = previousLog;
		process.argv[1] = previousScript;
	});

	const tools = new Map<string, any>();
	const pi = {
		registerTool(tool: any) { tools.set(tool.name, tool); },
		registerCommand() {},
		registerShortcut() {},
		on() {},
		events: { on() { return () => {}; }, emit() {} },
		appendEntry() {},
		sendMessage() {},
	} as unknown as ExtensionAPI;
	subagentExtension(pi);
	const parentFile = join(root, "parent.jsonl");
	writeFileSync(parentFile, "");
	const result = await tools.get("subagent").execute(
		"fan-in-call",
		{
			tasks: [
				{ agent: "general", task: "slow-upstream" },
				{ agent: "general", task: "fast-upstream" },
				{ agent: "general", task: "failed-upstream" },
			],
			then: { agent: "general", task: "synthesize-all", instructions: "Dedicated synthesis instructions." },
			agentScope: "user",
			contextMode: "none",
		},
		undefined,
		undefined,
		{
			cwd: root,
			hasUI: false,
			isProjectTrusted: () => true,
			model: { provider: "codex-pi7" },
			sessionManager: {
				getSessionId: () => "fan-in-parent",
				getSessionFile: () => parentFile,
				getLeafId: () => null,
				buildSessionContext: () => ({ messages: [] }),
			},
		},
	);
	assert.equal(result.content[0].text, "synthesis-complete");
	assert.equal(result.details.mode, "fan-in");
	assert.deepEqual(result.details.results.map((item: any) => item.status), ["completed", "completed", "failed", "completed"]);
	assert.ok(result.details.results.every((item: any) => /^[0-9a-f-]{36}$/.test(item.sessionId)));
	assert.ok(result.details.results.every((item: any) => item.resume && existsSync(item.resume.filePath)));

	const events = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	const downstream = events.find((event) => event.event === "downstream");
	assert.ok(downstream);
	assert.equal(downstream.refsExist, true);
	assert.equal(downstream.idsMatch, true);
	assert.equal(Object.keys(downstream.refs).length, 3);
	assert.equal(downstream.tools, null);
	assert.equal(downstream.instructions, "Dedicated synthesis instructions.");
	assert.ok(events.filter((event) => event.event === "end" && !event.prompt.startsWith("Task: synthesize-all")).every((event) => event.at <= downstream.at));
	assert.ok(downstream.prompt.indexOf("slow-part-one\\nslow-part-two") < downstream.prompt.indexOf("fast-result"));
	assert.ok(downstream.prompt.indexOf("fast-result") < downstream.prompt.indexOf("failure-evidence"));
	assert.match(downstream.prompt, /\"status\": \"failed\"/);
	for (const file of Object.values(downstream.refs) as string[]) assert.equal(existsSync(file), true);
});

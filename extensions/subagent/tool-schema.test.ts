import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	const handlers = new Map<string, Array<(event: any, ctx: any) => void>>();
	const pi = {
		registerTool(tool: any) { tools.set(tool.name, tool); },
		registerCommand() {},
		on(name: string, handler: (event: any, ctx: any) => void) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		events: { on() { return () => {}; }, emit() {} },
		appendEntry() {},
		sendMessage() {},
	} as unknown as ExtensionAPI;
	subagentExtension(pi);

	assert.deepEqual([...tools.keys()].sort(), ["create_subagent", "export_subagent", "invoke_subagent", "subagent"]);
	const properties = tools.get("subagent").parameters.properties;
	assert.ok(properties.size);
	assert.ok(properties.instructions);
	assert.equal(properties.model, undefined);
	assert.equal(properties.confirmProjectAgents, undefined);
	assert.match(tools.get("subagent").description, /general \[small\/user\]/);

	for (const handler of handlers.get("session_start") ?? []) {
		handler({}, { cwd: project, isProjectTrusted: () => true, sessionManager: { getSessionId: () => "schema-session" } });
	}
	assert.match(tools.get("subagent").description, /api-expert \[small\/project\]/);
	assert.match(tools.get("subagent").description, /legacy-reviewer \[big\/project\]/);
	assert.match(tools.get("create_subagent").description, /api-expert \[small\/project\]/);
	const rejected = await tools.get("subagent").execute(
		"project-call",
		{ agent: "api-expert", task: "inspect", contextMode: "none" },
		undefined,
		undefined,
		{ cwd: project, hasUI: false, isProjectTrusted: () => true, sessionManager: {} },
	);
	assert.match(rejected.content[0].text, /require interactive approval/);
});

test("one-off custom instructions replace the template body and size selects Luna/high", async (t) => {
	const root = mkdtempSync("/tmp/pi-subagent-one-off-");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const config = join(root, "config");
	mkdirSync(join(config, "agents"), { recursive: true });
	writeFileSync(join(config, "agents", "general.md"), `---\nname: general\ndescription: General\nsize: big\ncapabilities: general\n---\nOriginal instructions.\n`);
	const log = join(root, "child.json");
	const child = join(root, "fake-child.mjs");
	writeFileSync(child, `
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const promptFile = args[args.indexOf("--append-system-prompt") + 1];
writeFileSync(process.env.PI_SUBAGENT_TEST_LOG, JSON.stringify({ args, instructions: readFileSync(promptFile, "utf8") }));
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const message = { role: "assistant", content: [{ type: "text", text: "done" }], api: "fake", provider: "fake", model: "fake", usage, stopReason: "stop", timestamp: Date.now() };
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
		{ agent: "general", task: "inspect", instructions: "Replacement instructions.", size: "small", agentScope: "user", contextMode: "none" },
		undefined,
		undefined,
		{
			cwd: root,
			hasUI: false,
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
	assert.equal(result.content[0].text, "done");
	const childRun = JSON.parse(readFileSync(log, "utf8"));
	assert.deepEqual(childRun.args.slice(childRun.args.indexOf("--model"), childRun.args.indexOf("--model") + 2), ["--model", "codex-pi7/gpt-5.6-luna:high"]);
	assert.equal(childRun.instructions, "Replacement instructions.");
	assert.equal(childRun.args.at(-1), "Task: inspect");
});

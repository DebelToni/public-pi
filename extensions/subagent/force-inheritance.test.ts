import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "bun:test";
import subagentExtension, { resumeContinuation, runSingleAgent, type SingleResult } from "./index.ts";
import { readNamedSubagent } from "./named-subagents.ts";
import { readContinuationManifest } from "./continuation-store.ts";
import askSessionExtension from "../ask-past-session/index.ts";

const key = Symbol.for("pi-codex-ultra.force-model.v1");
const global = globalThis as any;
const savedState = global[key];
const savedScript = process.argv[1];
const envKeys = ["PI_CODING_AGENT_DIR", "PI_CODEX_ULTRA_RELEASE_ROOT", "PI_CODEX_ULTRA_FORCE_MODEL", "PI_CODEX_ULTRA_UPDATE_CHECKED", "PI_FORCE_FIXTURE_LOG", "PI_SESSION_CATALOG_CLI", "TMPDIR", "PATH"];
let savedEnv: Record<string, string | undefined>;
let root: string;
let ctx: any;
let models: Set<string>;
let tools: Map<string, any>;
const agent = { name: "general", description: "fixture", source: "user", filePath: "fixture", tools: ["read"], systemPrompt: "Fixture only.", model: "openai-codex/gpt-6.1-sol:high" } as const;
const details = (results: SingleResult[]) => ({ mode: "single" as const, agentScope: "user" as const, projectAgentsDir: null, results });
const receipts = () => existsSync(join(root, "launches.jsonl")) ? readFileSync(join(root, "launches.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

beforeEach(() => {
	savedEnv = Object.fromEntries(envKeys.map((name) => [name, process.env[name]]));
	root = mkdtempSync(join(tmpdir(), "pi-force-flow-"));
	mkdirSync(join(root, "launcher")); mkdirSync(join(root, "config", "agents"), { recursive: true });
	mkdirSync(join(root, "config", "bin"));
	writeFileSync(join(root, "cli.mjs"), "");
	writeFileSync(join(root, "config", "agents", "general.md"), "---\nname: general\ndescription: fixture\ntools: read\nmodel: openai-codex/gpt-6.1-sol:high\n---\nFixture only.\n");
	const catalog = join(root, "config", "bin", "pi-session-catalog");
	writeFileSync(catalog, `#!/usr/bin/env node
const args = process.argv.slice(2);
const command = args[0];
const pathIndex = args.indexOf("--path");
const path = pathIndex >= 0 ? args[pathIndex + 1] : undefined;
const response = command === "search"
 ? { results: [{ path, id: "fixture-source", cwd: process.cwd() }], coverage: { scopeComplete: true } }
 : command === "read"
  ? { entries: [{ id: "fixture-message", type: "message", role: "user", text: "Synthetic fixture only." }], coverage: { scopeComplete: true } }
  : { scopeComplete: true };
process.stdout.write(JSON.stringify(response));
`, { mode: 0o700 });
	process.argv[1] = join(root, "cli.mjs");
	Object.assign(process.env, { PI_CODING_AGENT_DIR: join(root, "config"), PI_CODEX_ULTRA_RELEASE_ROOT: root, PI_CODEX_ULTRA_FORCE_MODEL: "1", PI_CODEX_ULTRA_UPDATE_CHECKED: "stale", PI_FORCE_FIXTURE_LOG: join(root, "launches.jsonl"), PI_SESSION_CATALOG_CLI: catalog, TMPDIR: root });
	global[key] = { active: true };
	models = new Set(["gpt-6.1-sol", "gpt-6-luna"]);
	ctx = {
		cwd: root, hasUI: false, thinkingLevel: "high", isProjectTrusted: () => false,
		model: { provider: "codex-pro", id: "gpt-6.1-sol" },
		modelRegistry: {
			find: (provider: string, id: string) => provider === "codex-pro" && models.has(id) ? { provider, id } : undefined,
			getProviderAuthStatus: () => ({ configured: true }),
		},
		sessionManager: { getSessionId: () => "fixture-parent", getSessionFile: () => undefined, getLeafId: () => "fixture-entry", getEntries: () => [], buildSessionContext: () => ({ messages: [] }) },
	};
	// Synthetic launcher exercises the real orchestration and subprocess code.
	// Immutable Ultra startup is checked separately by the offline real-child canary.
	writeFileSync(join(root, "launcher", "launcher.mjs"), `
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
const args = process.argv.slice(2);
const get = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const forced = args[0] === "--force-model";
if (forced) globalThis[Symbol.for("pi-codex-ultra.force-model.v1")] = { active: true };
const selected = get("--model") || "openai-codex/gpt-6.1-sol";
const provider = get("--provider") || selected.split("/")[0];
const model = selected.slice(selected.indexOf("/") + 1).split(":")[0];
const session = get("--session");
const source = process.env.PI_SESSION_SOURCE_PATH;
const prompt = args.at(-1);
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const receipt = { pid: process.pid, forced, forceCount: args.filter((arg) => arg === "--force-model").length, provider, explicitProvider: get("--provider"), model, thinking: get("--thinking") || selected.split(":")[1], ambientForce: process.env.PI_CODEX_ULTRA_FORCE_MODEL !== undefined, staleHandoff: process.env.PI_CODEX_ULTRA_UPDATE_CHECKED !== undefined, prompt, session, source, fileMode: statSync(session || source).mode & 511 };
appendFileSync(process.env.PI_FORCE_FIXTURE_LOG, JSON.stringify(receipt) + "\\n");
function emit(message) {
 if (session) {
  const entries = readFileSync(session, "utf8").trim().split("\\n").map(JSON.parse);
  appendFileSync(session, JSON.stringify({ type: "message", id: randomUUID(), parentId: entries.at(-1)?.id ?? null, timestamp: new Date().toISOString(), message }) + "\\n");
 }
 process.stdout.write(JSON.stringify({ type: "message_end", message }) + "\\n");
}
emit({ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() });
if (prompt === "Task: nested") {
 const { runSingleAgent } = await import(${JSON.stringify(new URL("./index.ts", import.meta.url).href)});
 const parentContext = { model: { provider, id: model }, thinkingLevel: "high", modelRegistry: { find: (p, id) => p === "codex-pro" ? { provider: p, id } : undefined, getProviderAuthStatus: () => ({ configured: true }) } };
 const child = await runSingleAgent(process.cwd(), [{ name: "leaf", description: "fixture", source: "user", filePath: "fixture", systemPrompt: "Fixture.", tools: ["read"] }], "leaf", "leaf", undefined, "none", "openai-codex/gpt-6-luna:high", undefined, undefined, undefined, undefined, results => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results }), { parentContext });
 if (child.status !== "completed") throw new Error("Nested fixture did not complete");
}
const stopReason = prompt.startsWith("Task: interrupt") ? "aborted" : "stop";
emit({ role: "assistant", content: [{ type: "text", text: "fixture answer" }], api: "fixture", provider, model, usage, stopReason, timestamp: Date.now() });
`);
	tools = new Map();
	const pi: any = { events: { on: () => () => {}, emit() {} }, registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {} };
	subagentExtension(pi); askSessionExtension(pi);
});

afterEach(() => {
	let childrenExited = false;
	try {
		for (const receipt of receipts()) {
			let alive = true;
			try { process.kill(receipt.pid, 0); } catch (error: any) { if (error.code === "ESRCH") alive = false; else throw error; }
			assert.equal(alive, false, "a fixture child is still active");
		}
		childrenExited = true;
	} finally {
		process.argv[1] = savedScript;
		if (savedState === undefined) delete global[key]; else global[key] = savedState;
		for (const name of envKeys) { if (savedEnv[name] === undefined) delete process.env[name]; else process.env[name] = savedEnv[name]; }
		if (childrenExited) rmSync(root, { recursive: true, force: true });
	}
});

function personalLaunches(expected: number) {
	const rows = receipts(); assert.equal(rows.length, expected);
	for (const row of rows) {
		assert.equal(row.forced, true); assert.equal(row.forceCount, 1);
		assert.equal(row.provider, "codex-pro"); assert.equal(row.explicitProvider, "codex-pro");
		assert.equal(row.ambientForce, false); assert.equal(row.staleHandoff, false);
		assert.equal(row.fileMode, 0o600);
	}
	return rows;
}
const run = (task: string, options: any = {}) => runSingleAgent(root, [agent as any], "general", task, undefined, "none", agent.model, undefined, undefined, undefined, undefined, details, { parentContext: ctx, runsRoot: join(root, "runs"), ...options });
const execute = (id: string, args: any, signal?: AbortSignal) => tools.get("subagent").execute(id, { contextMode: "none", ...args }, signal, undefined, ctx);

const flows: [string, any, number][] = [
	["single", { agent: "general", task: "single", size: "small" }, 1],
	["parallel", { tasks: [{ agent: "general", task: "one" }, { agent: "general", task: "two" }] }, 2],
	["fan-in", { tasks: [{ agent: "general", task: "upstream" }], then: { agent: "general", task: "downstream" } }, 2],
	["chain", { chain: [{ agent: "general", task: "first" }, { agent: "general", task: "second: {previous}" }] }, 2],
];
for (const [name, args, count] of flows) {
	test(`forced ${name} launches remain personal`, async () => {
		const result = await execute(`fixture-${name}`, args);
		assert.equal(result.details.results.every((r: SingleResult) => r.status === "completed"), true);
		personalLaunches(count);
	});
	test(`forced ${name} continuation retains live context and durable checkpoints`, async () => {
		const abort = new AbortController(); abort.abort();
		const first = await execute(`fixture-${name}-resume`, args, abort.signal);
		assert.equal(receipts().length, 0);
		assert.equal(readContinuationManifest(`fixture-${name}-resume`)?.status, "interrupted");
		const resumed = await resumeContinuation({ id: `fixture-${name}-resume`, toolCallEntryId: "fixture-entry", args: { contextMode: "none", ...args }, details: first.details }, ctx, new AbortController().signal, () => {});
		assert.equal(resumed.results.every((r: SingleResult) => r.status === "completed"), true);
		personalLaunches(count);
	});
}

test("interrupted child refuses Business without deleting work and then resumes personally", async () => {
	const first = await run("interrupt");
	assert.equal(first.status, "interrupted");
	ctx.model.provider = "openai-codex";
	const refused = await run("interrupt", { resumeFrom: first });
	assert.equal(refused.status, "interrupted");
	assert.equal(existsSync(first.resume!.filePath), true);
	assert.match(refused.errorMessage!, /Saved work was retained/);
	ctx.model.provider = "codex-pro";
	const done = await run("interrupt", { resumeFrom: refused });
	assert.equal(done.status, "completed");
	const rows = personalLaunches(2);
	assert.equal(rows[0].session, rows[1].session);
	assert.match(rows[1].prompt, /Continue the original delegated task/);
});

test("stock launcher refusal retains the pending checkpoint for a later valid launch", async () => {
	delete process.env.PI_CODEX_ULTRA_RELEASE_ROOT;
	const pending = await run("pending");
	assert.equal(pending.status, "pending"); assert.equal(receipts().length, 0);
	assert.equal(existsSync(pending.resume!.filePath), true);
	process.env.PI_CODEX_ULTRA_RELEASE_ROOT = root;
	const done = await run("pending", { resumeFrom: pending });
	assert.equal(done.status, "completed");
	assert.equal(personalLaunches(1)[0].prompt, "Task: pending");
});

test("completed recovery does not require current personal authority or a launcher", async () => {
	const done = await run("complete", { retainTerminalSession: true });
	ctx.model.provider = "openai-codex"; delete process.env.PI_CODEX_ULTRA_RELEASE_ROOT;
	const recovered = await run("complete", { resumeFrom: done, retainTerminalSession: true });
	assert.equal(recovered.status, "completed"); personalLaunches(1);
});

test("fan-in resumes only its interrupted downstream without replaying completed upstreams", async () => {
	const args = { tasks: [{ agent: "general", task: "upstream" }], then: { agent: "general", task: "interrupt" }, contextMode: "none" };
	const first = await execute("fixture-downstream", args);
	assert.equal(first.details.results.at(-1).status, "interrupted");
	const resumed = await resumeContinuation({ id: "fixture-downstream", toolCallEntryId: "fixture-entry", args, details: first.details }, ctx, new AbortController().signal, () => {});
	assert.equal(resumed.results.at(-1)!.status, "completed");
	assert.equal(personalLaunches(3).filter((row) => row.prompt === "Task: upstream").length, 1);
});

test("biggest uses Sol/high while pending recovery and new prompts retain force", async () => {
	ctx.model.provider = "openai-codex"; delete process.env.PI_CODEX_ULTRA_RELEASE_ROOT;
	await tools.get("create_subagent").execute("fixture-create", { name: "thread", template: "general", size: "biggest", history: "none", context: "none" }, undefined, undefined, ctx);
	assert.equal(receipts().length, 0);
	ctx.model.provider = "codex-pro"; process.env.PI_CODEX_ULTRA_RELEASE_ROOT = root; models.add("gpt-6-astra");
	await tools.get("invoke_subagent").execute("fixture-invoke-1", { name: "thread", prompt: "interrupt" }, undefined, undefined, ctx);
	assert.equal(readNamedSubagent("fixture-parent", "thread")!.pending!.status, "interrupted");
	ctx.model.provider = "openai-codex";
	await tools.get("invoke_subagent").execute("fixture-invoke-blocked", { name: "thread", prompt: "next" }, undefined, undefined, ctx);
	assert.equal(receipts().length, 1);
	ctx.model.provider = "codex-pro";
	await tools.get("invoke_subagent").execute("fixture-invoke-2", { name: "thread", prompt: "next" }, undefined, undefined, ctx);
	assert.equal(readNamedSubagent("fixture-parent", "thread")!.pending, undefined);
	assert.equal(personalLaunches(3).every((row) => row.model === "gpt-6.1-sol" && row.thinking === "high"), true);
});

test("a nested deliberate child repeats personal provider and force forwarding", async () => {
	const done = await run("nested"); assert.equal(done.status, "completed");
	assert.deepEqual(personalLaunches(2).map((row) => row.model), ["gpt-6.1-sol", "gpt-6-luna"]);
});

function syntheticSource() {
	const file = join(root, "synthetic.jsonl");
	writeFileSync(file, [
		{ type: "session", version: 3, id: "fixture-source", cwd: root, timestamp: new Date().toISOString() },
		{ type: "message", id: "fixture-message", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "Synthetic fixture only." }], timestamp: Date.now() } },
	].map((entry) => JSON.stringify(entry)).join("\n") + "\n", { mode: 0o600 });
	return file;
}
test("ask_session uses forced launch on an exact synthetic fixture without history discovery", async () => {
	const source = syntheticSource(); const before = readFileSync(source, "utf8");
	const answer = await tools.get("ask_session").execute("fixture-ask", { query: "Fixture?", session: source, model: "openai-codex/gpt-6-luna:high", thinking: "low" }, undefined, undefined, ctx);
	assert.equal(answer.details.model, "codex-pro/gpt-6-luna");
	const row = personalLaunches(1)[0]; assert.equal(row.thinking, "low");
	assert.equal(row.session, undefined); assert.equal(row.source, source); assert.equal(readFileSync(source, "utf8"), before);
});

test("oracle refusal creates no disposable branch and leaves its synthetic source alone", async () => {
	const source = syntheticSource(); delete process.env.PI_CODEX_ULTRA_RELEASE_ROOT;
	await assert.rejects(tools.get("ask_session").execute("fixture-ask-blocked", { query: "Fixture?", session: source }, undefined, undefined, ctx), /Ultra launcher/);
	assert.equal(receipts().length, 0);
	assert.equal(readdirSync(root).some((name) => name.startsWith("pi-ask-session-")), false);
	assert.equal(existsSync(source), true);
});

test("ordinary oracle preserves PATH and handoff behavior without forwarding a force marker", async () => {
	delete global[key];
	const bin = join(root, "bin"); mkdirSync(bin);
	writeFileSync(join(bin, "pi"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(root, "launcher", "launcher.mjs"))} "$@"\n`, { mode: 0o700 });
	process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
	const answer = await tools.get("ask_session").execute("fixture-ordinary-ask", { query: "Fixture?", session: syntheticSource(), model: "openai-codex/gpt-6.1-sol" }, undefined, undefined, ctx);
	assert.equal(answer.details.model, "openai-codex/gpt-6.1-sol");
	const row = receipts()[0]; assert.equal(row.forced, false); assert.equal(row.ambientForce, false); assert.equal(row.staleHandoff, true);
});

test("ordinary delegation ignores a stale ambient marker and keeps its requested provider", async () => {
	delete global[key];
	const done = await run("ordinary"); assert.equal(done.status, "completed");
	const row = receipts()[0]; assert.equal(row.forced, false); assert.equal(row.forceCount, 0);
	assert.equal(row.provider, "openai-codex"); assert.equal(row.ambientForce, false);
});

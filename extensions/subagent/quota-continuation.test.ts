import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import subagentExtension, { runSingleAgent } from "./index.ts";
import { readNamedSubagent } from "./named-subagents.ts";
import { isQuotaError } from "./quota-error.ts";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { CONTINUATION_REQUEST_CHANNEL, type ContinuationRequest } from "../lib/continuation-request.ts";

const assistant = (content: any[], stopReason = "toolUse"): any => ({ role: "assistant", content, stopReason, api: "fake", provider: "fake", model: "fake", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() });

function fixture(t: any, beforeExtension?: (pi: any) => void) {
	const root = mkdtempSync(join(tmpdir(), "pi-quota-continue-"));
	const oldDir = process.env.PI_CODING_AGENT_DIR;
	const oldScript = process.argv[1];
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	mkdirSync(join(root, "agent", "agents"), { recursive: true });
	writeFileSync(join(root, "agent", "agents", "general.md"), "---\nname: general\ndescription: fixture\nsize: small\ntools: read\n---\nFixture.\n");
	const ready = join(root, "ready");
	const log = join(root, "log.jsonl");
	const script = join(root, "child.mjs");
	writeFileSync(script, `
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const args = process.argv.slice(2);
const file = args[args.indexOf('--session') + 1];
const prompt = args.at(-1);
const records = readFileSync(file,'utf8').trim().split('\\n').map(JSON.parse);
const previous = records.filter(r => r.type === 'message');
appendFileSync(${JSON.stringify(log)}, JSON.stringify({file,prompt,prior:previous.length})+'\\n');
let parentId = records.at(-1).id;
function emit(message) {
 const id = randomUUID();
 appendFileSync(file,JSON.stringify({type:'message',id,parentId,timestamp:new Date().toISOString(),message})+'\\n');
 parentId=id;
 console.log(JSON.stringify({type:'message_end',message}));
}
emit({role:'user',content:[{type:'text',text:prompt}],timestamp:Date.now()});
const success = prompt === 'Task: sibling' || existsSync(${JSON.stringify(ready)});
const errorMessage = prompt === 'Task: permanent' ? 'Invalid request: unsupported parameter' : 'You have hit your ChatGPT usage limit. Try again later.';
emit({ ...${JSON.stringify(assistant([], "stop"))}, timestamp:Date.now(), content: success ? [{type:'text',text:'COMPLETE '+prompt}] : [], stopReason:success?'stop':'error', ...(success?{}:{errorMessage}) });
process.exitCode=success?0:1;
`);
	process.argv[1] = script;
	const manager = SessionManager.create(root, join(root, "sessions"));
	manager.appendMessage({ role: "user", content: "Do work", timestamp: Date.now() });
	manager.appendMessage(assistant([{ type: "text", text: "Starting" }], "stop"));
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const sent: any[] = [];
	const notices: string[] = [];
	const handlers = new Map<string, any[]>();
	const events = createEventBus();
	const emit = (name: string) => { for (const handler of handlers.get(name) ?? []) handler({}, ctx); };
	let autoSettle = true;
	const pi: any = {
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerShortcut() {}, events,
		on(name: string, handler: any) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
		appendEntry: (type: string, data: any) => manager.appendCustomEntry(type, data),
		sendMessage(message: any, options: any) {
			sent.push({ message, options });
			manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
			if (options.triggerTurn) {
				emit("agent_start");
				if (autoSettle) queueMicrotask(() => emit("agent_settled"));
			}
		},
	};
	beforeExtension?.(pi);
	subagentExtension(pi);
	const ctx: any = { cwd: root, sessionManager: manager, isIdle: () => true, mode: "rpc", hasUI: false, isProjectTrusted: () => false, ui: { notify: (text: string) => notices.push(text), setStatus() {} } };
	let id = 0;
	const execute = async (name: string, args: any) => {
		const toolCallId = `call-${++id}`;
		manager.appendMessage(assistant([{ type: "toolCall", name, id: toolCallId, arguments: args }]));
		const result = await tools.get(name).execute(toolCallId, args, undefined, undefined, ctx);
		manager.appendMessage({ role: "toolResult", toolName: name, toolCallId, content: result.content, details: result.details, isError: false, timestamp: Date.now() } as any);
		return result;
	};
	t.after(() => {
		process.argv[1] = oldScript;
		if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
		rmSync(root, { recursive: true, force: true });
	});
	return { root, ready, manager, ctx, sent, notices, execute, commands, handlers, events, emit, async emitAsync(name: string) { for (const handler of handlers.get(name) ?? []) await handler({}, ctx); }, setAutoSettle(value: boolean) { autoSettle = value; }, log: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [] };
}

test("quota errors are resumable but ordinary provider failures are not", async (t) => {
	const f = fixture(t);
	assert.equal(isQuotaError("You have hit your ChatGPT usage limit"), true);
	assert.equal(isQuotaError("insufficient_quota"), true);
	assert.equal(isQuotaError("Invalid request: unsupported parameter"), false);
	const agent: any = { name: "general", source: "user", description: "fixture", filePath: "fixture", systemPrompt: "" };
	const run = (task: string, options = {}) => runSingleAgent(f.root, [agent], "general", task, undefined, "none", undefined, undefined, undefined, undefined, undefined, (results) => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results }), options);
	const paused = await run("quota");
	assert.equal(paused.status, "interrupted");
	assert.match(paused.errorMessage!, /usage limit/);
	assert.ok(paused.resume && existsSync(paused.resume.filePath));
	const permanent = await run("permanent");
	assert.equal(permanent.status, "failed");
	assert.ok(permanent.resume && existsSync(permanent.resume.filePath));
	writeFileSync(f.ready, "yes");
	const completed = await run("quota", { resumeFrom: paused });
	assert.equal(completed.status, "completed", "saved quota error must not be recovered as terminal failure");
	assert.notEqual(f.log().at(-1).prompt, "Task: quota", "resume must continue existing context rather than replay original task");
});

test("generic recovery releases its lease before children and waits for the parent to settle", async (t) => {
	const f = fixture(t);
	await f.execute("subagent", { tasks: [{ agent: "general", task: "sibling" }, { agent: "general", task: "quota" }], contextMode: "none", agentScope: "user" });
	f.setAutoSettle(false);
	let released = false;
	let started = false;
	const request: ContinuationRequest = {
		context: f.ctx,
		beforeWork: async (kind) => {
			assert.equal(kind, "outstanding");
			assert.equal(f.log().length, 2);
			assert.equal(f.sent.length, 0);
			released = true;
			writeFileSync(f.ready, "yes");
		},
		onStarted() {
			assert.equal(released, true);
			assert.equal(f.log().length, 3);
			assert.equal(f.sent.at(-1).options.triggerTurn, true);
			started = true;
		},
	};
	f.events.emit(CONTINUATION_REQUEST_CHANNEL, request);
	assert.ok(request.run, "claim is synchronous");
	let settled = false;
	void request.run.then(() => { settled = true; });
	for (let n = 0; n < 200 && !started; n++) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(started, true);
	assert.equal(settled, false, "submission is not settlement");
	f.emit("agent_settled");
	await request.run;
	assert.equal(settled, true);
	assert.equal(f.sent.filter((row) => row.options.triggerTurn).length, 1);
});

test("generic recovery rejects repeated child quota without waking the parent, then retries safely", async (t) => {
	const f = fixture(t);
	await f.execute("create_subagent", { name: "worker", history: "none", context: "none" });
	await f.execute("invoke_subagent", { name: "worker", prompt: "quota" });
	const first: ContinuationRequest = { context: f.ctx };
	f.events.emit(CONTINUATION_REQUEST_CHANNEL, first);
	await assert.rejects(first.run!, /paused/);
	assert.equal(f.sent.length, 0);
	writeFileSync(f.ready, "yes");
	const next: ContinuationRequest = { context: f.ctx };
	f.events.emit(CONTINUATION_REQUEST_CHANNEL, next);
	await next.run;
	assert.equal(f.log().length, 3);
	assert.equal(f.sent.filter((row) => row.options.triggerTurn).length, 1);
});

test("generic recovery fails closed on a lease-release failure and rejects duplicate claims", async (t) => {
	const f = fixture(t);
	let unblock!: () => void;
	const gate = new Promise<void>((resolve) => { unblock = resolve; });
	const first: ContinuationRequest = { context: f.ctx, beforeWork: async () => { await gate; throw new Error("lease unavailable"); } };
	f.events.emit(CONTINUATION_REQUEST_CHANNEL, first);
	await Promise.resolve();
	const duplicate: ContinuationRequest = { context: f.ctx };
	f.events.emit(CONTINUATION_REQUEST_CHANNEL, duplicate);
	await assert.rejects(duplicate.run!, /already active/);
	unblock();
	await assert.rejects(first.run!, /lease unavailable/);
	assert.equal(f.sent.length, 0);
});

test("generic recovery with no child work preserves the main lease path", async (t) => {
	const f = fixture(t);
	let kind: string | undefined;
	let started = 0;
	const request: ContinuationRequest = { context: f.ctx, beforeWork: async (value) => { kind = value; }, onStarted: () => { started++; } };
	f.events.emit(CONTINUATION_REQUEST_CHANNEL, request);
	await request.run;
	assert.equal(kind, "main");
	assert.equal(started, 1);
	assert.equal(f.sent.length, 1);
});

if (process.env.PI_ULTRA_SOURCE_ROOT) test("Ultra's production request helper integrates with child-first subagent recovery", async (t) => {
	const { requestContinuation } = await import(join(process.env.PI_ULTRA_SOURCE_ROOT!, "suite/modules/codex-seat-automation/continuation-request.ts"));
	const f = fixture(t);
	await f.execute("subagent", { tasks: [{ agent: "general", task: "sibling" }, { agent: "general", task: "quota" }], contextMode: "none", agentScope: "user" });
	let released = false;
	let started = 0;
	const options = {
		beforeWork: async (kind: string) => { assert.equal(kind, "outstanding"); released = true; },
		onStarted: () => { assert.equal(released, true); assert.equal(f.log().length, 4); started++; },
	};
	const pi = { events: f.events } as any;
	await assert.rejects(requestContinuation(pi, f.ctx, options), /paused/);
	assert.equal(started, 0);
	assert.equal(f.sent.length, 0);
	writeFileSync(f.ready, "yes");
	await requestContinuation(pi, f.ctx, options);
	assert.equal(started, 1);
	assert.equal(f.sent.filter((row) => row.options.triggerTurn).length, 1);
	assert.equal(f.log().filter((row) => row.prompt === "Task: sibling").length, 1);
});

if (process.env.PI_ULTRA_SOURCE_ROOT) test("nested Ultra quota recovery can reenter before the outer parent settlement hook", async (t) => {
	const { requestContinuation } = await import(join(process.env.PI_ULTRA_SOURCE_ROOT!, "suite/modules/codex-seat-automation/continuation-request.ts"));
	let nested = false;
	let started = 0;
	let nestedFinished = false;
	const settlements: Promise<void>[] = [];
	const f = fixture(t, (pi) => {
		// Ultra's handlers precede the mutable extension's lifecycle waiter.
		pi.on("agent_settled", async () => {
			if (nested) return;
			nested = true;
			await requestContinuation(pi, f.ctx, options);
			nestedFinished = true;
		});
	});
	f.setAutoSettle(false);
	const options = {
		beforeWork: async (kind: string) => assert.equal(kind, "main"),
		onStarted: () => {
			started++;
			queueMicrotask(() => settlements.push(f.emitAsync("agent_settled")));
		},
	};
	await requestContinuation({ events: f.events } as any, f.ctx, options);
	await Promise.all(settlements);
	assert.equal(nestedFinished, true);
	assert.equal(started, 2);
	assert.equal(f.sent.filter((row) => row.options.triggerTurn).length, 2);
	assert.equal(f.notices.length, 0);
});

test("mixed named and multiple one-off calls all finish before the main turn", async (t) => {
	const f = fixture(t);
	await f.execute("create_subagent", { name: "worker", history: "none", context: "none" });
	await f.execute("invoke_subagent", { name: "worker", prompt: "named-quota" });
	await f.execute("subagent", { agent: "general", task: "first-quota", contextMode: "none", agentScope: "user" });
	await f.execute("subagent", { agent: "general", task: "second-quota", contextMode: "none", agentScope: "user" });
	assert.equal(f.log().length, 3);
	writeFileSync(f.ready, "yes");
	await f.commands.get("continue").handler("", f.ctx);
	assert.equal(f.log().length, 6);
	assert.equal(f.sent.filter((row) => row.options.triggerTurn).length, 1);
	assert.equal(f.sent.at(-1).options.triggerTurn, true);
	assert.equal(f.sent.filter((row) => row.message.customType === "subagent-continuation-result").length, 2);
	assert.equal(f.sent.filter((row) => row.message.customType === "named-subagent-continuation-result").length, 1);
	await f.commands.get("continue").handler("", f.ctx);
	assert.equal(f.log().length, 6);
});

for (const named of [false, true]) test(`${named ? "named" : "parallel"} quota pause resumes children before the parent and retains completed siblings`, async (t) => {
	const f = fixture(t);
	let paused: any;
	if (named) {
		await f.execute("create_subagent", { name: "worker", history: "none", context: "none" });
		await f.execute("create_subagent", { name: "done", history: "none", context: "none" });
		await f.execute("invoke_subagent", { name: "done", prompt: "sibling" });
		paused = await f.execute("invoke_subagent", { name: "worker", prompt: "quota" });
		assert.equal(paused.details.result.status, "interrupted");
		assert.ok(readNamedSubagent(f.manager.getSessionId(), "worker")?.pending);
	} else {
		paused = await f.execute("subagent", { tasks: [{ agent: "general", task: "sibling" }, { agent: "general", task: "quota" }], contextMode: "none", agentScope: "user" });
		assert.deepEqual(paused.details.results.map((item: any) => item.status), ["completed", "interrupted"]);
	}
	// The parent also exhausts quota before it can process the child result.
	f.manager.appendMessage({ ...assistant([], "error"), errorMessage: "You have hit your ChatGPT usage limit" });
	await f.commands.get("continue").handler("", f.ctx);
	assert.equal(f.sent.length, 0, "still-paused children must not trigger the main model");
	assert.equal(f.log().filter((row) => row.prompt === "Task: sibling").length, 1);
	writeFileSync(f.ready, "yes");
	await f.commands.get("continue").handler("", f.ctx);
	assert.equal(f.sent.filter((row) => row.options.triggerTurn).length, 1);
	const recovery = f.sent.find((row) => row.message.customType === (named ? "named-subagent-continuation-result" : "subagent-continuation-result"));
	assert.ok(recovery);
	assert.match(recovery.message.content, /COMPLETE/);
	assert.equal(recovery.options.triggerTurn, false);
	assert.equal(f.log().filter((row) => row.prompt === "Task: sibling").length, 1);
	assert.equal(f.log().filter((row) => row.prompt === "Task: quota").length, 1);
	const launches = f.log().length;
	await f.commands.get("continue").handler("", f.ctx);
	assert.equal(f.log().length, launches, "parent retry after result delivery must not rerun children");
});

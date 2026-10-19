import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import {
	SessionManager,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { acquireContinuationLease } from "./continuation-store.ts";
import type { SingleResult } from "./index.ts";
import {
	continueNamedSubagents,
	NAMED_SUBAGENT_CONTINUATION_RESULT_TYPE,
	readNamedSubagent,
	registerNamedSubagentTools,
	type NamedSubagentDependencies,
} from "./named-subagents.ts";

type Tool = { execute: (...args: any[]) => Promise<any> };
type Status = NonNullable<SingleResult["status"]>;

function assistant(content: any[], stopReason: "stop" | "toolUse" = "stop"): any {
	return {
		role: "assistant",
		content,
		api: "fake",
		provider: "fake",
		model: "fake",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

class ScriptedRunner {
	readonly calls: Array<{ task: string; resumeFrom?: SingleResult; existingSession?: any }> = [];
	readonly scripts = new Map<string, Array<{ status: Status; errorMessage?: string; pid?: number }>>();

	queue(task: string, ...steps: Array<Status | { status: Status; errorMessage?: string; pid?: number }>) {
		this.scripts.set(task, steps.map((step) => typeof step === "string" ? { status: step } : step));
	}

	run = async (...args: any[]): Promise<SingleResult> => {
		const task = args[3] as string;
		const options = args[12] as any;
		const handle = options.resumeFrom?.resume ?? options.existingSession;
		if (!handle?.filePath) throw new Error("scripted named child requires a saved session");
		const manager = SessionManager.open(handle.filePath);
		const step = this.scripts.get(task)?.shift() ?? { status: "completed" as const };
		const user = { role: "user", content: `Task: ${task}`, timestamp: Date.now() } as any;
		const reply = assistant([{ type: "text", text: `answer:${task}:${step.status}` }], step.status === "failed" ? "stop" : "stop");
		manager.appendMessage(user);
		manager.appendMessage(reply);
		const result: SingleResult = {
			agent: args[2],
			agentSource: "user",
			task,
			exitCode: step.status === "completed" ? 0 : 1,
			messages: [user, reply],
			stderr: "",
			status: step.status,
			stopReason: step.status === "completed" ? "stop" : step.status === "failed" ? "error" : "aborted",
			...(step.errorMessage ? { errorMessage: step.errorMessage } : {}),
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 2, turns: 1 },
			resume: { ...handle, sessionId: manager.getSessionId(), ...(step.pid ? { pid: step.pid } : {}) },
			sessionId: manager.getSessionId(),
		};
		this.calls.push({ task, resumeFrom: options.resumeFrom, existingSession: options.existingSession });
		options.onCheckpoint?.(result);
		return result;
	};
}

function fixture(t: TestContext) {
	const base = join(homedir(), "tmp");
	mkdirSync(base, { recursive: true });
	const root = mkdtempSync(join(base, "pi-named-continuation-"));
	const previousTmp = process.env.TMPDIR;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.TMPDIR = root;
	process.env.PI_CODING_AGENT_DIR = join(tmpdir(), "agent");
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	const project = join(tmpdir(), "project");
	const sessions = join(tmpdir(), "sessions");
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	mkdirSync(project, { recursive: true });
	mkdirSync(sessions, { recursive: true });
	writeFileSync(join(agentDir, "agents", "general.md"), [
		"---",
		"name: general",
		"description: deterministic",
		"size: small",
		"capabilities: general",
		"---",
		"Deterministic instructions.",
		"",
	].join("\n"));

	const runner = new ScriptedRunner();
	const monitorInputs: any[] = [];
	const monitor = {
		queueRun(input: any) { monitorInputs.push(structuredClone(input)); return `monitor-${monitorInputs.length}`; },
		finishFromResult() {},
		finishRun() {},
	} as any;
	const dependencies: NamedSubagentDependencies = {
		runSingleAgent: runner.run as any,
		sizedModel: () => "fake/model",
		monitor,
	};
	const tools = new Map<string, Tool>();
	let manager: SessionManager | undefined;
	let sequence = 0;
	const pi = {
		registerTool(tool: Tool & { name: string }) { tools.set(tool.name, tool); },
		appendEntry(customType: string, data?: unknown) {
			if (!manager) throw new Error("appendEntry outside bound parent session");
			manager.appendCustomEntry(customType, data);
		},
	} as unknown as ExtensionAPI;
	registerNamedSubagentTools(pi, dependencies, project);

	const ctx = (parent: SessionManager): ExtensionContext => ({
		cwd: project,
		hasUI: false,
		isProjectTrusted: () => true,
		model: { provider: "fake" },
		sessionManager: parent,
		ui: { confirm: async () => true },
	} as unknown as ExtensionContext);

	async function bound<T>(parent: SessionManager, operation: () => Promise<T>) {
		assert.equal(manager, undefined);
		manager = parent;
		try {
			return await operation();
		} finally {
			manager = undefined;
		}
	}

	function call(parent: SessionManager, name: string, prompt: string, id = `named-call-${++sequence}`) {
		parent.appendMessage(assistant([{ type: "toolCall", id, name: "invoke_subagent", arguments: { name, prompt } }], "toolUse"));
		return id;
	}

	async function create(parent: SessionManager, name: string) {
		const id = `create-call-${++sequence}`;
		parent.appendMessage(assistant([{ type: "toolCall", id, name: "create_subagent", arguments: { name } }], "toolUse"));
		const result = await bound(parent, () => tools.get("create_subagent")!.execute(
			id,
			{ name, template: "general", history: "none", context: "none" },
			undefined,
			undefined,
			ctx(parent),
		));
		parent.appendMessage({
			role: "toolResult", toolCallId: id, toolName: "create_subagent",
			content: result.content, details: result.details, isError: false, timestamp: Date.now(),
		} as any);
	}

	async function executeInvoke(parent: SessionManager, toolCallId: string, params: Record<string, unknown>, persistResult: boolean) {
		const result = await bound(parent, () => tools.get("invoke_subagent")!.execute(
			toolCallId,
			params,
			undefined,
			undefined,
			ctx(parent),
		));
		if (persistResult) {
			parent.appendMessage({
				role: "toolResult", toolCallId, toolName: "invoke_subagent",
				content: result.content, details: result.details, isError: false, timestamp: Date.now(),
			} as any);
		}
		return { toolCallId, result };
	}

	async function invoke(parent: SessionManager, name: string, prompt: string, persistResult: boolean, id?: string) {
		const toolCallId = call(parent, name, prompt, id);
		return executeInvoke(parent, toolCallId, { name, prompt }, persistResult);
	}

	async function continueOnly(parent: SessionManager, name: string, persistResult: boolean, id = `continue-call-${++sequence}`) {
		parent.appendMessage(assistant([{ type: "toolCall", id, name: "invoke_subagent", arguments: { name, continue: true } }], "toolUse"));
		return executeInvoke(parent, id, { name, continue: true }, persistResult);
	}

	async function invokeWithoutParentCall(parent: SessionManager, name: string, prompt: string, id = `unrecorded-call-${++sequence}`) {
		return executeInvoke(parent, id, { name, prompt }, false);
	}

	async function resume(parent: SessionManager) {
		return bound(parent, () => continueNamedSubagents(pi, dependencies, ctx(parent), new AbortController().signal));
	}

	function deliver(parent: SessionManager, toolCallIds: string[]) {
		parent.appendCustomMessageEntry(
			NAMED_SUBAGENT_CONTINUATION_RESULT_TYPE,
			"named results delivered",
			false,
			{ toolCallIds },
		);
	}

	function parent() {
		const value = SessionManager.create(project, sessions);
		value.appendMessage({ role: "user", content: "parent", timestamp: Date.now() });
		value.appendMessage(assistant([{ type: "text", text: "ready" }]));
		return value;
	}

	t.after(() => {
		if (previousTmp === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previousTmp;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	});

	return { root, project, runner, dependencies, pi, ctx, bound, call, create, invoke, executeInvoke, continueOnly, invokeWithoutParentCall, resume, deliver, parent, monitorInputs: () => monitorInputs };
}

function namedState(parent: SessionManager, name: string) {
	const value = readNamedSubagent(parent.getSessionId(), name);
	assert.ok(value);
	return value;
}

function fork(parent: SessionManager, root: string) {
	return SessionManager.forkFrom(parent.getSessionFile()!, parent.getCwd(), join(root, "fork"));
}

test("continue-only resumes one interrupted task across a fork without appending a follow-up", async (t) => {
	const f = fixture(t);
	const source = f.parent();
	await f.create(source, "continue-worker");
	f.runner.queue("interrupted-task", "interrupted", "interrupted", "completed");
	await f.invokeWithoutParentCall(source, "continue-worker", "interrupted-task");
	const interrupted = await f.continueOnly(source, "continue-worker", false, "continue-only-call");
	assert.equal(interrupted.result.details.result.status, "interrupted");
	assert.equal(namedState(source, "continue-worker").continuation?.continueOnly, true);
	assert.equal(namedState(source, "continue-worker").continuation?.prompt, undefined);

	const sourceState = namedState(source, "continue-worker");
	const sourceStateBytes = readFileSync(join(dirname(dirname(sourceState.resume.dir)), "continue-worker.json"));
	const sourceChildBytes = readFileSync(sourceState.resume.filePath);
	const destination = fork(source, f.root);
	const before = f.runner.calls.length;
	const resumed = await f.resume(destination);
	assert.equal(resumed.pending, false);
	assert.deepEqual(resumed.results.map((item) => [item.toolCallId, item.result.task, item.result.status]), [
		["continue-only-call", "interrupted-task", "completed"],
	]);
	assert.equal(f.runner.calls.length, before + 1);
	assert.deepEqual(f.runner.calls.slice(before).map((call) => call.task), ["interrupted-task"]);
	assert.ok(f.runner.calls[before].resumeFrom);
	assert.equal(f.runner.calls[before].existingSession, undefined);
	const destinationState = namedState(destination, "continue-worker");
	assert.equal(destinationState.continuation?.continueOnly, true);
	assert.equal(destinationState.continuation?.prompt, undefined);
	assert.equal(destinationState.continuation?.result?.status, "completed");
	assert.equal(destinationState.continuation?.result?.resume?.filePath, destinationState.resume.filePath);
	assert.deepEqual(f.monitorInputs().map((input) => input.tasks), [
		["interrupted-task"],
		["interrupted-task"],
		["interrupted-task"],
	]);
	const repeated = await f.resume(destination);
	assert.equal(repeated.results[0].result.status, "completed");
	assert.equal(f.runner.calls.length, before + 1, "a completed continue-only receipt must not rerun");
	assert.deepEqual(readFileSync(join(dirname(dirname(sourceState.resume.dir)), "continue-worker.json")), sourceStateBytes);
	assert.deepEqual(readFileSync(sourceState.resume.filePath), sourceChildBytes);
});

test("continue-only with no pending work is a durable no-op and launches nothing", async (t) => {
	const f = fixture(t);
	const parent = f.parent();
	await f.create(parent, "idle-worker");
	const beforeState = namedState(parent, "idle-worker");
	const childBytes = readFileSync(beforeState.resume.filePath);
	const calls = f.runner.calls.length;
	const monitorRuns = f.monitorInputs().length;
	const noOp = await f.continueOnly(parent, "idle-worker", false, "idle-continue-call");
	assert.equal(noOp.result.content[0].text, "No interrupted work is pending for idle-worker; nothing was started.");
	assert.equal(noOp.result.details.result.status, "completed");
	assert.equal(f.runner.calls.length, calls);
	assert.equal(f.monitorInputs().length, monitorRuns);
	assert.deepEqual(readFileSync(namedState(parent, "idle-worker").resume.filePath), childBytes);
	assert.equal(namedState(parent, "idle-worker").continuation?.continueOnly, true);
	assert.equal(namedState(parent, "idle-worker").continuation?.result?.status, "completed");
	const recovered = await f.resume(parent);
	assert.deepEqual(recovered.results.map((item) => [item.toolCallId, item.result.status]), [["idle-continue-call", "completed"]]);
	assert.equal(f.runner.calls.length, calls);
	assert.equal(f.monitorInputs().length, monitorRuns);
	assert.deepEqual(readFileSync(namedState(parent, "idle-worker").resume.filePath), childBytes);
});

test("invoke_subagent rejects missing, mixed, and false continue actions", async (t) => {
	const f = fixture(t);
	const parent = f.parent();
	await f.create(parent, "validated-worker");
	const calls = f.runner.calls.length;
	await assert.rejects(
		f.executeInvoke(parent, "missing-action", { name: "validated-worker" }, false),
		/requires either "prompt" or "continue": true/,
	);
	await assert.rejects(
		f.executeInvoke(parent, "mixed-action", { name: "validated-worker", prompt: "new task", continue: true }, false),
		/accepts either "prompt" or "continue": true, not both/,
	);
	await assert.rejects(
		f.executeInvoke(parent, "false-continue", { name: "validated-worker", continue: false }, false),
		/"continue" must be exactly true/,
	);
	assert.equal(f.runner.calls.length, calls);
});

test("a lost named tool result resumes once and keeps a durable ready receipt until delivery", async (t) => {
	const f = fixture(t);
	const parent = f.parent();
	await f.create(parent, "quota-worker");
	f.runner.queue("quota-task", "interrupted", "completed");
	const invocation = await f.invoke(parent, "quota-worker", "quota-task", false, "opaque-quota-call");
	assert.equal(invocation.result.details.result.status, "interrupted");
	assert.equal(namedState(parent, "quota-worker").continuation?.toolCallId, "opaque-quota-call");

	const before = f.runner.calls.length;
	const resumed = await f.resume(parent);
	assert.equal(resumed.handled, true);
	assert.equal(resumed.pending, false);
	assert.deepEqual(resumed.results.map(({ name, toolCallId, result }) => ({ name, toolCallId, status: result.status })), [
		{ name: "quota-worker", toolCallId: "opaque-quota-call", status: "completed" },
	]);
	assert.equal(f.runner.calls.length, before + 1);
	assert.ok(f.runner.calls.at(-1)?.resumeFrom);
	assert.deepEqual(f.monitorInputs().map((input) => input.tasks), [
		["quota-task"],
		["quota-task"],
	]);
	assert.ok(f.monitorInputs().every((input) => input.creationInstructions === "Deterministic instructions."));
	assert.equal(namedState(parent, "quota-worker").pending, undefined);
	assert.equal(namedState(parent, "quota-worker").continuation?.result?.status, "completed");

	const repeated = await f.resume(parent);
	assert.equal(repeated.pending, false);
	assert.equal(repeated.results[0].result.status, "completed");
	assert.equal(f.runner.calls.length, before + 1, "ready named work must not rerun before parent delivery");
	f.deliver(parent, ["opaque-quota-call"]);
	assert.deepEqual(await f.resume(parent), { handled: false, pending: false, results: [] });
	assert.equal(f.runner.calls.length, before + 1);
});

test("a persisted interrupted invoke tool result remains eligible and resumes from its exact handle", async (t) => {
	const f = fixture(t);
	const parent = f.parent();
	await f.create(parent, "persisted");
	f.runner.queue("persisted-task", "interrupted", "completed");
	const invocation = await f.invoke(parent, "persisted", "persisted-task", true, "persisted-interrupted-call");
	const interrupted = invocation.result.details.result as SingleResult;
	assert.equal(interrupted.status, "interrupted");
	const before = f.runner.calls.length;
	const resumed = await f.resume(parent);
	assert.equal(resumed.pending, false);
	assert.deepEqual(resumed.results.map((item) => [item.toolCallId, item.result.status]), [
		["persisted-interrupted-call", "completed"],
	]);
	assert.equal(f.runner.calls.length, before + 1);
	assert.deepEqual(f.runner.calls.at(-1)?.resumeFrom?.resume, interrupted.resume);
});

test("later outstanding calls for one name wait while the earlier call remains paused", async (t) => {
	const f = fixture(t);
	const parent = f.parent();
	await f.create(parent, "serial");
	f.runner.queue("first-task", "interrupted", "interrupted", "completed");
	await f.invoke(parent, "serial", "first-task", true, "first-call");
	f.call(parent, "serial", "second-task", "second-call");
	f.runner.queue("second-task", "completed");
	const before = f.runner.calls.length;
	const paused = await f.resume(parent);
	assert.equal(paused.pending, true);
	assert.deepEqual(paused.results, []);
	assert.equal(f.runner.calls.length, before + 1);
	assert.equal(f.runner.calls.some((call) => call.task === "second-task"), false);

	const completed = await f.resume(parent);
	assert.equal(completed.pending, false);
	assert.deepEqual(completed.results.map((item) => [item.toolCallId, item.result.task]), [
		["first-call", "first-task"],
		["second-call", "second-task"],
	]);
	assert.deepEqual(f.runner.calls.slice(before).map((call) => call.task), ["first-task", "first-task", "second-task"]);
});

test("ready same-name work is not rerun while a later same-name call remains paused", async (t) => {
	const f = fixture(t);
	const parent = f.parent();
	await f.create(parent, "same-thread");
	f.runner.queue("first-ready", "completed");
	await f.invoke(parent, "same-thread", "first-ready", false, "first-ready-call");
	f.runner.queue("second-paused", "interrupted", "interrupted", "completed");
	await f.invoke(parent, "same-thread", "second-paused", true, "second-paused-call");
	const before = f.runner.calls.length;

	const partial = await f.resume(parent);
	assert.equal(partial.pending, true);
	assert.deepEqual(partial.results.map((item) => [item.toolCallId, item.result.status]), [
		["first-ready-call", "completed"],
	]);
	assert.equal(f.runner.calls.length, before + 1);
	assert.equal(f.runner.calls.filter((call) => call.task === "first-ready").length, 1);
	assert.equal(namedState(parent, "same-thread").continuation?.toolCallId, "second-paused-call");
	assert.equal(namedState(parent, "same-thread").pending?.status, "interrupted");

	const completed = await f.resume(parent);
	assert.equal(completed.pending, false);
	assert.deepEqual(completed.results.map((item) => [item.toolCallId, item.result.status]), [
		["first-ready-call", "completed"],
		["second-paused-call", "completed"],
	]);
	assert.equal(f.runner.calls.filter((call) => call.task === "first-ready").length, 1);
	assert.equal(f.runner.calls.filter((call) => call.task === "second-paused").length, 3);
});

test("a waiting prior task resumes before the outstanding invocation prompt without losing it", async (t) => {
	const f = fixture(t);
	const parent = f.parent();
	await f.create(parent, "thread");
	f.runner.queue("prior-task", "pending", "pending", "completed");
	await f.invoke(parent, "thread", "prior-task", true);
	f.runner.queue("queued-prompt", "completed");
	const queued = await f.invoke(parent, "thread", "queued-prompt", false, "queued-call");
	assert.equal(queued.result.details.result.status, "pending");
	assert.equal(namedState(parent, "thread").continuation?.prompt, "queued-prompt");
	assert.equal(namedState(parent, "thread").continuation?.phase, "prior");

	const before = f.runner.calls.length;
	const result = await f.resume(parent);
	assert.equal(result.pending, false);
	assert.deepEqual(result.results.map((item) => [item.toolCallId, item.result.task, item.result.status]), [
		["named-call-2", "prior-task", "completed"],
		["queued-call", "queued-prompt", "completed"],
	]);
	assert.deepEqual(f.runner.calls.slice(before).map((call) => call.task), ["prior-task", "queued-prompt"]);
	assert.ok(f.runner.calls[before].resumeFrom);
	assert.ok(f.runner.calls[before + 1].existingSession);
	assert.equal(namedState(parent, "thread").pending, undefined);
	assert.equal(namedState(parent, "thread").continuation?.prompt, "queued-prompt");
});

test("completed siblings and ordinary failures are returned without rerunning", async (t) => {
	const f = fixture(t);
	const parent = f.parent();
	await f.create(parent, "done");
	await f.create(parent, "waiting");
	f.runner.queue("done-task", "completed");
	f.runner.queue("waiting-task", "interrupted", "interrupted", "completed");
	const done = await f.invoke(parent, "done", "done-task", false, "done-call");
	const waiting = await f.invoke(parent, "waiting", "waiting-task", false, "waiting-call");
	assert.equal(done.result.details.result.status, "completed");
	assert.equal(waiting.result.details.result.status, "interrupted");
	const before = f.runner.calls.length;
	const partial = await f.resume(parent);
	assert.equal(partial.pending, true);
	assert.deepEqual(partial.results.map((item) => item.toolCallId), ["done-call"]);
	assert.equal(f.runner.calls.length, before + 1);
	assert.equal(f.runner.calls.filter((call) => call.task === "done-task").length, 1);
	const resumed = await f.resume(parent);
	assert.equal(resumed.pending, false);
	assert.deepEqual(new Set(resumed.results.map((item) => item.toolCallId)), new Set(["done-call", "waiting-call"]));
	assert.equal(f.runner.calls.length, before + 2);
	assert.equal(f.runner.calls.filter((call) => call.task === "done-task").length, 1);
	f.deliver(parent, ["done-call", "waiting-call"]);

	await f.create(parent, "failed");
	f.runner.queue("ordinary-failure", { status: "failed", errorMessage: "ordinary child failure" });
	await f.invoke(parent, "failed", "ordinary-failure", false, "failed-call");
	const failureCalls = f.runner.calls.length;
	const failure = await f.resume(parent);
	assert.equal(failure.pending, false);
	assert.equal(failure.results[0].toolCallId, "failed-call");
	assert.equal(failure.results[0].result.status, "failed");
	assert.equal(failure.results[0].result.errorMessage, "ordinary child failure");
	assert.equal(f.runner.calls.length, failureCalls);
});

test("named continuation preserves live resume handles and honors the destination name lease", async (t) => {
	const f = fixture(t);
	const parent = f.parent();
	await f.create(parent, "leased");
	f.runner.queue("leased-task", { status: "interrupted", pid: process.pid }, "completed");
	await f.invoke(parent, "leased", "leased-task", true, "leased-call");
	const saved = namedState(parent, "leased");
	const owner = dirname(dirname(saved.resume.dir));
	const statePath = join(owner, "leased.json");
	const legacyState = JSON.parse(readFileSync(statePath, "utf8"));
	delete legacyState.continuation;
	delete legacyState.pending;
	writeFileSync(statePath, `${JSON.stringify(legacyState)}\n`);
	for (const entry of parent.getBranch() as any[]) {
		if (entry.type !== "custom" || entry.customType !== "named-subagent-checkpoint"
			|| entry.data?.toolCallId !== "leased-call") continue;
		rmSync(join(owner, "checkpoints", `${entry.data.checkpointId}.json`), { force: true });
	}
	const release = acquireContinuationLease("named:leased", parent.getSessionId());
	const before = f.runner.calls.length;
	try {
		await assert.rejects(f.resume(parent), /already running/);
	} finally {
		release();
	}
	assert.equal(f.runner.calls.length, before);
	const resumed = await f.resume(parent);
	assert.equal(resumed.results[0].result.status, "completed");
	assert.equal(f.runner.calls.length, before + 1);
	assert.equal(f.runner.calls.at(-1)?.resumeFrom?.resume.pid, process.pid);
});

test("continuation is branch-local and does no child or global-name work without an outstanding call", async (t) => {
	const f = fixture(t);
	const parent = f.parent();
	await f.create(parent, "idle-name");
	f.runner.queue("terminal-task", "completed");
	await f.invoke(parent, "idle-name", "terminal-task", true);
	const before = f.runner.calls.length;
	assert.deepEqual(await f.resume(parent), { handled: false, pending: false, results: [] });
	assert.equal(f.runner.calls.length, before);

	const anchor = parent.getLeafId()!;
	f.call(parent, "idle-name", "abandoned", "abandoned-call");
	parent.branch(anchor);
	parent.appendMessage({ role: "user", content: "active branch", timestamp: Date.now() });
	assert.deepEqual(await f.resume(parent), { handled: false, pending: false, results: [] });
	assert.equal(f.runner.calls.length, before);
});

test("fork adoption remaps persisted named continuation handles and leaves the source untouched", async (t) => {
	const f = fixture(t);
	const source = f.parent();
	await f.create(source, "forked");
	f.runner.queue("fork-task", "interrupted", "completed");
	await f.invoke(source, "forked", "fork-task", true, "fork-call");
	const sourceState = namedState(source, "forked");
	const sourceStateBytes = readFileSync(join(dirname(dirname(sourceState.resume.dir)), "forked.json"));
	const sourceChildBytes = readFileSync(sourceState.resume.filePath);
	const destination = fork(source, f.root);

	const before = f.runner.calls.length;
	const result = await f.resume(destination);
	assert.equal(result.pending, false);
	assert.equal(result.results[0].toolCallId, "fork-call");
	assert.equal(f.runner.calls.length, before + 1);
	const inherited = namedState(destination, "forked");
	assert.notEqual(inherited.resume.filePath, sourceState.resume.filePath);
	assert.equal(f.runner.calls.at(-1)?.resumeFrom?.resume.filePath, inherited.resume.filePath);
	assert.equal(inherited.continuation?.result?.resume?.filePath, inherited.resume.filePath);
	assert.deepEqual(readFileSync(sourceState.resume.filePath), sourceChildBytes);
	assert.deepEqual(readFileSync(join(dirname(dirname(sourceState.resume.dir)), "forked.json")), sourceStateBytes);
});

test("legacy quota receipts resume, while missing or ordinary terminal receipts fail closed", async (t) => {
	const f = fixture(t);
	const parent = f.parent();
	await f.create(parent, "legacy-quota");
	f.runner.queue("legacy-quota-task", { status: "failed", errorMessage: "The usage limit has been reached" }, "completed");
	const quota = await f.invoke(parent, "legacy-quota", "legacy-quota-task", true, "legacy-quota-call");
	const quotaResult = quota.result.details.result as SingleResult;
	const quotaMarkers = parent.getBranch().filter((entry: any) => entry.type === "custom"
		&& entry.customType === "named-subagent-checkpoint" && entry.data?.toolCallId === "legacy-quota-call") as any[];
	assert.ok(quotaMarkers.length > 0);
	for (let index = 0; index < quotaMarkers.length; index++) {
		const marker = quotaMarkers[index];
		const checkpointPath = join(dirname(dirname(namedState(parent, "legacy-quota").resume.dir)), "checkpoints", `${marker.data.checkpointId}.json`);
		const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
		delete checkpoint.state.continuation;
		checkpoint.state.pending = index === 0 ? quotaResult : undefined;
		writeFileSync(checkpointPath, `${JSON.stringify(checkpoint)}\n`);
	}
	const quotaStatePath = join(dirname(dirname(namedState(parent, "legacy-quota").resume.dir)), "legacy-quota.json");
	const legacyState = JSON.parse(readFileSync(quotaStatePath, "utf8"));
	delete legacyState.continuation;
	delete legacyState.pending;
	writeFileSync(quotaStatePath, `${JSON.stringify(legacyState)}\n`);
	const quotaCalls = f.runner.calls.length;
	const recovered = await f.resume(parent);
	assert.equal(recovered.results[0].result.status, "completed");
	assert.equal(f.runner.calls.length, quotaCalls + 1);
	assert.equal(f.runner.calls.at(-1)?.resumeFrom?.resume.filePath, quotaResult.resume?.filePath);
	assert.equal(f.runner.calls.at(-1)?.resumeFrom?.resume.baselineEntryId, quotaResult.resume?.baselineEntryId);
	f.deliver(parent, ["legacy-quota-call"]);

	await f.create(parent, "legacy-unknown");
	f.call(parent, "legacy-unknown", "possibly-ran", "missing-receipt-call");
	const unknown = namedState(parent, "legacy-unknown");
	const syntheticCheckpoint = parent.getBranch().find((entry: any) => entry.type === "custom"
		&& entry.customType === "named-subagent-checkpoint" && entry.data?.name === "legacy-unknown") as any;
	parent.appendCustomEntry("named-subagent-checkpoint", { ...syntheticCheckpoint.data, toolCallId: "missing-receipt-call" });
	const unknownCalls = f.runner.calls.length;
	const refused = await f.resume(parent);
	assert.equal(refused.results[0].result.status, "failed");
	assert.match(refused.results[0].result.errorMessage ?? "", /Refusing to restart it blindly/);
	assert.equal(f.runner.calls.length, unknownCalls);
});

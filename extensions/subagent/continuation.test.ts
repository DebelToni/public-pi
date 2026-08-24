import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import subagentExtension, {
	findLatestContinuation,
	repairInterruptedToolCalls,
	resumeContinuation,
	runSingleAgent,
	type ContinuationCandidate,
	type SingleResult,
	type SubagentDetails,
} from "./index.ts";
import { writeResumableForkSession } from "./fork-context.ts";
import { CONTINUATION_MANIFEST_VERSION, readContinuationManifest, writeContinuationManifest } from "./continuation-store.ts";
import {
	CONTINUATION_REQUEST_CHANNEL,
	type ContinuationRequest,
} from "../lib/continuation-request.ts";

function createEventBus() {
	const handlers = new Map<string, Set<(value: unknown) => void>>();
	return {
		on(channel: string, handler: (value: unknown) => void) {
			const listeners = handlers.get(channel) ?? new Set();
			listeners.add(handler);
			handlers.set(channel, listeners);
			return () => listeners.delete(handler);
		},
		emit(channel: string, value: unknown) {
			for (const handler of handlers.get(channel) ?? []) handler(value);
		},
	};
}

const emptyUsage = () => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	contextTokens: 0,
	turns: 0,
});

function makeDetails(results: SingleResult[]): SubagentDetails {
	return {
		mode: "single",
		agentScope: "user",
		projectAgentsDir: null,
		results,
		...(results.some((result) => result.status === "interrupted" || result.status === "pending")
			? { continuationId: "call-1" }
			: {}),
	};
}

function writeFakeChild(directory: string) {
	const filePath = path.join(directory, "fake-child.mjs");
	writeFileSync(filePath, `
import { appendFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const sessionPath = args[args.indexOf("--session") + 1];
const prompt = args[args.length - 1];
if (process.env.PI_SUBAGENT_FAKE_LOG) appendFileSync(process.env.PI_SUBAGENT_FAKE_LOG, prompt + "\\n");
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function append(message) {
  const records = readFileSync(sessionPath, "utf8").trim().split("\\n").map(JSON.parse);
  const parent = [...records].reverse().find((record) => record.id)?.id ?? null;
  appendFileSync(sessionPath, JSON.stringify({ type: "message", id: randomUUID(), parentId: parent, timestamp: new Date().toISOString(), message }) + "\\n");
}
function emit(message) {
  append(message);
  process.stdout.write(JSON.stringify({ type: "message_end", message }) + "\\n");
}
function user(text) {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}
function assistant(text, stopReason) {
  return { role: "assistant", content: text ? [{ type: "text", text }] : [], api: "fake", provider: "fake", model: "fake-1", usage, stopReason, timestamp: Date.now() };
}

emit(user(prompt));
if (!prompt.startsWith("Task: ") && process.env.PI_SUBAGENT_FAKE_RESUME_HANG !== "1") {
  emit(assistant("finished after resume", "stop"));
  process.exit(0);
}
if (prompt === "Task: pending work") {
  emit(assistant("pending task received", "stop"));
  process.exit(0);
}
if (prompt.startsWith("Task: finish ")) {
  emit(assistant(prompt.slice("Task: ".length), "stop"));
  process.exit(0);
}
emit(assistant(prompt.startsWith("Task: ") ? "partial child progress" : "partial resume progress", "toolUse"));
let stopping = false;
process.on("SIGTERM", () => {
  if (stopping) return;
  stopping = true;
  emit(assistant("checkpoint saved on abort", "aborted"));
  process.exit(0);
});
setInterval(() => {}, 1000);
`, { mode: 0o700 });
	return filePath;
}

function writeQuotaRecoveringChild(directory: string) {
	const filePath = path.join(directory, "quota-recovering-child.mjs");
	const logPath = path.join(directory, "quota-child.log");
	const autoRecoveryModule = new URL("../codex-seat-automation/recovery.ts", import.meta.url).href;
	const continuationModule = new URL("../lib/continuation-request.ts", import.meta.url).href;
	writeFileSync(filePath, `
import { appendFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { installAutoRecovery } from ${JSON.stringify(autoRecoveryModule)};
import { CONTINUATION_REQUEST_CHANNEL } from ${JSON.stringify(continuationModule)};

const logPath = ${JSON.stringify(logPath)};
const args = process.argv.slice(2);
const sessionPath = args[args.indexOf("--session") + 1];
const prompt = args[args.length - 1];
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const log = (text) => appendFileSync(logPath, text + "\\n");

function append(message) {
  const records = readFileSync(sessionPath, "utf8").trim().split("\\n").map(JSON.parse);
  const parent = [...records].reverse().find((record) => record.id)?.id ?? null;
  appendFileSync(sessionPath, JSON.stringify({ type: "message", id: randomUUID(), parentId: parent, timestamp: new Date().toISOString(), message }) + "\\n");
}
function emitMessage(message) {
  append(message);
  process.stdout.write(JSON.stringify({ type: "message_end", message }) + "\\n");
}
function user(text) {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}
function success(text, provider = "fake") {
  return { role: "assistant", content: [{ type: "text", text }], api: provider === "fake" ? "fake" : "openai-codex-responses", provider, model: "gpt-5.6-sol", usage, stopReason: "stop", timestamp: Date.now() };
}
function quota(provider) {
  return { role: "assistant", content: [], api: "openai-codex-responses", provider, model: "gpt-5.6-sol", usage, stopReason: "error", errorMessage: "Codex error: The usage limit has been reached", timestamp: Date.now() };
}

log("invoke:" + prompt);
emitMessage(user(prompt));
if (prompt === "Task: completed sibling") {
  emitMessage(success("completed sibling result"));
  process.exit(0);
}

const lifecycle = new Map();
const channels = new Map();
const bus = {
  on(channel, handler) {
    const handlers = channels.get(channel) ?? new Set();
    handlers.add(handler);
    channels.set(channel, handlers);
    return () => handlers.delete(handler);
  },
  emit(channel, value) {
    for (const handler of channels.get(channel) ?? []) handler(value);
  },
};
let idle = false;
let generation = 0;
let state;
let activeProvider = "codex-pi9";
const syncIds = new Map([[activeProvider, "sync-9"]]);
const context = {
  mode: "json",
  model: { provider: activeProvider, id: "gpt-5.6-sol" },
  isIdle: () => idle,
  ui: { setStatus() {}, notify() {} },
};
const pi = {
  events: bus,
  on(event, handler) {
    const handlers = lifecycle.get(event) ?? [];
    handlers.push(handler);
    lifecycle.set(event, handlers);
  },
  registerCommand() {},
};
async function emitLifecycle(event, value = {}) {
  for (const handler of lifecycle.get(event) ?? []) await handler({ type: event, ...value }, context);
}

installAutoRecovery(pi, {
  readEnabled: () => true,
  readState: () => state,
  readSyncId: (provider) => syncIds.get(provider),
  join: async (provider, model, requestSyncId) => {
    generation++;
    state = { version: 1, generation, status: "switching", failedProvider: provider, failedModel: model, failedSyncId: requestSyncId, startedAt: Date.now(), leaderPid: process.pid };
    log("generation:" + generation + ":" + provider);
    return { action: "leader", state };
  },
  abandon: async () => ({ abandoned: false, state }),
  complete: async (completedGeneration, result, selection, failureCode) => {
    if (result !== "succeeded" || failureCode || !selection) throw new Error("fake recovery failed");
    state = { ...state, status: "succeeded", selectedProvider: selection.provider, selectedModel: selection.model, selectedSyncId: selection.syncId };
    return { committed: completedGeneration === generation, state };
  },
  setEnabled: async (enabled) => ({ config: { version: 1, enabled } }),
  readStatus: async () => ({ config: { version: 1, enabled: true }, state, syncId: syncIds.get(activeProvider) }),
  confirmFailedUsage: async () => ({ score: 0, label: "rate limit reached" }),
  selectReplacement: async (_pi, selectedContext, model, guard) => {
    if (!guard()) throw new Error("selection guard rejected fake recovery");
    activeProvider = "codex-pi" + (9 + generation);
    const syncId = "sync-" + (9 + generation);
    syncIds.set(activeProvider, syncId);
    selectedContext.model = { provider: activeProvider, id: model };
    return { provider: activeProvider, modelId: model, syncId };
  },
  isProcessAlive: () => true,
});

let continuations = 0;
let disposed = false;
async function runContinuation(number) {
  await sleep(number === 1 ? 20 : 150);
  if (disposed) {
    log("continuation-after-dispose:" + number);
    return;
  }
  if (number === 1) {
    await emitLifecycle("before_provider_request");
    const message = quota(activeProvider);
    emitMessage(message);
    await emitLifecycle("message_end", { message });
    idle = true;
    await emitLifecycle("agent_settled");
    log("continuation-settled:" + number);
    return;
  }
  const message = success("recovered child result", activeProvider);
  log("result:recovered");
  emitMessage(message);
  await emitLifecycle("message_end", { message });
  idle = true;
  await emitLifecycle("agent_settled");
  log("continuation-settled:" + number);
}
bus.on(CONTINUATION_REQUEST_CHANNEL, (request) => {
  continuations++;
  log("continuation:" + continuations + ":" + String(request.target));
  if (request.target !== "main") {
    request.run = Promise.reject(new Error("generic continuation selected"));
    return;
  }
  idle = false;
  request.run = runContinuation(continuations).catch((error) => {
    idle = true;
    process.stderr.write(String(error?.stack ?? error) + "\\n");
    process.exitCode = 1;
  });
});

await emitLifecycle("before_provider_request");
const initial = quota(activeProvider);
emitMessage(initial);
await emitLifecycle("message_end", { message: initial });
idle = true;
await emitLifecycle("agent_settled");
log("settled:initial");
disposed = true;
await emitLifecycle("session_shutdown");
log("exit:recovered");
`, { mode: 0o700 });
	return { filePath, logPath };
}

function invocationFor(fakeChild: string) {
	return (args: string[]) => ({ command: process.execPath, args: [fakeChild, ...args] });
}

const agent: AgentConfig = {
	name: "test-agent",
	description: "test",
	tools: [],
	model: "fake/fake-1",
	systemPrompt: "",
	source: "user",
	filePath: "/tmp/test-agent.md",
};

function completedResult(task: string, output: string, step?: number): SingleResult {
	return {
		agent: agent.name,
		agentSource: "user",
		task,
		exitCode: 0,
		messages: [{
			role: "assistant",
			content: [{ type: "text", text: output }],
			api: "fake",
			provider: "fake",
			model: "fake-1",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: Date.now(),
		} as any],
		stderr: "",
		usage: emptyUsage(),
		stopReason: "stop",
		status: "completed",
		step,
	};
}

async function interruptTask(temporary: string, fakeChild: string, task: string, step?: number) {
	const controller = new AbortController();
	let requestedAbort = false;
	return runSingleAgent(
		temporary,
		[agent],
		agent.name,
		task,
		undefined,
		"none",
		agent.model,
		undefined,
		step,
		controller.signal,
		(partial) => {
			if (!requestedAbort && (partial.details?.results[0]?.messages.length ?? 0) > 0) {
				requestedAbort = true;
				controller.abort();
			}
		},
		makeDetails,
		{ runsRoot: path.join(temporary, "runs"), invocation: invocationFor(fakeChild) },
	);
}

test("quota-failed one-shot child recovers in place while its parent preserves completed siblings", async () => {
	const temporary = path.join("/tmp", `pi-subagent-quota-recovery-${process.pid}-${Date.now()}`);
	const configDir = path.join(temporary, "config");
	mkdirSync(path.join(configDir, "agents"), { recursive: true });
	writeFileSync(path.join(configDir, "agents", "test-agent.md"), `---\nname: test-agent\ndescription: test\ntools: read\nmodel: fake/fake-1\n---\nTest agent.\n`);
	const child = writeQuotaRecoveringChild(temporary);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousScript = process.argv[1];
	process.env.PI_CODING_AGENT_DIR = configDir;
	process.argv[1] = child.filePath;
	let tool: any;
	let latestDetails: SubagentDetails | undefined;
	let executionSettled = false;
	try {
		subagentExtension({
			events: createEventBus(),
			registerTool(value: any) { tool = value; },
			registerCommand() {},
			on() {},
			appendEntry() {},
		} as unknown as ExtensionAPI);
		const execution = tool.execute(
			"quota-parent-call",
			{
				tasks: [
					{ agent: "test-agent", task: "completed sibling", contextMode: "none" },
					{ agent: "test-agent", task: "recover twice", contextMode: "none" },
				],
				agentScope: "user",
				contextMode: "none",
			},
			new AbortController().signal,
			(update: { details?: SubagentDetails }) => { latestDetails = update.details; },
			{
				cwd: temporary,
				hasUI: false,
				sessionManager: {
					getSessionId: () => "parent-session",
					getSessionFile: () => undefined,
					getLeafId: () => "parent-assistant-entry",
				},
			},
		).then((result: any) => {
			executionSettled = true;
			return result;
		});

		const deadline = Date.now() + 2000;
		while (
			(!existsSync(child.logPath) || !readFileSync(child.logPath, "utf8").includes("continuation:2:main")) &&
			Date.now() < deadline
		) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.ok(existsSync(child.logPath));
		assert.match(readFileSync(child.logPath, "utf8"), /continuation:2:main/);
		assert.equal(latestDetails?.results[0]?.status, "completed");
		assert.equal(latestDetails?.results[1]?.status, "running");
		assert.equal(executionSettled, false);

		const result = await execution;
		assert.deepEqual(result.details.results.map((item: SingleResult) => item.status), ["completed", "completed"]);
		const recovered = result.details.results[1] as SingleResult;
		const finalContent = recovered.messages.at(-1)?.content;
		assert.equal(
			Array.isArray(finalContent) ? finalContent.find((part) => part.type === "text")?.text : undefined,
			"recovered child result",
		);
		assert.match(result.content[0].text, /Parallel: 2\/2 succeeded/);

		const lines = readFileSync(child.logPath, "utf8").trim().split("\n");
		assert.equal(lines.filter((line) => line === "invoke:Task: completed sibling").length, 1);
		assert.equal(lines.filter((line) => line === "invoke:Task: recover twice").length, 1);
		assert.deepEqual(lines.filter((line) => line.startsWith("continuation:")), [
			"continuation:1:main",
			"continuation:2:main",
		]);
		assert.deepEqual(lines.filter((line) => line.startsWith("generation:")), [
			"generation:1:codex-pi9",
			"generation:2:codex-pi10",
		]);
		const resultIndex = lines.indexOf("result:recovered");
		const nestedContinuationSettledIndex = lines.indexOf("continuation-settled:2");
		const outerContinuationSettledIndex = lines.indexOf("continuation-settled:1");
		const settledIndex = lines.indexOf("settled:initial");
		const exitIndex = lines.indexOf("exit:recovered");
		assert.ok(
			resultIndex >= 0 &&
			resultIndex < nestedContinuationSettledIndex &&
			nestedContinuationSettledIndex < outerContinuationSettledIndex &&
			outerContinuationSettledIndex < settledIndex &&
			settledIndex < exitIndex,
		);
		assert.equal(lines.some((line) => line.startsWith("continuation-after-dispose:")), false);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		process.argv[1] = previousScript;
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("aborted child keeps a private session and resumes to completion", async () => {
	const temporary = path.join(os.tmpdir(), `pi-subagent-continuation-${process.pid}-${Date.now()}`);
	const runsRoot = path.join(temporary, "runs");
	mkdirSync(path.join(temporary, ".pi", "agents"), { recursive: true });
	writeFileSync(path.join(temporary, ".pi", "agents", "test-agent.md"), `---\nname: test-agent\ndescription: test\ntools: read\nmodel: fake/fake-1\n---\nTest agent.\n`);
	const fakeChild = writeFakeChild(temporary);
	const controller = new AbortController();
	let requestedAbort = false;
	try {
		const interrupted = await runSingleAgent(
			temporary,
			[agent],
			agent.name,
			"do the work",
			undefined,
			"none",
			agent.model,
			undefined,
			undefined,
			controller.signal,
			(partial) => {
				const messages = partial.details?.results[0]?.messages ?? [];
				if (!requestedAbort && messages.some((message) => message.role === "assistant")) {
					requestedAbort = true;
					controller.abort();
				}
			},
			makeDetails,
			{ runsRoot, invocation: invocationFor(fakeChild) },
		);

		assert.equal(interrupted.status, "interrupted");
		assert.equal(interrupted.stopReason, "aborted");
		assert.equal(interrupted.exitCode, 130);
		assert.ok(interrupted.resume);
		assert.equal(statSync(runsRoot).mode & 0o777, 0o700);
		assert.equal(statSync(interrupted.resume!.dir).mode & 0o777, 0o700);
		assert.equal(statSync(interrupted.resume!.filePath).mode & 0o777, 0o600);
		assert.match(readFileSync(interrupted.resume!.filePath, "utf8"), /checkpoint saved on abort/);

		const candidate: ContinuationCandidate = {
			id: "call-1",
			toolCallEntryId: "missing-entry",
			args: { agent: "test-agent", task: "do the work", agentScope: "project", contextMode: "none" },
			details: {
				mode: "single",
				agentScope: "project",
				projectAgentsDir: path.join(temporary, ".pi", "agents"),
				results: [interrupted],
				continuationId: "call-1",
			},
		};
		const completed = await resumeContinuation(
			candidate,
			{
				cwd: temporary,
				sessionManager: {
					getEntries: () => [],
					getSessionFile: () => undefined,
				},
			},
			new AbortController().signal,
			() => {},
			{ runsRoot, invocation: invocationFor(fakeChild) },
		);
		assert.equal(completed.results[0].status, "completed");
		assert.equal(completed.continuationId, undefined);
		assert.equal(completed.results[0].resume, undefined);
		assert.match(JSON.stringify(completed.results[0].messages), /finished after resume/);
		assert.equal(existsSync(interrupted.resume!.dir), false);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("aborting a resumed child leaves the same continuation resumable again", async () => {
	const temporary = path.join(os.tmpdir(), `pi-subagent-repeat-${process.pid}-${Date.now()}`);
	mkdirSync(temporary, { recursive: true });
	const fakeChild = writeFakeChild(temporary);
	try {
		const first = await interruptTask(temporary, fakeChild, "repeat work");
		assert.equal(first.status, "interrupted");
		const originalSession = first.resume!.filePath;
		process.env.PI_SUBAGENT_FAKE_RESUME_HANG = "1";
		const controller = new AbortController();
		let aborted = false;
		const second = await runSingleAgent(
			temporary,
			[agent],
			agent.name,
			"repeat work",
			undefined,
			"none",
			agent.model,
			undefined,
			undefined,
			controller.signal,
			(partial) => {
				if (!aborted && JSON.stringify(partial.details).includes("partial resume progress")) {
					aborted = true;
					controller.abort();
				}
			},
			makeDetails,
			{ resumeFrom: first, runsRoot: path.join(temporary, "runs"), invocation: invocationFor(fakeChild) },
		);
		assert.equal(second.status, "interrupted");
		assert.equal(second.resume?.filePath, originalSession);
		delete process.env.PI_SUBAGENT_FAKE_RESUME_HANG;
		const completed = await runSingleAgent(
			temporary,
			[agent],
			agent.name,
			"repeat work",
			undefined,
			"none",
			agent.model,
			undefined,
			undefined,
			new AbortController().signal,
			undefined,
			makeDetails,
			{ resumeFrom: second, runsRoot: path.join(temporary, "runs"), invocation: invocationFor(fakeChild) },
		);
		assert.equal(completed.status, "completed");
		assert.equal(existsSync(first.resume!.dir), false);
	} finally {
		delete process.env.PI_SUBAGENT_FAKE_RESUME_HANG;
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("parallel continuation skips completed siblings and resumes interrupted and pending work", async () => {
	const temporary = path.join(os.tmpdir(), `pi-subagent-parallel-${process.pid}-${Date.now()}`);
	mkdirSync(path.join(temporary, ".pi", "agents"), { recursive: true });
	writeFileSync(path.join(temporary, ".pi", "agents", "test-agent.md"), `---\nname: test-agent\ndescription: test\ntools: read\nmodel: fake/fake-1\n---\nTest agent.\n`);
	const fakeChild = writeFakeChild(temporary);
	const logPath = path.join(temporary, "invocations.log");
	try {
		const interrupted = await interruptTask(temporary, fakeChild, "interrupted work");
		const alreadyAborted = new AbortController();
		alreadyAborted.abort();
		const pending = await runSingleAgent(
			temporary,
			[agent],
			agent.name,
			"pending work",
			undefined,
			"none",
			agent.model,
			undefined,
			undefined,
			alreadyAborted.signal,
			undefined,
			makeDetails,
			{ runsRoot: path.join(temporary, "runs"), invocation: invocationFor(fakeChild) },
		);
		writeFileSync(logPath, "");
		process.env.PI_SUBAGENT_FAKE_LOG = logPath;
		const candidate: ContinuationCandidate = {
			id: "parallel-call",
			toolCallEntryId: "missing-entry",
			args: {
				tasks: [
					{ agent: agent.name, task: "completed work" },
					{ agent: agent.name, task: "interrupted work" },
					{ agent: agent.name, task: "pending work" },
				],
				agentScope: "project",
				contextMode: "none",
			},
			details: {
				mode: "parallel",
				agentScope: "project",
				projectAgentsDir: path.join(temporary, ".pi", "agents"),
				results: [completedResult("completed work", "done one"), interrupted, pending],
				continuationId: "parallel-call",
			},
		};
		const details = await resumeContinuation(
			candidate,
			{ cwd: temporary, sessionManager: { getEntries: () => [], getSessionFile: () => undefined } },
			new AbortController().signal,
			() => {},
			{ runsRoot: path.join(temporary, "runs"), invocation: invocationFor(fakeChild) },
		);
		assert.deepEqual(details.results.map((result) => result.status), ["completed", "completed", "completed"]);
		assert.match(JSON.stringify(details.results[0].messages), /done one/);
		const invocations = readFileSync(logPath, "utf8");
		assert.doesNotMatch(invocations, /Task: completed work/);
		assert.match(invocations, /Continue the original delegated task/);
		assert.match(invocations, /Task: pending work/);
	} finally {
		delete process.env.PI_SUBAGENT_FAKE_LOG;
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("chain continuation resumes its interrupted step and preserves previous output for later steps", async () => {
	const temporary = path.join(os.tmpdir(), `pi-subagent-chain-${process.pid}-${Date.now()}`);
	mkdirSync(path.join(temporary, ".pi", "agents"), { recursive: true });
	writeFileSync(path.join(temporary, ".pi", "agents", "test-agent.md"), `---\nname: test-agent\ndescription: test\ntools: read\nmodel: fake/fake-1\n---\nTest agent.\n`);
	const fakeChild = writeFakeChild(temporary);
	const logPath = path.join(temporary, "invocations.log");
	try {
		const interrupted = await interruptTask(temporary, fakeChild, "interrupt seed-output", 2);
		writeFileSync(logPath, "");
		process.env.PI_SUBAGENT_FAKE_LOG = logPath;
		const candidate: ContinuationCandidate = {
			id: "chain-call",
			toolCallEntryId: "missing-entry",
			args: {
				chain: [
					{ agent: agent.name, task: "produce" },
					{ agent: agent.name, task: "interrupt {previous}" },
					{ agent: agent.name, task: "finish {previous}" },
				],
				agentScope: "project",
				contextMode: "none",
			},
			details: {
				mode: "chain",
				agentScope: "project",
				projectAgentsDir: path.join(temporary, ".pi", "agents"),
				results: [completedResult("produce", "seed-output", 1), interrupted],
				continuationId: "chain-call",
			},
		};
		const details = await resumeContinuation(
			candidate,
			{ cwd: temporary, sessionManager: { getEntries: () => [], getSessionFile: () => undefined } },
			new AbortController().signal,
			() => {},
			{ runsRoot: path.join(temporary, "runs"), invocation: invocationFor(fakeChild) },
		);
		assert.equal(details.results.length, 3);
		assert.equal(details.results[1].task, "interrupt seed-output");
		assert.equal(details.results[2].task, "finish finished after resume");
		assert.match(JSON.stringify(details.results[2].messages), /finish finished after resume/);
		const invocations = readFileSync(logPath, "utf8");
		assert.doesNotMatch(invocations, /Task: produce/);
		assert.match(invocations, /Continue the original delegated task/);
		assert.match(invocations, /Task: finish finished after resume/);
	} finally {
		delete process.env.PI_SUBAGENT_FAKE_LOG;
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("an already-aborted signal creates a pending checkpoint that later receives the original task", async () => {
	const temporary = path.join(os.tmpdir(), `pi-subagent-pending-${process.pid}-${Date.now()}`);
	mkdirSync(temporary, { recursive: true });
	const fakeChild = writeFakeChild(temporary);
	const controller = new AbortController();
	controller.abort();
	let spawned = false;
	try {
		const result = await runSingleAgent(
			temporary,
			[agent],
			agent.name,
			"pending work",
			undefined,
			"none",
			agent.model,
			undefined,
			undefined,
			controller.signal,
			undefined,
			makeDetails,
			{
				runsRoot: path.join(temporary, "runs"),
				invocation: () => {
					spawned = true;
					return { command: "false", args: [] };
				},
			},
		);
		assert.equal(result.status, "pending");
		assert.ok(result.resume?.filePath);
		assert.equal(spawned, false);
		const pausedAgain = new AbortController();
		pausedAgain.abort();
		const stillPending = await runSingleAgent(
			temporary,
			[agent],
			agent.name,
			"pending work",
			undefined,
			"none",
			agent.model,
			undefined,
			undefined,
			pausedAgain.signal,
			undefined,
			makeDetails,
			{ resumeFrom: result, runsRoot: path.join(temporary, "runs"), invocation: invocationFor(fakeChild) },
		);
		assert.equal(stillPending.status, "pending");
		const completed = await runSingleAgent(
			temporary,
			[agent],
			agent.name,
			"pending work",
			undefined,
			"none",
			agent.model,
			undefined,
			undefined,
			new AbortController().signal,
			undefined,
			makeDetails,
			{
				resumeFrom: stillPending,
				runsRoot: path.join(temporary, "runs"),
				invocation: invocationFor(fakeChild),
			},
		);
		assert.equal(completed.status, "completed");
		assert.match(JSON.stringify(completed.messages), /pending task received/);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("restart recovery uses a terminal child transcript without spawning or replaying work", async () => {
	const temporary = path.join(os.tmpdir(), `pi-subagent-terminal-recovery-${process.pid}-${Date.now()}`);
	try {
		const session = await writeResumableForkSession(temporary, [], undefined, path.join(temporary, "runs"));
		const manager = SessionManager.open(session.filePath);
		manager.appendMessage({ role: "user", content: [{ type: "text", text: "Task: terminal work" }], timestamp: Date.now() });
		manager.appendMessage(completedResult("terminal work", "durable terminal output").messages[0] as any);
		let spawned = false;
		const prior: SingleResult = {
			agent: agent.name,
			agentSource: "user",
			task: "terminal work",
			exitCode: 130,
			messages: [],
			stderr: "",
			usage: emptyUsage(),
			status: "interrupted",
			stopReason: "aborted",
			resume: session,
		};
		const recovered = await runSingleAgent(
			temporary,
			[agent],
			agent.name,
			"terminal work",
			undefined,
			"none",
			agent.model,
			undefined,
			undefined,
			new AbortController().signal,
			undefined,
			makeDetails,
			{
				resumeFrom: prior,
				runsRoot: path.join(temporary, "runs"),
				invocation: () => {
					spawned = true;
					return { command: "false", args: [] };
				},
			},
		);
		assert.equal(recovered.status, "completed");
		assert.equal(spawned, false);
		assert.match(JSON.stringify(recovered.messages), /durable terminal output/);
		assert.equal(existsSync(session.dir), false);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("terminal recovery ignores matching task text inherited before the child boundary", async () => {
	const temporary = path.join(os.tmpdir(), `pi-subagent-boundary-${process.pid}-${Date.now()}`);
	mkdirSync(temporary, { recursive: true });
	const fakeChild = writeFakeChild(temporary);
	try {
		const inherited = [
			{ role: "user", content: [{ type: "text", text: "Task: boundary work" }], timestamp: 1 },
			completedResult("boundary work", "parent answer").messages[0],
		] as any;
		const session = await writeResumableForkSession(temporary, inherited, undefined, path.join(temporary, "runs"));
		let spawned = false;
		const prior: SingleResult = {
			agent: agent.name,
			agentSource: "user",
			task: "boundary work",
			exitCode: 130,
			messages: [],
			stderr: "",
			usage: emptyUsage(),
			status: "interrupted",
			stopReason: "aborted",
			resume: session,
		};
		const result = await runSingleAgent(
			temporary,
			[agent],
			agent.name,
			"boundary work",
			undefined,
			"none",
			agent.model,
			undefined,
			undefined,
			new AbortController().signal,
			undefined,
			makeDetails,
			{
				resumeFrom: prior,
				runsRoot: path.join(temporary, "runs"),
				invocation: (args) => {
					spawned = true;
					return invocationFor(fakeChild)(args);
				},
			},
		);
		assert.equal(spawned, true);
		assert.equal(result.status, "completed");
		assert.match(JSON.stringify(result.messages), /finished after resume/);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("restart recovery refuses to race a still-live prior child process", async () => {
	const temporary = path.join(os.tmpdir(), `pi-subagent-live-child-${process.pid}-${Date.now()}`);
	try {
		const session = await writeResumableForkSession(temporary, [], undefined, path.join(temporary, "runs"));
		let spawned = false;
		const prior: SingleResult = {
			agent: agent.name,
			agentSource: "user",
			task: "live work",
			exitCode: 130,
			messages: [],
			stderr: "",
			usage: emptyUsage(),
			status: "interrupted",
			stopReason: "aborted",
			resume: { ...session, pid: process.pid },
		};
		const result = await runSingleAgent(
			temporary,
			[agent],
			agent.name,
			"live work",
			undefined,
			"none",
			agent.model,
			undefined,
			undefined,
			new AbortController().signal,
			undefined,
			makeDetails,
			{
				resumeFrom: prior,
				runsRoot: path.join(temporary, "runs"),
				invocation: () => {
					spawned = true;
					return { command: "false", args: [] };
				},
			},
		);
		assert.equal(result.status, "interrupted");
		assert.match(result.errorMessage ?? "", /still running/);
		assert.equal(spawned, false);
		assert.equal(existsSync(session.dir), true);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("a child killed by a signal is retained as interrupted", async () => {
	const temporary = path.join(os.tmpdir(), `pi-subagent-signaled-${process.pid}-${Date.now()}`);
	mkdirSync(temporary, { recursive: true });
	const signalChild = path.join(temporary, "signal-child.mjs");
	writeFileSync(signalChild, `process.kill(process.pid, "SIGTERM"); setInterval(() => {}, 1000);`);
	try {
		const result = await runSingleAgent(
			temporary,
			[agent],
			agent.name,
			"signaled work",
			undefined,
			"none",
			agent.model,
			undefined,
			undefined,
			new AbortController().signal,
			undefined,
			makeDetails,
			{ runsRoot: path.join(temporary, "runs"), invocation: (args) => ({ command: process.execPath, args: [signalChild, ...args] }) },
		);
		assert.equal(result.status, "interrupted");
		assert.equal(result.exitCode, 130);
		assert.ok(result.resume?.filePath);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("resume repairs an interrupted child tool call exactly once", async () => {
	const temporary = path.join(os.tmpdir(), `pi-subagent-repair-${process.pid}-${Date.now()}`);
	try {
		const session = await writeResumableForkSession("/tmp", [], undefined, path.join(temporary, "runs"));
		const manager = SessionManager.open(session.filePath);
		manager.appendMessage({ role: "user", content: [{ type: "text", text: "work" }], timestamp: Date.now() });
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "touch /tmp/example" } }],
			api: "fake",
			provider: "fake",
			model: "fake",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse",
			timestamp: Date.now(),
		} as any);
		assert.equal(repairInterruptedToolCalls(session.filePath), 1);
		assert.equal(repairInterruptedToolCalls(session.filePath), 0);
		const last = SessionManager.open(session.filePath).buildSessionContext().messages.at(-1) as any;
		assert.equal(last.role, "toolResult");
		assert.equal(last.toolCallId, "tool-1");
		assert.equal(last.isError, true);
		SessionManager.open(session.filePath).appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "partial-tool", name: "bash", arguments: { command: "echo partial" } }],
			api: "fake",
			provider: "fake",
			model: "fake",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "aborted",
			timestamp: Date.now(),
		} as any);
		assert.equal(repairInterruptedToolCalls(session.filePath), 0);
		const reopened = SessionManager.open(session.filePath);
		reopened.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "superseded-tool", name: "bash", arguments: { command: "echo old" } }],
			api: "fake",
			provider: "fake",
			model: "fake",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse",
			timestamp: Date.now(),
		} as any);
		reopened.appendMessage({
			role: "assistant",
			content: [],
			api: "fake",
			provider: "fake",
			model: "fake",
			usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "aborted",
			timestamp: Date.now(),
		} as any);
		assert.equal(repairInterruptedToolCalls(session.filePath), 0);
		assert.equal((SessionManager.open(session.filePath).buildSessionContext().messages.at(-1) as any).role, "assistant");
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("continuation lookup is branch-scoped and honors completed state", () => {
	const temporary = path.join(os.tmpdir(), `pi-subagent-branch-lookup-${process.pid}-${Date.now()}`);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = temporary;
	try {
	const interrupted: SingleResult = {
		agent: "test-agent",
		agentSource: "user",
		task: "work",
		exitCode: 130,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		stopReason: "aborted",
		status: "interrupted",
		resume: { runId: "run", dir: "/tmp/run", filePath: "/tmp/run/session.jsonl", baselineEntryId: "baseline" },
	};
	const details: SubagentDetails = {
		mode: "single",
		agentScope: "user",
		projectAgentsDir: null,
		results: [interrupted],
		continuationId: "call-1",
	};
	const entries: any[] = [
		{
			type: "message",
			id: "assistant-entry",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "subagent", arguments: { agent: "test-agent", task: "work" } }],
			},
		},
		{
			type: "message",
			id: "result-entry",
			message: { role: "toolResult", toolName: "subagent", toolCallId: "call-1", details },
		},
	];
	assert.equal(findLatestContinuation(entries)?.id, "call-1");
	entries.push({
		type: "custom",
		customType: "subagent-continuation",
		data: { id: "call-1", status: "completed", details, updatedAt: Date.now() },
	});
	assert.equal(findLatestContinuation(entries), undefined);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("latest unresolved continuation on the active branch wins", () => {
	const temporary = path.join(os.tmpdir(), `pi-subagent-latest-lookup-${process.pid}-${Date.now()}`);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = temporary;
	try {
	const detailsFor = (id: string): SubagentDetails => ({
		mode: "single",
		agentScope: "user",
		projectAgentsDir: null,
		continuationId: id,
		results: [{
			agent: agent.name,
			agentSource: "user",
			task: id,
			exitCode: 130,
			messages: [],
			stderr: "",
			usage: emptyUsage(),
			status: "interrupted",
			stopReason: "aborted",
			resume: { runId: id, dir: `/tmp/${id}`, filePath: `/tmp/${id}/session.jsonl`, baselineEntryId: `baseline-${id}` },
		}],
	});
	const call = (id: string) => ({
		type: "message",
		id: `assistant-${id}`,
		message: { role: "assistant", content: [{ type: "toolCall", id, name: "subagent", arguments: { agent: agent.name, task: id } }] },
	});
	const result = (id: string) => ({
		type: "message",
		id: `result-${id}`,
		message: { role: "toolResult", toolName: "subagent", toolCallId: id, details: detailsFor(id) },
	});
	const sharedBranch = [call("call-1"), result("call-1")];
	const activeBranch = [...sharedBranch, call("call-2"), result("call-2")];
	assert.equal(findLatestContinuation(activeBranch)?.id, "call-2");
	assert.equal(findLatestContinuation(sharedBranch)?.id, "call-1");
	activeBranch.push({
		type: "custom",
		customType: "subagent-continuation",
		data: { id: "call-2", status: "completed", details: detailsFor("call-2"), updatedAt: Date.now() },
	} as any);
	assert.equal(findLatestContinuation(activeBranch)?.id, "call-1");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("a fork sees the source manifest without treating it as the fork's mutable owner", () => {
	const temporary = path.join(os.tmpdir(), `pi-subagent-source-owner-${process.pid}-${Date.now()}`);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = temporary;
	const details: SubagentDetails = {
		mode: "single",
		agentScope: "user",
		projectAgentsDir: null,
		continuationId: "shared-call",
		results: [{
			agent: agent.name,
			agentSource: "user",
			task: "work",
			exitCode: 130,
			messages: [],
			stderr: "",
			usage: emptyUsage(),
			status: "interrupted",
			stopReason: "aborted",
			resume: { runId: "source-run", dir: "/tmp/source-run", filePath: "/tmp/source-run/session.jsonl", baselineEntryId: "baseline" },
		}],
	};
	try {
		writeContinuationManifest({
			version: CONTINUATION_MANIFEST_VERSION,
			id: "shared-call",
			parentSessionId: "source-session",
			parentBranchAnchor: "assistant-entry",
			parentToolCallId: "shared-call",
			mode: "single",
			args: { agent: agent.name, task: "work" },
			details,
			status: "interrupted",
			createdAt: 1,
			updatedAt: 1,
		});
		const branch = [
			{ type: "message", id: "assistant-entry", message: { role: "assistant", content: [{ type: "toolCall", id: "shared-call", name: "subagent", arguments: { agent: agent.name, task: "work" } }] } },
			{ type: "message", id: "result-entry", message: { role: "toolResult", toolName: "subagent", toolCallId: "shared-call", details } },
		];
		const candidate = findLatestContinuation(branch, { sessionId: "fork-session" });
		assert.equal(candidate?.manifest, undefined);
		assert.equal(candidate?.sourceManifest?.parentSessionId, "source-session");
		assert.equal(candidate?.details.results[0].resume?.filePath, "/tmp/source-run/session.jsonl");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("tool execution checkpoints orchestration before a child starts", async () => {
	const temporary = path.join(os.tmpdir(), `pi-subagent-tool-checkpoint-${process.pid}-${Date.now()}`);
	const configDir = path.join(temporary, "config");
	mkdirSync(path.join(configDir, "agents"), { recursive: true });
	writeFileSync(path.join(configDir, "agents", "test-agent.md"), `---\nname: test-agent\ndescription: test\ntools: read\nmodel: fake/fake-1\n---\nTest agent.\n`);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = configDir;
	let tool: any;
	const appended: any[] = [];
	try {
		subagentExtension({
			events: createEventBus(),
			registerTool(value: any) { tool = value; },
			registerCommand() {},
			on() {},
			appendEntry(customType: string, data: any) { appended.push({ customType, data }); },
		} as unknown as ExtensionAPI);
		const controller = new AbortController();
		controller.abort();
		const result = await tool.execute(
			"checkpoint-call",
			{ agent: "test-agent", task: "durable work", contextMode: "none" },
			controller.signal,
			undefined,
			{
				cwd: temporary,
				hasUI: false,
				sessionManager: {
					getSessionId: () => "parent-session",
					getSessionFile: () => path.join(temporary, "parent.jsonl"),
					getLeafId: () => "assistant-entry",
				},
			},
		);
		assert.equal(result.details.continuationId, "checkpoint-call");
		assert.equal(result.details.results[0].status, "pending");
		const manifest = readContinuationManifest<any, SubagentDetails>("checkpoint-call");
		assert.equal(manifest?.status, "interrupted");
		assert.equal(manifest?.parentSessionId, "parent-session");
		assert.equal(manifest?.details.results[0].resume?.filePath, result.details.results[0].resume.filePath);
		assert.equal(appended.at(-1)?.data.status, "interrupted");
		const branch = [
			{
				type: "message",
				id: "assistant-entry",
				message: { role: "assistant", content: [{ type: "toolCall", id: "checkpoint-call", name: "subagent", arguments: { agent: "test-agent", task: "durable work", contextMode: "none" } }] },
			},
			{ type: "message", id: "tool-result", message: { role: "toolResult", toolName: "subagent", toolCallId: "checkpoint-call", details: result.details } },
		];
		assert.equal(findLatestContinuation(branch)?.id, "checkpoint-call");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("successful tool results resolve and clean their durable run at agent end", () => {
	const temporary = path.join(os.tmpdir(), `pi-subagent-cleanup-${process.pid}-${Date.now()}`);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = temporary;
	const details: SubagentDetails = {
		mode: "single",
		agentScope: "user",
		projectAgentsDir: null,
		results: [completedResult("work", "done")],
	};
	const appended: any[] = [];
	let agentEnd: any;
	try {
		writeContinuationManifest({
			version: CONTINUATION_MANIFEST_VERSION,
			id: "cleanup-call",
			parentSessionId: "cleanup-session",
			parentBranchAnchor: "assistant-entry",
			parentToolCallId: "cleanup-call",
			mode: "single",
			args: { agent: agent.name, task: "work" },
			details,
			status: "ready",
			createdAt: 1,
			updatedAt: 1,
		});
		subagentExtension({
			events: createEventBus(),
			registerTool() {},
			registerCommand() {},
			on(event: string, handler: any) { if (event === "agent_end") agentEnd = handler; },
			appendEntry(customType: string, data: any) { appended.push({ customType, data }); },
		} as unknown as ExtensionAPI);
		agentEnd({}, {
			sessionManager: {
				getSessionId: () => "cleanup-session",
				getSessionFile: () => undefined,
				getBranch: () => [{ type: "message", message: { role: "toolResult", toolName: "subagent", toolCallId: "cleanup-call", details } }],
			},
		});
		assert.equal(readContinuationManifest("cleanup-call"), undefined);
		assert.equal(appended.at(-1)?.customType, "subagent-continuation");
		assert.equal(appended.at(-1)?.data.status, "completed");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("completed resumed output is delivered as hidden context and automatically triggers the main model", async () => {
	const temporary = path.join(os.tmpdir(), `pi-subagent-delivery-${process.pid}-${Date.now()}`);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = temporary;
	const details: SubagentDetails = {
		mode: "single",
		agentScope: "user",
		projectAgentsDir: null,
		results: [completedResult("work", "recovered output")],
	};
	const commands = new Map<string, any>();
	const sent: any[] = [];
	const appended: any[] = [];
	let agentEnd: any;
	try {
		writeContinuationManifest({
			version: CONTINUATION_MANIFEST_VERSION,
			id: "delivery-call",
			parentSessionId: "delivery-session",
			parentBranchAnchor: "assistant-entry",
			parentToolCallId: "delivery-call",
			mode: "single",
			args: { agent: agent.name, task: "work" },
			details,
			status: "ready",
			createdAt: 1,
			updatedAt: 1,
		});
		subagentExtension({
			events: createEventBus(),
			registerTool() {},
			registerCommand(name: string, command: any) { commands.set(name, command); },
			on(event: string, handler: any) { if (event === "agent_end") agentEnd = handler; },
			appendEntry(customType: string, data: any) { appended.push({ customType, data }); },
			sendMessage(message: any, options: any) { sent.push({ message, options }); },
		} as unknown as ExtensionAPI);
		await commands.get("continue").handler("", {
			isIdle: () => true,
			mode: "rpc",
			sessionManager: {
				getSessionId: () => "delivery-session",
				getSessionFile: () => undefined,
				getBranch: () => [{
					type: "message",
					id: "assistant-entry",
					message: { role: "assistant", content: [{ type: "toolCall", id: "delivery-call", name: "subagent", arguments: { agent: agent.name, task: "work" } }] },
				}],
			},
			ui: { notify() {}, setStatus() {} },
		});
		assert.equal(sent.length, 2);
		assert.equal(sent[0].message.customType, "subagent-continuation-result");
		assert.equal(sent[0].message.display, false);
		assert.match(sent[0].message.content, /recovered output/);
		assert.deepEqual(sent[0].options, { deliverAs: "steer", triggerTurn: false });
		assert.equal(sent[1].message.customType, "subagent-continuation-trigger");
		assert.deepEqual(sent[1].options, { deliverAs: "steer", triggerTurn: true });
		assert.equal(appended.length, 0);
		assert.equal(sent.some((item) => item.message.role === "toolResult"), false);
		assert.equal(readContinuationManifest("delivery-call")?.status, "ready");
		agentEnd({}, {
			sessionManager: {
				getSessionId: () => "delivery-session",
				getSessionFile: () => undefined,
				getBranch: () => [{
					type: "custom_message",
					customType: "subagent-continuation-result",
					details: { continuationId: "delivery-call" },
				}],
			},
		});
		assert.equal(appended.at(-1)?.data.status, "completed");
		assert.equal(readContinuationManifest("delivery-call")?.status, "resolved");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("a main-target continuation bypasses stale interrupted subagent state", async () => {
	const temporary = path.join(os.tmpdir(), `pi-main-only-continuation-${process.pid}-${Date.now()}`);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = temporary;
	const events = createEventBus();
	const sent: any[] = [];
	const notices: string[] = [];
	let finishSend: (() => void) | undefined;
	const branch = [{
		type: "message",
		id: "old-assistant",
		message: {
			role: "assistant",
			content: [{
				type: "toolCall",
				id: "stale-subagent-call",
				name: "subagent",
				arguments: { agent: agent.name, task: "old interrupted work" },
			}],
		},
	}];
	try {
		subagentExtension({
			events,
			registerTool() {},
			registerCommand() {},
			on() {},
			appendEntry() {},
			sendMessage(message: any, options: any) {
				sent.push({ message, options });
				return new Promise<void>((resolve) => { finishSend = resolve; });
			},
		} as unknown as ExtensionAPI);
		const context = {
			cwd: temporary,
			isIdle: () => true,
			mode: "rpc",
			hasUI: false,
			sessionManager: {
				getSessionId: () => "main-session",
				getSessionFile: () => undefined,
				getBranch: () => branch,
				getEntries: () => branch,
			},
			ui: {
				notify(message: string) { notices.push(message); },
				setStatus() {},
			},
		} as any;
		const request: ContinuationRequest = { context, target: "main" };
		events.emit(CONTINUATION_REQUEST_CHANNEL, request);
		assert.ok(request.run);
		let completed = false;
		void request.run.then(() => { completed = true; });
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(completed, false);
		finishSend?.();
		await request.run;
		assert.equal(completed, true);
		assert.equal(sent.length, 1);
		assert.equal(sent[0].message.customType, "main-continuation");
		assert.deepEqual(sent[0].options, { deliverAs: "steer", triggerTurn: true });
		assert.deepEqual(notices, []);
		assert.equal(readContinuationManifest("stale-subagent-call"), undefined);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("/continue without child state quietly continues the main agent", async () => {
	const temporary = path.join(os.tmpdir(), `pi-subagent-empty-continue-${process.pid}-${Date.now()}`);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = temporary;
	const commands = new Map<string, any>();
	const sent: any[] = [];
	try {
	subagentExtension({
		events: createEventBus(),
		registerTool() {},
		registerCommand(name: string, command: any) { commands.set(name, command); },
		on() {},
		sendMessage(message: any, options: any) { sent.push({ message, options }); },
	} as unknown as ExtensionAPI);
	await commands.get("continue").handler("", {
		isIdle: () => true,
		sessionManager: {
			getSessionId: () => "main-session",
			getSessionFile: () => undefined,
			getBranch: () => [],
		},
		ui: { notify() {} },
	});
	assert.equal(sent.length, 1);
	assert.equal(sent[0].message.customType, "main-continuation");
	assert.equal(sent[0].message.display, false);
	assert.deepEqual(sent[0].options, { deliverAs: "steer", triggerTurn: true });
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(temporary, { recursive: true, force: true });
	}
});

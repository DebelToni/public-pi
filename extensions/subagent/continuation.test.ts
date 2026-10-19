import { readResultPage } from "./result-store.ts";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import subagentExtension, {
	fanInTask,
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
import { SubagentMonitorStore } from "./monitor.ts";
import {
	LEGACY_CONTINUATION_REQUEST_CHANNEL as CONTINUATION_REQUEST_CHANNEL,
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
if (process.env.PI_SUBAGENT_FAKE_LOG) {
  appendFileSync(process.env.PI_SUBAGENT_FAKE_LOG, prompt + "\\n");
  if (process.env.PI_UPSTREAM_SESSION_REFS) {
    const refs = JSON.parse(process.env.PI_UPSTREAM_SESSION_REFS);
    appendFileSync(process.env.PI_SUBAGENT_FAKE_LOG, "SESSION_REFS:" + JSON.stringify(refs) + "\\n");
    appendFileSync(process.env.PI_SUBAGENT_FAKE_LOG, "REFS_EXIST:" + Object.values(refs).every((file) => { try { return readFileSync(file, "utf8").length > 0; } catch { return false; } }) + "\\n");
    appendFileSync(process.env.PI_SUBAGENT_FAKE_LOG, "TOOLS:" + (args[args.indexOf("--tools") + 1] ?? "") + "\\n");
  }
}
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
	const ultraReleaseRoot = realpathSync(
		process.env.PI_CODEX_ULTRA_RELEASE_ROOT ?? path.join(os.homedir(), ".local/share/pi-codex-ultra/current"),
	);
	const recoverySourceRoot = process.env.PI_ULTRA_SOURCE_ROOT ?? ultraReleaseRoot;
	const autoRecoveryModule = pathToFileURL(path.join(
		recoverySourceRoot,
		"suite/modules/codex-seat-automation/recovery.ts",
	)).href;
	const codingAgentRoot = path.join(
		ultraReleaseRoot,
		"node_modules/@earendil-works/pi-coding-agent",
	);
	const dependencyRoot = path.join(codingAgentRoot, "node_modules/@earendil-works");
	const aliases = {
		"@earendil-works/pi-coding-agent": path.join(codingAgentRoot, "dist/index.js"),
		"@earendil-works/pi-agent-core": path.join(dependencyRoot, "pi-agent-core/dist/index.js"),
		"@earendil-works/pi-tui": path.join(dependencyRoot, "pi-tui/dist/index.js"),
		"@earendil-works/pi-ai": path.join(dependencyRoot, "pi-ai/dist/compat.js"),
		"@earendil-works/pi-ai/compat": path.join(dependencyRoot, "pi-ai/dist/compat.js"),
		"@earendil-works/pi-ai/oauth": path.join(dependencyRoot, "pi-ai/dist/oauth.js"),
		"@earendil-works/pi-ai/providers/all": path.join(dependencyRoot, "pi-ai/dist/providers/all.js"),
	};
	const jitiModule = pathToFileURL(path.join(codingAgentRoot, "node_modules/jiti/lib/jiti.mjs")).href;
	const continuationModule = pathToFileURL(path.join(recoverySourceRoot, "suite/modules/codex-seat-automation/continuation-request.ts")).href;
	writeFileSync(filePath, `
import { appendFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createJiti } from ${JSON.stringify(jitiModule)};
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: ${JSON.stringify(aliases)} });
const { installAutoRecovery } = await jiti.import(${JSON.stringify(autoRecoveryModule)});
const { CONTINUATION_REQUEST_CHANNEL } = await jiti.import(${JSON.stringify(continuationModule)});

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
  return { role: "assistant", content: [{ type: "text", text }], api: provider === "fake" ? "fake" : "openai-codex-responses", provider, model: "gpt-6-sol", usage, stopReason: "stop", timestamp: Date.now() };
}
function quota(provider) {
  return { role: "assistant", content: [], api: "openai-codex-responses", provider, model: "gpt-6-sol", usage, stopReason: "error", errorMessage: "Codex error: The usage limit has been reached", timestamp: Date.now() };
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
  model: { provider: activeProvider, id: "gpt-6-sol" },
  isIdle: () => idle,
  ui: { setStatus() {}, notify() {} },
};
const pi = {
  events: bus,
  getThinkingLevel: () => "high",
  on(event, handler) {
    const handlers = lifecycle.get(event) ?? [];
    handlers.push(handler);
    lifecycle.set(event, handlers);
  },
  registerCommand() {},
  registerShortcut() {},
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
  claimContinuation: async () => ({ claimed: true, state }),
  releaseContinuation: async () => ({ released: true }),
  setEnabled: async (enabled) => ({ config: { version: 1, enabled } }),
  readStatus: async () => ({ config: { version: 1, enabled: true }, state, syncId: syncIds.get(activeProvider) }),
  confirmFailedUsage: async () => ({ score: 0, label: "rate limit reached" }),
  selectReplacement: async (_pi, selectedContext, model, _failedProvider, guard) => {
    if (!guard()) throw new Error("selection guard rejected fake recovery");
    activeProvider = "codex-pi" + (9 + generation);
    const syncId = "sync-" + (9 + generation);
    syncIds.set(activeProvider, syncId);
    selectedContext.model = { provider: activeProvider, id: model };
    return { status: "selected", provider: activeProvider, modelId: model, syncId };
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
  log("continuation:" + continuations + ":" + String(request.target ?? "work"));
  request.run = Promise.resolve().then(async () => {
    await request.beforeWork?.("main");
    idle = false;
    request.onStarted?.();
    await runContinuation(continuations);
  }).catch((error) => {
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
			if (!requestedAbort && (partial.details?.results[0]?.transcript?.messageCount ?? 0) > 0) {
				requestedAbort = true;
				controller.abort();
			}
		},
		makeDetails,
		{ runsRoot: path.join(temporary, "runs"), invocation: invocationFor(fakeChild) },
	);
}

test("fan-in handoff preserves replacement metacharacters literally", () => {
	const output = "literal $& $$ $` $'";
	const task = fanInTask("before {previous} after", [completedResult("upstream", output)]);
	assert.match(task, /before The following JSON/);
	assert.ok(task.includes(output));
	assert.match(task, /grep_session_bank with an upstream session ID/);
	assert.match(task, /Both target exactly that upstream session/);
	assert.match(task, /<upstream_subagents>/);
	assert.match(task, /<\/upstream_subagents> after$/);
});

test("large delegated prompts use stdin instead of exceeding process argument limits", async () => {
	const temporary = path.join(os.tmpdir(), `pi-subagent-stdin-${process.pid}-${Date.now()}`);
	mkdirSync(temporary, { recursive: true });
	const child = path.join(temporary, "stdin-child.mjs");
	const log = path.join(temporary, "stdin.json");
	writeFileSync(child, `
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
let stdin = "";
for await (const chunk of process.stdin) stdin += chunk;
const prompt = stdin || args.at(-1) || "";
writeFileSync(${JSON.stringify(log)}, JSON.stringify({ promptLength: prompt.length, tail: prompt.slice(-20), maxArg: Math.max(...args.map((arg) => arg.length)) }));
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const message = { role: "assistant", content: [{ type: "text", text: "received-large-prompt" }], api: "fake", provider: "fake", model: "fake", usage, stopReason: "stop", timestamp: Date.now() };
process.stdout.write(JSON.stringify({ type: "message_end", message }) + "\\n");
`, { mode: 0o700 });
	try {
		const delegatedTask = `${"x".repeat(1_200_000)}PROMPT_TAIL`;
		const result = await runSingleAgent(
			temporary,
			[agent],
			agent.name,
			delegatedTask,
			undefined,
			"none",
			agent.model,
			undefined,
			undefined,
			new AbortController().signal,
			undefined,
			makeDetails,
			{ runsRoot: path.join(temporary, "runs"), invocation: invocationFor(child) },
		);
		assert.equal(result.status, "completed");
		assert.match(JSON.stringify(readResultPage(result).messages), /received-large-prompt/);
		const observed = JSON.parse(readFileSync(log, "utf8"));
		assert.equal(observed.promptLength, delegatedTask.length + "Task: ".length);
		assert.equal(observed.tail.endsWith("PROMPT_TAIL"), true);
		assert.ok(observed.maxArg < 64 * 1024);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

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
			registerShortcut() {},
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
			(!existsSync(child.logPath) || !/continuation:2:(?:main|work)/.test(readFileSync(child.logPath, "utf8")) || latestDetails?.results[0]?.status !== "completed") &&
			Date.now() < deadline
		) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.ok(existsSync(child.logPath));
		assert.match(readFileSync(child.logPath, "utf8"), /continuation:2:(?:main|work)/);
		assert.equal(latestDetails?.results[0]?.status, "completed");
		assert.equal(latestDetails?.results[1]?.status, "running");
		assert.equal(executionSettled, false);

		const result = await execution;
		assert.deepEqual(result.details.results.map((item: SingleResult) => item.status), ["completed", "completed"]);
		const recovered = result.details.results[1] as SingleResult;
		const finalContent = readResultPage(recovered).messages.at(-1)?.content;
		assert.equal(
			Array.isArray(finalContent) ? finalContent.find((part) => part.type === "text")?.text : undefined,
			"recovered child result",
		);
		assert.match(result.content[0].text, /Parallel: 2\/2 succeeded/);

		const lines = readFileSync(child.logPath, "utf8").trim().split("\n");
		assert.equal(lines.filter((line) => line === "invoke:Task: completed sibling").length, 1);
		assert.equal(lines.filter((line) => line === "invoke:Task: recover twice").length, 1);
		const continuations = lines.filter((line) => line.startsWith("continuation:"));
		assert.equal(continuations.length, 2);
		assert.match(continuations[0], /^continuation:1:(?:main|work)$/);
		assert.match(continuations[1], /^continuation:2:(?:main|work)$/);
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
				const turns = partial.details?.results[0]?.usage.turns ?? 0;
				if (!requestedAbort && turns > 0) {
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
		assert.ok(completed.results[0].resume);
		assert.match(JSON.stringify(readResultPage(completed.results[0]).messages), /finished after resume/);
		assert.equal(existsSync(interrupted.resume!.dir), true);
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
		assert.equal(existsSync(first.resume!.dir), true);
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
		const monitor = new SubagentMonitorStore();
		const details = await resumeContinuation(
			candidate,
			{ cwd: temporary, sessionManager: { getEntries: () => [], getSessionFile: () => undefined } },
			new AbortController().signal,
			() => {},
			{
				runsRoot: path.join(temporary, "runs"),
				invocation: invocationFor(fakeChild),
				monitorContext: { store: monitor, orchestrationId: "continue:parallel-call", sessionId: "parent" },
			},
		);
		assert.deepEqual(details.results.map((result) => result.status), ["completed", "completed", "completed"]);
		assert.deepEqual(monitor.getRuns("parent"), []);
		assert.match(JSON.stringify(readResultPage(details.results[0]).messages), /done one/);
		const invocations = readFileSync(logPath, "utf8");
		assert.doesNotMatch(invocations, /Task: completed work/);
		assert.match(invocations, /Continue the original delegated task/);
		assert.match(invocations, /Task: pending work/);
	} finally {
		delete process.env.PI_SUBAGENT_FAKE_LOG;
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("fan-in continuation waits for every upstream and passes ordered outputs plus scoped session IDs downstream", async () => {
	const temporary = path.join(os.tmpdir(), `pi-subagent-fan-in-${process.pid}-${Date.now()}`);
	mkdirSync(path.join(temporary, ".pi", "agents"), { recursive: true });
	writeFileSync(path.join(temporary, ".pi", "agents", "test-agent.md"), `---\nname: test-agent\ndescription: test\ntools: read\nmodel: fake/fake-1\n---\nTest agent.\n`);
	const fakeChild = writeFakeChild(temporary);
	const runsRoot = path.join(temporary, "runs");
	const logPath = path.join(temporary, "invocations.log");
	try {
		const completed = await runSingleAgent(
			temporary,
			[agent],
			agent.name,
			"finish upstream-one",
			undefined,
			"none",
			agent.model,
			undefined,
			1,
			new AbortController().signal,
			undefined,
			makeDetails,
			{ runsRoot, retainTerminalSession: true, invocation: invocationFor(fakeChild) },
		);
		const aborted = new AbortController();
		aborted.abort();
		const pending = await runSingleAgent(
			temporary,
			[agent],
			agent.name,
			"pending work",
			undefined,
			"none",
			agent.model,
			undefined,
			2,
			aborted.signal,
			undefined,
			makeDetails,
			{ runsRoot, retainTerminalSession: true, invocation: invocationFor(fakeChild) },
		);
		assert.ok(completed.resume?.sessionId);
		assert.ok(pending.resume?.sessionId);
		const downstream = {
			...completedResult("finish synthesize {previous}", ""),
			agent: agent.name,
			messages: [],
			exitCode: 130,
			status: "pending" as const,
			stopReason: "aborted",
			step: 3,
		};
		const candidate: ContinuationCandidate = {
			id: "fan-in-call",
			toolCallEntryId: "missing-entry",
			args: {
				tasks: [
					{ agent: agent.name, task: "finish upstream-one" },
					{ agent: agent.name, task: "pending work" },
				],
				then: { agent: agent.name, task: "finish synthesize {previous}", instructions: "Dedicated synthesizer." },
				agentScope: "project",
				contextMode: "none",
			},
			details: {
				mode: "fan-in",
				agentScope: "project",
				projectAgentsDir: path.join(temporary, ".pi", "agents"),
				results: [completed, pending, downstream],
				continuationId: "fan-in-call",
			},
		};
		writeFileSync(logPath, "");
		process.env.PI_SUBAGENT_FAKE_LOG = logPath;
		const monitor = new SubagentMonitorStore();
		let sawBarrier = false;
		const details = await resumeContinuation(
			candidate,
			{ cwd: temporary, sessionManager: { getEntries: () => [], getSessionFile: () => undefined } },
			new AbortController().signal,
			() => {
				const summary = monitor.getSummary("parent");
				if (summary.active === 1 && summary.queued === 1) sawBarrier = true;
			},
			{
				runsRoot,
				retainTerminalSession: true,
				invocation: invocationFor(fakeChild),
				monitorContext: { store: monitor, orchestrationId: "continue:fan-in-call", sessionId: "parent" },
			},
		);
		assert.equal(sawBarrier, true);
		assert.deepEqual(details.results.map((result) => result.status), ["completed", "completed", "completed"]);
		assert.deepEqual(monitor.getRuns("parent"), []);
		const downstreamTask = details.results[2].task;
		assert.ok(downstreamTask.indexOf("upstream-one") < downstreamTask.indexOf("pending task received"));
		assert.match(downstreamTask, new RegExp(completed.sessionId!));
		assert.match(downstreamTask, new RegExp(details.results[1].sessionId!));
		const invocations = readFileSync(logPath, "utf8");
		assert.doesNotMatch(invocations, /Task: finish upstream-one/);
		assert.match(invocations, /REFS_EXIST:true/);
		assert.match(invocations, /TOOLS:read,grep_session_bank,ask_session/);
		assert.match(invocations, /SESSION_REFS:/);
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
		const monitor = new SubagentMonitorStore();
		let sawQueuedSuccessor = false;
		const details = await resumeContinuation(
			candidate,
			{ cwd: temporary, sessionManager: { getEntries: () => [], getSessionFile: () => undefined } },
			new AbortController().signal,
			() => {
				const summary = monitor.getSummary("parent");
				if (summary.active === 1 && summary.queued === 1) sawQueuedSuccessor = true;
			},
			{
				runsRoot: path.join(temporary, "runs"),
				invocation: invocationFor(fakeChild),
				monitorContext: { store: monitor, orchestrationId: "continue:chain-call", sessionId: "parent" },
			},
		);
		assert.equal(details.results.length, 3);
		assert.equal(sawQueuedSuccessor, true);
		assert.deepEqual(monitor.getRuns("parent"), []);
		assert.equal(details.results[1].task, "interrupt seed-output");
		assert.equal(details.results[2].task, "finish finished after resume");
		assert.match(JSON.stringify(readResultPage(details.results[2]).messages), /finish finished after resume/);
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
		assert.match(JSON.stringify(readResultPage(completed).messages), /pending task received/);
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
		manager.appendMessage({ role: "system", content: "system delta after final response", timestamp: Date.now() });
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
		assert.match(JSON.stringify(readResultPage(recovered).messages), /durable terminal output/);
		assert.equal(readResultPage(recovered).messages.at(-1)?.role, "system");
		assert.equal(existsSync(session.dir), true);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("restart recovery preserves a terminal child failure without replaying it", async () => {
	const temporary = path.join(os.tmpdir(), `pi-subagent-failed-recovery-${process.pid}-${Date.now()}`);
	try {
		const session = await writeResumableForkSession(temporary, [], undefined, path.join(temporary, "runs"));
		const manager = SessionManager.open(session.filePath);
		manager.appendMessage({ role: "user", content: [{ type: "text", text: "Task: failed work" }], timestamp: Date.now() });
		manager.appendMessage({
			...(completedResult("failed work", "durable failure evidence").messages[0] as any),
			stopReason: "error",
			errorMessage: "terminal failure",
		});
		let spawned = false;
		const prior: SingleResult = {
			agent: agent.name,
			agentSource: "user",
			task: "failed work",
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
			"failed work",
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
		assert.equal(recovered.status, "failed");
		assert.equal(recovered.errorMessage, "terminal failure");
		assert.equal(spawned, false);
		assert.match(JSON.stringify(readResultPage(recovered).messages), /durable failure evidence/);
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
			{ role: "user", content: [{ type: "text", text: "Task: finish boundary work" }], timestamp: 1 },
			completedResult("finish boundary work", "parent answer").messages[0],
		] as any;
		const session = await writeResumableForkSession(temporary, inherited, undefined, path.join(temporary, "runs"));
		let spawned = false;
		let prompt: string | undefined;
		const prior: SingleResult = {
			agent: agent.name,
			agentSource: "user",
			task: "finish boundary work",
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
			"finish boundary work",
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
					prompt = args.at(-1);
					return invocationFor(fakeChild)(args);
				},
			},
		);
		assert.equal(spawned, true);
		assert.equal(prompt, "Task: finish boundary work");
		assert.equal(result.status, "completed");
		assert.match(JSON.stringify(readResultPage(result).messages), /boundary work/);
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
			registerShortcut() {},
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
			registerShortcut() {},
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

for (const hasUI of [false, true]) {
test(`trusted project continuation delivers hidden output without approval; UI=${hasUI}`, async () => {
	const temporary = path.join(os.tmpdir(), `pi-subagent-delivery-${process.pid}-${Date.now()}`);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = temporary;
	const fullOutput = "recovered output\n" + "line\n".repeat(3000) + "FINAL_END";
	const projectAgentsDir = path.join(temporary, ".agents", "subagents");
	mkdirSync(projectAgentsDir, { recursive: true });
	writeFileSync(path.join(projectAgentsDir, `${agent.name}.md`), `---\nname: ${agent.name}\ndescription: Project helper\n---\nProject instructions.\n`);
	const details: SubagentDetails = {
		mode: "single",
		agentScope: "project",
		projectAgentsDir,
		results: [completedResult("work", fullOutput)],
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
			args: { agent: agent.name, task: "work", agentScope: "project" },
			details,
			status: "ready",
			createdAt: 1,
			updatedAt: 1,
		});
		subagentExtension({
			events: createEventBus(),
			registerTool() {},
			registerCommand(name: string, command: any) { commands.set(name, command); },
			registerShortcut() {},
			on(event: string, handler: any) { if (event === "agent_end") agentEnd = handler; },
			appendEntry(customType: string, data: any) { appended.push({ customType, data }); },
			sendMessage(message: any, options: any) { sent.push({ message, options }); },
		} as unknown as ExtensionAPI);
		await commands.get("continue").handler("", {
			cwd: temporary,
			hasUI,
			isProjectTrusted: () => true,
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
			ui: { notify() {}, setStatus() {}, confirm() { throw new Error("Trusted continuation must not prompt"); } },
		});
		assert.equal(sent.length, 2);
		assert.equal(sent[0].message.customType, "subagent-continuation-result");
		assert.equal(sent[0].message.display, false);
		assert.match(sent[0].message.content, /recovered output/);
		assert.match(sent[0].message.content, /\[output truncated\]/);
		assert.equal(sent[0].message.content.includes("FINAL_END"), false);
		assert.equal(readContinuationManifest<any, SubagentDetails>("delivery-call")!.details.results[0].finalText, fullOutput);
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
}

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
			registerShortcut() {},
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
		registerShortcut() {},
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


for (const terminal of [false, true]) {
	test(`truncated final child append preserves evidence and recovers ${terminal ? "terminal output" : "continuation"}`, async () => {
		const temporary = path.join(os.tmpdir(), `pi-subagent-tail-${process.pid}-${Date.now()}-${terminal}`);
		mkdirSync(temporary, { recursive: true });
		try {
			const session = await writeResumableForkSession(temporary, [], undefined, path.join(temporary, "runs"));
			const manager = SessionManager.open(session.filePath);
			manager.appendMessage({ role: "user", content: "Task: tail work", timestamp: 1 });
			manager.appendMessage({ ...completedResult("tail work", "complete child progress").messages[0],
				stopReason: terminal ? "stop" : "toolUse", ...(terminal ? {} : { content: [{ type: "toolCall", id: "unfinished", name: "bash", arguments: { command: "side effect" } }] }) } as any);
			const complete = readFileSync(session.filePath);
			appendFileSync(session.filePath, '{"type":"message","id":"interrupted-bytes","message":{"role":"assistant","content":[{"type":"text","text":"partial');
			const evidence = readFileSync(session.filePath);
			const prior = { ...completedResult("tail work", "partial"), status: "interrupted", stopReason: "aborted", exitCode: 130, resume: session } as SingleResult;
			let launched = false;
			const fake = writeFakeChild(temporary);
			const result = await runSingleAgent(temporary, [agent], agent.name, prior.task, undefined, "none", agent.model, undefined, undefined, undefined, undefined, makeDetails, {
				resumeFrom: prior,
				invocation(args) { launched = true; assert.ok(!args.at(-1)!.startsWith("Task:")); return invocationFor(fake)(args); },
			});
			assert.equal(result.status, "completed");
			assert.equal(launched, !terminal);
			assert.notEqual(result.resume!.filePath, session.filePath);
			assert.equal(result.sessionFile, result.resume!.filePath);
			assert.deepEqual(readFileSync(session.filePath), evidence);
			assert.ok(readFileSync(result.sessionFile!).subarray(0, complete.length).equals(complete));
			const entries = SessionManager.open(result.sessionFile!).getEntries() as any[];
			const recovery = entries.find((entry) => entry.customType === "subagent-tail-recovery");
			assert.deepEqual(recovery.data, { sourceFile: session.filePath, completeBytes: complete.length, sourceBytes: evidence.length });
			assert.equal(entries.filter((entry) => entry.message?.toolCallId === "unfinished").length, terminal ? 0 : 1);
			assert.match(result.finalText!, terminal ? /complete child progress/ : /finished after resume/);
		} finally { rmSync(temporary, { recursive: true, force: true }); }
	});
}

test("completed malformed child records block continuation instead of being silently skipped", async () => {
	const temporary = path.join(os.tmpdir(), `pi-subagent-malformed-${process.pid}-${Date.now()}`);
	mkdirSync(temporary, { recursive: true });
	try {
		for (const suffix of ['{"type":"message","id":"bad","message":invalid}\n', '{"type":"message","id":"bad","message":{\n', '{"type":"message","id":"bad","message":invalid}\n{"type":"message","id":"cut']) {
			const session = await writeResumableForkSession(temporary, [], undefined, path.join(temporary, "runs"));
			appendFileSync(session.filePath, suffix);
			const evidence = readFileSync(session.filePath);
			const prior = { ...completedResult("work", "partial"), status: "interrupted", resume: session } as SingleResult;
			let launched = false;
			await assert.rejects(runSingleAgent(temporary, [agent], agent.name, prior.task, undefined, "none", agent.model, undefined, undefined, undefined, undefined, makeDetails,
				{ resumeFrom: prior, invocation() { launched = true; return { command: "false", args: [] }; } }));
			assert.equal(launched, false);
			assert.deepEqual(readFileSync(session.filePath), evidence);
		}
	} finally { rmSync(temporary, { recursive: true, force: true }); }
});

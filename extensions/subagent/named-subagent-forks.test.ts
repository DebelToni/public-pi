import { normalizeSingleResult, readResultPage } from "./result-store.ts";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	rmSync,
	statSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import {
	SessionManager,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { acquireContinuationLease } from "./continuation-store.ts";
import type { SingleResult } from "./index.ts";
import {
	listNamedSubagents,
	readNamedSubagent,
	registerNamedSubagentTools,
	restoreNamedSubagents,
} from "./named-subagents.ts";

type Tool = { execute: (...args: any[]) => Promise<any> };
type Status = NonNullable<SingleResult["status"]>;

const CHECKPOINT_TYPE = "named-subagent-checkpoint";

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

function ownerRoot(agentDir: string, sessionId: string) {
	return join(agentDir, "subagent-runs", "named", createHash("sha256").update(sessionId).digest("hex"));
}

function records(file: string) {
	return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function fileDigest(file: string) {
	const hash = createHash("sha256");
	const descriptor = openSync(file, "r");
	const chunk = Buffer.allocUnsafe(64 * 1024);
	try {
		while (true) {
			const count = readSync(descriptor, chunk, 0, chunk.length, null);
			if (count === 0) break;
			hash.update(chunk.subarray(0, count));
		}
	} finally {
		closeSync(descriptor);
	}
	return hash.digest("hex");
}

function appendJsonRecord(file: string, record: unknown) {
	appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
}

function branchIds(file: string) {
	return SessionManager.open(file).getBranch().map((entry) => entry.id);
}

function texts(file: string) {
	return SessionManager.open(file).buildSessionContext().messages.flatMap((message: any) => {
		const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content ?? [];
		return content.filter((part: any) => part.type === "text").map((part: any) => part.text);
	});
}

function mode(file: string) {
	return statSync(file).mode & 0o777;
}

function appendOrdinaryTurn(manager: SessionManager, prompt: string, answer = `answer:${prompt}`) {
	const userId = manager.appendMessage({ role: "user", content: prompt, timestamp: Date.now() });
	const assistantId = manager.appendMessage(assistant([{ type: "text", text: answer }]));
	return { userId, assistantId };
}

function createParent(cwd: string, sessions: string) {
	const manager = SessionManager.create(cwd, sessions);
	appendOrdinaryTurn(manager, "parent-start", "parent-ready");
	return manager;
}

function context(cwd: string, manager: SessionManager): ExtensionContext {
	return {
		cwd,
		hasUI: false,
		isProjectTrusted: () => true,
		model: { provider: "fake" },
		sessionManager: manager,
		ui: { confirm: async () => true },
	} as unknown as ExtensionContext;
}

async function withoutParentSession<T>(manager: SessionManager, operation: () => Promise<T>) {
	const nativeGetHeader = manager.getHeader;
	(manager as any).getHeader = () => {
		const header = nativeGetHeader.call(manager);
		if (!header) return header;
		const localHeader = { ...header } as any;
		delete localHeader.parentSession;
		return localHeader;
	};
	try {
		return await operation();
	} finally {
		delete (manager as any).getHeader;
	}
}

class DeterministicRunner {
	readonly calls: Array<{ task: string; handle: any; options: any }> = [];
	readonly statuses = new Map<string, Status>();
	pid = 7654321;

	run = async (...args: any[]): Promise<SingleResult> => {
		const task = args[3] as string;
		const options = args[12] as any;
		const handle = options.existingSession ?? options.resumeFrom?.resume;
		if (!handle?.filePath) throw new Error("fake runner requires a resumable child session");
		const manager = SessionManager.open(handle.filePath);
		const user = { role: "user", content: `Task: ${task}`, timestamp: Date.now() } as any;
		const reply = assistant([{ type: "text", text: `child-answer:${task}` }]);
		manager.appendMessage(user);
		manager.appendMessage(reply);
		const status = this.statuses.get(task) ?? "completed";
		const resume = {
			...handle,
			sessionId: manager.getSessionId(),
			...(status === "completed" ? {} : { pid: this.pid }),
		};
		const result: SingleResult = {
			agent: args[2],
			agentSource: "user",
			task,
			exitCode: status === "completed" ? 0 : 130,
			messages: [user, reply],
			stderr: "",
			status,
			stopReason: status === "completed" ? "stop" : "aborted",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 2, turns: 1 },
			resume,
			sessionId: manager.getSessionId(),
		};
		this.calls.push({ task, handle: { ...handle }, options });
		options.onCheckpoint?.(result);
		return result;
	};
}

type Fixture = ReturnType<typeof fixture>;

function fixture(t: TestContext) {
	const tempBase = join(homedir(), "tmp");
	mkdirSync(tempBase, { recursive: true });
	const root = mkdtempSync(join(tempBase, "pi-named-forks-"));
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
		"description: Deterministic helper",
		"size: small",
		"capabilities: general",
		"---",
		"Private deterministic instructions.",
		"",
	].join("\n"));

	const runner = new DeterministicRunner();
	const tools = new Map<string, Tool>();
	let currentManager: SessionManager | undefined;
	let appendCheckpoints = true;
	let monitorQueued = 0;
	const monitorInputs: any[] = [];
	let toolCallSequence = 0;
	const monitor = {
		queueRun(input: any) { monitorInputs.push(structuredClone(input)); monitorQueued++; return `monitor-${monitorQueued}`; },
	} as any;
	const pi = {
		registerTool(tool: Tool & { name: string }) { tools.set(tool.name, tool); },
		appendEntry(customType: string, data?: unknown) {
			if (!currentManager) throw new Error("pi.appendEntry called outside a bound session context");
			if (appendCheckpoints || customType !== CHECKPOINT_TYPE) currentManager.appendCustomEntry(customType, data);
		},
	} as unknown as ExtensionAPI;
	registerNamedSubagentTools(pi, { runSingleAgent: runner.run as any, sizedModel: () => "fake/model", monitor }, project);

	async function bound<T>(manager: SessionManager, operation: () => Promise<T>): Promise<T> {
		assert.equal(currentManager, undefined, "test harness operations must not overlap");
		currentManager = manager;
		try {
			return await operation();
		} finally {
			currentManager = undefined;
		}
	}

	async function execute(manager: SessionManager, toolName: string, args: any) {
		const id = `opaque-call-${++toolCallSequence}`;
		const callEntryId = manager.appendMessage(assistant([
			{ type: "toolCall", id, name: toolName, arguments: structuredClone(args) },
		], "toolUse"));
		const result = await bound(manager, () => tools.get(toolName)!.execute(
			id,
			args,
			undefined,
			undefined,
			context(project, manager),
		));
		const resultEntryId = manager.appendMessage({
			role: "toolResult",
			toolCallId: id,
			toolName,
			content: structuredClone(result.content),
			details: structuredClone(result.details),
			isError: false,
			timestamp: Date.now(),
		} as any);
		return { result, callEntryId, resultEntryId };
	}

	async function create(manager: SessionManager, name: string, extra: Record<string, unknown> = {}) {
		return execute(manager, "create_subagent", {
			name,
			template: "general",
			history: "none",
			context: "none",
			instructions: `private instructions for ${name}`,
			...extra,
		});
	}

	async function invoke(manager: SessionManager, name: string, prompt: string) {
		return execute(manager, "invoke_subagent", { name, prompt });
	}

	async function restore(manager: SessionManager) {
		return bound(manager, () => restoreNamedSubagents(pi, context(project, manager)));
	}

	t.after(() => {
		if (previousTmp === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previousTmp;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	});

	return {
		root, agentDir, project, sessions, runner, tools, pi, context, execute, create, invoke, restore,
		owner: (sessionId: string) => ownerRoot(agentDir, sessionId),
		setLegacy(value: boolean) { appendCheckpoints = !value; },
		monitorCount: () => monitorQueued,
		monitorInputs: () => monitorInputs,
	};
}

function forkCurrent(f: Fixture, source: SessionManager, label: string) {
	const sourceFile = source.getSessionFile();
	assert.ok(sourceFile);
	return SessionManager.forkFrom(sourceFile, f.project, join(f.root, `fork-${label}`));
}

function forkAt(f: Fixture, source: SessionManager, leafId: string, label: string) {
	const sourceFile = source.getSessionFile();
	assert.ok(sourceFile);
	const destination = join(f.root, `fork-${label}`);
	mkdirSync(destination, { recursive: true });
	const copy = SessionManager.open(sourceFile, destination);
	const file = copy.createBranchedSession(leafId);
	assert.ok(file);
	return SessionManager.open(file, dirname(file));
}

function state(f: Fixture, manager: SessionManager, name: string) {
	const value = readNamedSubagent(manager.getSessionId(), name);
	assert.ok(value, `missing ${name} state for ${manager.getSessionId()}`);
	return value;
}

function checkpointEntries(manager: SessionManager) {
	return manager.getEntries().filter((entry: any) => entry.type === "custom" && entry.customType === CHECKPOINT_TYPE) as any[];
}

function assertPrivateTree(f: Fixture, manager: SessionManager, name: string) {
	const saved = state(f, manager, name);
	const root = f.owner(manager.getSessionId());
	assert.equal(mode(root), 0o700);
	assert.equal(mode(join(root, "children")), 0o700);
	assert.equal(mode(saved.resume.dir), 0o700);
	assert.equal(mode(saved.resume.filePath), 0o600);
	assert.equal(mode(join(root, `${name}.json`)), 0o600);
	const checkpoints = join(root, "checkpoints");
	if (existsSync(checkpoints)) {
		assert.equal(mode(checkpoints), 0o700);
		for (const file of readdirSync(checkpoints)) assert.equal(mode(join(checkpoints, file)), 0o600);
	}
}

function appendFreshCopy(target: SessionManager, entries: SessionEntry[]) {
	for (const entry of entries) {
		if (entry.type === "message") target.appendMessage(structuredClone(entry.message) as any);
		else if (entry.type === "custom") target.appendCustomEntry(entry.customType, structuredClone(entry.data));
		else if (entry.type === "thinking_level_change") target.appendThinkingLevelChange(entry.thinkingLevel);
		else if (entry.type === "model_change") target.appendModelChange(entry.provider, entry.modelId);
		else if (entry.type === "custom_message") target.appendCustomMessageEntry(entry.customType, structuredClone(entry.content), entry.display, structuredClone(entry.details));
	}
}

test("current native forks restore a pinned private child independently and idempotently", async (t) => {
	const f = fixture(t);
	const source = createParent(f.project, f.sessions);
	await f.create(source, "worker");
	await f.invoke(source, "worker", "checkpoint-one");
	const sourceStateAtFork = state(f, source, "worker");
	const sourceChildId = SessionManager.open(sourceStateAtFork.resume.filePath).getSessionId();
	const pinnedIds = branchIds(sourceStateAtFork.resume.filePath);
	const fork = forkCurrent(f, source, "current");

	await f.invoke(source, "worker", "source-after-fork");
	const sourceState = state(f, source, "worker");
	const sourceStateBytes = readFileSync(join(f.owner(source.getSessionId()), "worker.json"));
	const sourceChildBytes = readFileSync(sourceState.resume.filePath);
	const sourceParentBytes = readFileSync(source.getSessionFile()!);
	const launchesBeforeRestore = f.runner.calls.length;
	const monitorBeforeRestore = f.monitorCount();

	const restored = await f.restore(fork);
	assert.deepEqual(restored, { inherited: ["worker"], failures: [] });
	assert.equal(f.runner.calls.length, launchesBeforeRestore, "restoration must not launch a child");
	assert.equal(f.monitorCount(), monitorBeforeRestore, "restoration must not queue monitor work");
	const inherited = state(f, fork, "worker");
	assert.equal(inherited.parentSessionId, fork.getSessionId());
	assert.notEqual(inherited.resume.filePath, sourceState.resume.filePath);
	assert.notEqual(inherited.resume.dir, sourceState.resume.dir);
	assert.notEqual(inherited.resume.runId, sourceState.resume.runId);
	assert.notEqual(SessionManager.open(inherited.resume.filePath).getSessionId(), sourceChildId);
	assert.deepEqual(branchIds(inherited.resume.filePath), pinnedIds, "copy must stop at the checkpoint's child leaf");
	assert.doesNotMatch(texts(inherited.resume.filePath).join("\n"), /source-after-fork/);
	assertPrivateTree(f, fork, "worker");

	const restoredChildBytes = readFileSync(inherited.resume.filePath);
	assert.deepEqual(await f.restore(fork), { inherited: [], failures: [] });
	assert.equal(state(f, fork, "worker").resume.filePath, inherited.resume.filePath);
	assert.deepEqual(readFileSync(inherited.resume.filePath), restoredChildBytes);
	assert.deepEqual(readFileSync(join(f.owner(source.getSessionId()), "worker.json")), sourceStateBytes);
	assert.deepEqual(readFileSync(sourceState.resume.filePath), sourceChildBytes);
	assert.deepEqual(readFileSync(source.getSessionFile()!), sourceParentBytes);

	await f.invoke(fork, "worker", "destination-only");
	assert.deepEqual(readFileSync(join(f.owner(source.getSessionId()), "worker.json")), sourceStateBytes);
	assert.deepEqual(readFileSync(sourceState.resume.filePath), sourceChildBytes);
	assert.deepEqual(readFileSync(source.getSessionFile()!), sourceParentBytes);
	const destinationBytes = readFileSync(state(f, fork, "worker").resume.filePath);
	await f.invoke(source, "worker", "source-only");
	assert.deepEqual(readFileSync(state(f, fork, "worker").resume.filePath), destinationBytes);
	assert.notDeepEqual(readFileSync(source.getSessionFile()!), sourceParentBytes, "the explicit source invoke should be the only later parent mutation");
});

test("checkpoint markers are reference-only and snapshots and restored material are private", async (t) => {
	const f = fixture(t);
	const source = createParent(f.project, f.sessions);
	await f.create(source, "secrets", { instructions: "TOP-SECRET-INSTRUCTION" });
	await f.invoke(source, "secrets", "TOP-SECRET-PROMPT");
	const markers = checkpointEntries(source);
	assert.ok(markers.length >= 2);
	for (const marker of markers) {
		assert.deepEqual(Object.keys(marker.data).sort(), ["checkpointId", "name", "parentSessionId", "toolCallId", "version"].sort());
		assert.equal(marker.data.version, 1);
		assert.equal(marker.data.name, "secrets");
		assert.equal(marker.data.parentSessionId, source.getSessionId());
		assert.doesNotMatch(JSON.stringify(marker.data), /TOP-SECRET|instructions|history|resume|filePath/);
		const snapshot = join(f.owner(source.getSessionId()), "checkpoints", `${marker.data.checkpointId}.json`);
		assert.equal(existsSync(snapshot), true);
		assert.equal(mode(snapshot), 0o600);
	}
	assert.equal(mode(join(f.owner(source.getSessionId()), "checkpoints")), 0o700);
	const fork = forkCurrent(f, source, "permissions");
	await f.restore(fork);
	assertPrivateTree(f, fork, "secrets");
});

test("historical forks, abandoned markers, and synthetic context copies do not inherit", async (t) => {
	const f = fixture(t);
	const source = createParent(f.project, f.sessions);
	const beforeCreation = source.getLeafId()!;
	const historical = forkAt(f, source, beforeCreation, "historical");
	await f.create(source, "too-new");
	assert.deepEqual(await f.restore(historical), { inherited: [], failures: [] });
	assert.equal(readNamedSubagent(historical.getSessionId(), "too-new"), undefined);

	const branchAnchor = source.getLeafId()!;
	await f.create(source, "abandoned");
	source.branch(branchAnchor);
	appendOrdinaryTurn(source, "active-branch", "active-answer");
	const branchedFork = forkCurrent(f, source, "active-branch");
	assert.ok(checkpointEntries(branchedFork).length > 0, "native fork copies the source JSONL's abandoned entries too");
	assert.deepEqual(await f.restore(branchedFork), { inherited: ["too-new"], failures: [] });
	assert.ok(readNamedSubagent(branchedFork.getSessionId(), "too-new"));
	assert.equal(readNamedSubagent(branchedFork.getSessionId(), "abandoned"), undefined);

	const cleanSource = createParent(f.project, join(f.root, "synthetic-source"));
	await f.create(cleanSource, "synthetic");
	const synthetic = SessionManager.create(f.project, join(f.root, "synthetic-destination"), {
		parentSession: cleanSource.getSessionFile(),
	});
	appendFreshCopy(synthetic, cleanSource.getBranch());
	assert.ok(checkpointEntries(synthetic).length > 0);
	assert.deepEqual(await f.restore(synthetic), { inherited: [], failures: [] });
	assert.equal(readNamedSubagent(synthetic.getSessionId(), "synthetic"), undefined);
});

test("local names win, unrelated same-name owners do not leak, and restart/grandchild restoration works", async (t) => {
	const f = fixture(t);
	const source = createParent(f.project, f.sessions);
	await f.create(source, "shared", { instructions: "source definition" });
	await f.invoke(source, "shared", "source-history");
	const fork = forkCurrent(f, source, "collision");
	await withoutParentSession(fork, () => f.create(fork, "shared", { instructions: "local definition" }));
	const local = state(f, fork, "shared");
	assert.deepEqual(await f.restore(fork), { inherited: [], failures: [] });
	assert.equal(state(f, fork, "shared").instructions, "local definition");
	assert.equal(state(f, fork, "shared").resume.filePath, local.resume.filePath);

	const unrelated = createParent(f.project, join(f.root, "unrelated"));
	await f.create(unrelated, "shared", { instructions: "unrelated definition" });
	await f.invoke(unrelated, "shared", "unrelated-history");
	const cleanFork = forkCurrent(f, source, "restart");
	assert.deepEqual(await f.restore(cleanFork), { inherited: ["shared"], failures: [] });
	assert.equal(state(f, cleanFork, "shared").instructions, "source definition");
	assert.doesNotMatch(texts(state(f, cleanFork, "shared").resume.filePath).join("\n"), /unrelated-history/);

	const restarted = SessionManager.open(cleanFork.getSessionFile()!);
	assert.deepEqual(await f.restore(restarted), { inherited: [], failures: [] });
	const grandchild = forkCurrent(f, restarted, "grandchild");
	assert.deepEqual(await f.restore(grandchild), { inherited: ["shared"], failures: [] });
	const childState = state(f, restarted, "shared");
	const grandchildState = state(f, grandchild, "shared");
	assert.notEqual(grandchildState.resume.filePath, childState.resume.filePath);
	assert.notEqual(grandchildState.resume.runId, childState.resume.runId);
	assert.notEqual(SessionManager.open(grandchildState.resume.filePath).getSessionId(), SessionManager.open(childState.resume.filePath).getSessionId());
	assert.equal(listNamedSubagents(grandchild.getSessionId()).length, 1);
});

test("pending checkpoints resume independently and clear live source process state", async (t) => {
	const f = fixture(t);
	const source = createParent(f.project, f.sessions);
	await f.create(source, "pending-a");
	await f.create(source, "pending-b");
	f.runner.statuses.set("wait-a", "pending");
	f.runner.statuses.set("wait-b", "interrupted");
	await f.invoke(source, "pending-a", "wait-a");
	await f.invoke(source, "pending-b", "wait-b");
	const sourceA = state(f, source, "pending-a");
	const sourceB = state(f, source, "pending-b");
	const sourceAStatePath = join(f.owner(source.getSessionId()), "pending-a.json");
	const sourceAStateBytes = readFileSync(sourceAStatePath);
	const sourceAChildBytes = readFileSync(sourceA.resume.filePath);
	assert.ok(sourceA.pending?.resume?.pid);
	assert.ok(sourceB.pending?.resume?.pid);
	assert.notEqual(sourceA.resume.baselineEntryId, sourceA.pending!.resume!.baselineEntryId);
	assert.notEqual(sourceB.resume.baselineEntryId, sourceB.pending!.resume!.baselineEntryId);
	const fork = forkCurrent(f, source, "pending");
	const launches = f.runner.calls.length;
	assert.deepEqual(new Set((await f.restore(fork)).inherited), new Set(["pending-a", "pending-b"]));
	assert.equal(f.runner.calls.length, launches);

	for (const [name, original] of [["pending-a", sourceA], ["pending-b", sourceB]] as const) {
		const inherited = state(f, fork, name);
		assert.ok(inherited.pending?.resume);
		assert.equal(inherited.pending.resume.filePath, inherited.resume.filePath);
		assert.equal(inherited.pending.resume.dir, inherited.resume.dir);
		assert.equal(inherited.pending.resume.runId, inherited.resume.runId);
		assert.equal(inherited.pending.resume.sessionId, inherited.resume.sessionId);
		assert.equal(inherited.pending.resume.pid, undefined);
		assert.equal(inherited.resume.pid, undefined);
		assert.equal(inherited.resume.baselineEntryId, original.resume.baselineEntryId);
		assert.equal(inherited.pending.resume.baselineEntryId, original.pending!.resume!.baselineEntryId);
		assert.notEqual(inherited.resume.baselineEntryId, inherited.pending.resume.baselineEntryId);
		const ids = new Set(branchIds(inherited.resume.filePath));
		assert.equal(ids.has(inherited.resume.baselineEntryId), true);
		assert.equal(ids.has(inherited.pending.resume.baselineEntryId), true);
	}

	const forkA = state(f, fork, "pending-a");
	const forkPendingResume = structuredClone(forkA.pending!.resume!);
	f.runner.statuses.set("wait-a", "completed");
	const resumeCallIndex = f.runner.calls.length;
	await f.invoke(fork, "pending-a", "new-after-resume");
	const resumedCall = f.runner.calls[resumeCallIndex];
	const newPromptCall = f.runner.calls[resumeCallIndex + 1];
	assert.equal(f.runner.calls.length, resumeCallIndex + 2);
	assert.equal(resumedCall.task, "wait-a");
	assert.deepEqual(resumedCall.handle, forkPendingResume);
	assert.ok(resumedCall.options.resumeFrom);
	assert.equal(resumedCall.options.existingSession, undefined);
	assert.equal(newPromptCall.task, "new-after-resume");
	assert.equal(newPromptCall.options.resumeFrom, undefined);
	assert.equal(newPromptCall.options.existingSession.filePath, forkA.resume.filePath);
	assert.equal(newPromptCall.options.existingSession.runId, forkA.resume.runId);
	assert.notEqual(newPromptCall.options.existingSession.baselineEntryId, forkA.resume.baselineEntryId);
	assert.equal(state(f, fork, "pending-a").pending, undefined);
	assert.deepEqual(readFileSync(sourceAStatePath), sourceAStateBytes);
	assert.deepEqual(readFileSync(sourceA.resume.filePath), sourceAChildBytes);

	await f.create(source, "live");
	f.runner.pid = process.pid;
	f.runner.statuses.set("live-work", "running");
	const markerCount = checkpointEntries(source).length;
	await f.invoke(source, "live", "live-work");
	const runningMarker = checkpointEntries(source).slice(markerCount).find((marker) => {
		const snapshot = join(f.owner(source.getSessionId()), "checkpoints", `${marker.data.checkpointId}.json`);
		return existsSync(snapshot) && /\"status\":\"running\"/.test(readFileSync(snapshot, "utf8"));
	});
	assert.ok(runningMarker, "the live onCheckpoint state must be frozen before the final tool result");
	const liveFork = forkAt(f, source, runningMarker.id, "live-pid");
	const liveLaunches = f.runner.calls.length;
	const liveRestored = await f.restore(liveFork);
	assert.equal(liveRestored.failures.length, 0);
	assert.equal(liveRestored.inherited.includes("live"), true);
	assert.equal(f.runner.calls.length, liveLaunches);
	const frozen = state(f, liveFork, "live");
	assert.notEqual(frozen.pending?.status, "running");
	assert.doesNotMatch(JSON.stringify(frozen), /\"pid\":/);
});

test("missing or malformed source children fail closed per name", async (t) => {
	const f = fixture(t);
	const source = createParent(f.project, f.sessions);
	await f.create(source, "missing");
	await f.create(source, "malformed");
	const fork = forkCurrent(f, source, "broken");
	rmSync(state(f, source, "missing").resume.filePath, { force: true });
	writeFileSync(state(f, source, "malformed").resume.filePath, "not-json\n", { mode: 0o600 });
	const sourceParent = readFileSync(source.getSessionFile()!);
	const result = await f.restore(fork);
	assert.deepEqual(result.inherited, []);
	assert.deepEqual(new Set(result.failures.map((failure) => failure.name)), new Set(["missing", "malformed"]));
	assert.ok(result.failures.every((failure) => failure.error.length > 0));
	assert.equal(readNamedSubagent(fork.getSessionId(), "missing"), undefined);
	assert.equal(readNamedSubagent(fork.getSessionId(), "malformed"), undefined);
	assert.equal(existsSync(join(f.owner(fork.getSessionId()), "missing.json")), false);
	assert.equal(existsSync(join(f.owner(fork.getSessionId()), "malformed.json")), false);
	assert.deepEqual(readFileSync(source.getSessionFile()!), sourceParent);
});

test("an unknown invoke lazily repairs a fork before launching exactly once", async (t) => {
	const f = fixture(t);
	const source = createParent(f.project, f.sessions);
	await f.create(source, "lazy");
	await f.invoke(source, "lazy", "before-fork");
	const fork = forkCurrent(f, source, "lazy");
	assert.equal(readNamedSubagent(fork.getSessionId(), "lazy"), undefined);
	const before = f.runner.calls.length;
	const invocation = await f.invoke(fork, "lazy", "after-fork");
	assert.match(invocation.result.content[0].text, /child-answer:after-fork/);
	const monitored = f.monitorInputs().at(-1);
	assert.equal(monitored.creationInstructions, "private instructions for lazy");
	assert.deepEqual(monitored.tasks, ["before-fork", "after-fork"]);
	assert.doesNotMatch(JSON.stringify(monitored), /parent-start|parent-ready/);
	assert.equal(f.runner.calls.length, before + 1);
	assert.ok(readNamedSubagent(fork.getSessionId(), "lazy"));
});

test("legacy paired tool evidence restores create-only and cuts invoked children before later source work", async (t) => {
	const f = fixture(t);
	f.setLegacy(true);
	const source = createParent(f.project, f.sessions);
	await f.create(source, "created-only");
	await f.create(source, "legacy");
	const first = await f.invoke(source, "legacy", "legacy-checkpoint");
	assert.equal(checkpointEntries(source).length, 0);
	const fork = forkAt(f, source, first.resultEntryId, "legacy");

	await f.invoke(source, "legacy", "later-source-work");
	const sourceStateBytes = readFileSync(join(f.owner(source.getSessionId()), "legacy.json"));
	const sourceChildBytes = readFileSync(state(f, source, "legacy").resume.filePath);
	const launches = f.runner.calls.length;
	const result = await f.restore(fork);
	assert.deepEqual(new Set(result.inherited), new Set(["created-only", "legacy"]));
	assert.deepEqual(result.failures, []);
	assert.equal(f.runner.calls.length, launches);
	assert.match(texts(state(f, fork, "legacy").resume.filePath).join("\n"), /legacy-checkpoint/);
	assert.doesNotMatch(texts(state(f, fork, "legacy").resume.filePath).join("\n"), /later-source-work/);
	assert.ok(readNamedSubagent(fork.getSessionId(), "created-only"));
	assert.deepEqual(readFileSync(join(f.owner(source.getSessionId()), "legacy.json")), sourceStateBytes);
	assert.deepEqual(readFileSync(state(f, source, "legacy").resume.filePath), sourceChildBytes);
});

test("legacy historical grandchildren resolve copied events to their true writer", async (t) => {
	const f = fixture(t);
	f.setLegacy(true);
	const source = createParent(f.project, f.sessions);
	await f.create(source, "worker", { instructions: "original worker instructions" });
	const originalInvocation = await f.invoke(source, "worker", "original-worker-context");
	const originalWorkerIds = branchIds(state(f, source, "worker").resume.filePath);
	const adoptedParent = forkCurrent(f, source, "legacy-adopted-parent");

	f.setLegacy(false);
	assert.deepEqual(await f.restore(adoptedParent), { inherited: ["worker"], failures: [] });
	await f.invoke(adoptedParent, "worker", "adopted-parent-only");
	const historicalGrandchild = forkAt(
		f,
		adoptedParent,
		originalInvocation.resultEntryId,
		"legacy-historical-grandchild",
	);
	assert.deepEqual(await f.restore(historicalGrandchild), { inherited: ["worker"], failures: [] });
	const grandchildWorker = state(f, historicalGrandchild, "worker");
	assert.deepEqual(branchIds(grandchildWorker.resume.filePath), originalWorkerIds);
	assert.match(texts(grandchildWorker.resume.filePath).join("\n"), /original-worker-context/);
	assert.doesNotMatch(texts(grandchildWorker.resume.filePath).join("\n"), /adopted-parent-only/);
	assert.notEqual(grandchildWorker.resume.filePath, state(f, adoptedParent, "worker").resume.filePath);

	f.setLegacy(true);
	const createSource = createParent(f.project, join(f.root, "legacy-create-source"));
	const originalCreation = await f.create(createSource, "same-name", { instructions: "true original definition" });
	const overwrittenParent = forkCurrent(f, createSource, "legacy-local-overwrite");
	f.setLegacy(false);
	await withoutParentSession(overwrittenParent, () => f.create(overwrittenParent, "same-name", {
		instructions: "nearer legacy-local definition",
	}));
	assert.equal(state(f, overwrittenParent, "same-name").instructions, "nearer legacy-local definition");
	const beforeOverwrite = forkAt(f, overwrittenParent, originalCreation.resultEntryId, "before-local-overwrite");
	assert.deepEqual(await f.restore(beforeOverwrite), { inherited: ["same-name"], failures: [] });
	assert.equal(state(f, beforeOverwrite, "same-name").instructions, "true original definition");
	assert.notEqual(state(f, beforeOverwrite, "same-name").resume.filePath, state(f, overwrittenParent, "same-name").resume.filePath);
});

test("a held destination name lease fails only that copy and retry succeeds", async (t) => {
	const f = fixture(t);
	const source = createParent(f.project, f.sessions);
	await f.create(source, "held");
	await f.create(source, "free");
	const destination = forkCurrent(f, source, "held-lease");
	const release = acquireContinuationLease("named:held", destination.getSessionId());
	let first;
	try {
		first = await f.restore(destination);
	} finally {
		release();
	}
	assert.deepEqual(first.inherited, ["free"]);
	assert.deepEqual(first.failures.map((failure) => failure.name), ["held"]);
	assert.match(first.failures[0].error, /already running/);
	assert.equal(readNamedSubagent(destination.getSessionId(), "held"), undefined);
	assert.equal(existsSync(join(f.owner(destination.getSessionId()), "held.json")), false);
	assert.ok(readNamedSubagent(destination.getSessionId(), "free"));

	assert.deepEqual(await f.restore(destination), { inherited: ["held"], failures: [] });
	assert.ok(readNamedSubagent(destination.getSessionId(), "held"));
});

test("an occupied corrupt destination state is never overwritten", async (t) => {
	const f = fixture(t);
	const source = createParent(f.project, f.sessions);
	await f.create(source, "occupied");
	const destination = forkCurrent(f, source, "corrupt-destination");
	const destinationRoot = f.owner(destination.getSessionId());
	mkdirSync(destinationRoot, { recursive: true, mode: 0o700 });
	const corruptPath = join(destinationRoot, "occupied.json");
	const corruptBytes = Buffer.from("{corrupt destination state\n");
	writeFileSync(corruptPath, corruptBytes, { mode: 0o600 });

	const result = await f.restore(destination);
	assert.deepEqual(result.inherited, []);
	assert.deepEqual(result.failures.map((failure) => failure.name), ["occupied"]);
	assert.match(result.failures[0].error, /invalid|overwrite/i);
	assert.deepEqual(readFileSync(corruptPath), corruptBytes);
	assert.equal(readNamedSubagent(destination.getSessionId(), "occupied"), undefined);
});

test("source child symlinks and checkpoint path escapes are refused without source mutation", async (t) => {
	const f = fixture(t);
	const source = createParent(f.project, f.sessions);
	await f.create(source, "symlinked");
	await f.create(source, "escaped");
	const symlinked = state(f, source, "symlinked");
	const escaped = state(f, source, "escaped");

	const symlinkTarget = join(f.root, "outside-symlink-child.jsonl");
	writeFileSync(symlinkTarget, readFileSync(symlinked.resume.filePath), { mode: 0o600 });
	rmSync(symlinked.resume.filePath);
	symlinkSync(symlinkTarget, symlinked.resume.filePath);
	assert.equal(lstatSync(symlinked.resume.filePath).isSymbolicLink(), true);

	const escapeTarget = join(f.root, "outside-escaped-child.jsonl");
	writeFileSync(escapeTarget, readFileSync(escaped.resume.filePath), { mode: 0o600 });
	const escapeMarker = checkpointEntries(source).find((entry) => entry.data.name === "escaped");
	assert.ok(escapeMarker);
	const escapeCheckpointPath = join(f.owner(source.getSessionId()), "checkpoints", `${escapeMarker.data.checkpointId}.json`);
	const escapeCheckpoint = JSON.parse(readFileSync(escapeCheckpointPath, "utf8"));
	escapeCheckpoint.state.resume.filePath = escapeTarget;
	escapeCheckpoint.state.resume.dir = dirname(escapeTarget);
	writeFileSync(escapeCheckpointPath, `${JSON.stringify(escapeCheckpoint)}\n`, { mode: 0o600 });

	const destination = forkCurrent(f, source, "unsafe-source-child");
	const sourceParentBytes = readFileSync(source.getSessionFile()!);
	const symlinkStateBytes = readFileSync(join(f.owner(source.getSessionId()), "symlinked.json"));
	const escapeStateBytes = readFileSync(join(f.owner(source.getSessionId()), "escaped.json"));
	const escapeCheckpointBytes = readFileSync(escapeCheckpointPath);
	const symlinkTargetBytes = readFileSync(symlinkTarget);
	const escapeTargetBytes = readFileSync(escapeTarget);
	const result = await f.restore(destination);
	assert.deepEqual(result.inherited, []);
	assert.deepEqual(new Set(result.failures.map((failure) => failure.name)), new Set(["symlinked", "escaped"]));
	assert.ok(result.failures.every((failure) => /regular file|escapes/.test(failure.error)));
	assert.equal(readNamedSubagent(destination.getSessionId(), "symlinked"), undefined);
	assert.equal(readNamedSubagent(destination.getSessionId(), "escaped"), undefined);
	assert.deepEqual(readFileSync(source.getSessionFile()!), sourceParentBytes);
	assert.deepEqual(readFileSync(join(f.owner(source.getSessionId()), "symlinked.json")), symlinkStateBytes);
	assert.deepEqual(readFileSync(join(f.owner(source.getSessionId()), "escaped.json")), escapeStateBytes);
	assert.deepEqual(readFileSync(escapeCheckpointPath), escapeCheckpointBytes);
	assert.deepEqual(readFileSync(symlinkTarget), symlinkTargetBytes);
	assert.deepEqual(readFileSync(escapeTarget), escapeTargetBytes);
	assert.equal(lstatSync(symlinked.resume.filePath).isSymbolicLink(), true);
});

test("cyclic legacy parent ancestry fails in bounded time without mutating either session", async (t) => {
	const f = fixture(t);
	f.setLegacy(true);
	const source = createParent(f.project, f.sessions);
	await f.create(source, "cycle");
	const destination = forkCurrent(f, source, "ancestry-cycle");
	const sourceFile = source.getSessionFile()!;
	const destinationFile = destination.getSessionFile()!;
	const sourceLines = readFileSync(sourceFile, "utf8").trimEnd().split("\n");
	const sourceHeader = JSON.parse(sourceLines[0]);
	sourceHeader.parentSession = destinationFile;
	sourceLines[0] = JSON.stringify(sourceHeader);
	writeFileSync(sourceFile, `${sourceLines.join("\n")}\n`);
	const sourceBytes = readFileSync(sourceFile);
	const destinationBytes = readFileSync(destinationFile);

	const started = Date.now();
	const result = await f.restore(destination);
	assert.ok(Date.now() - started < 2_000, "ancestry cycles must be detected rather than traversed indefinitely");
	assert.deepEqual(result.inherited, []);
	assert.deepEqual(result.failures.map((failure) => failure.name), ["cycle"]);
	assert.match(result.failures[0].error, /Cyclic parent session ancestry/);
	assert.equal(readNamedSubagent(destination.getSessionId(), "cycle"), undefined);
	assert.deepEqual(readFileSync(sourceFile), sourceBytes);
	assert.deepEqual(readFileSync(destinationFile), destinationBytes);
});

test("streaming restore ignores multi-megabyte parent payloads and preserves multibyte child entries", async (t) => {
	const f = fixture(t);
	const source = createParent(f.project, f.sessions);
	const filler = `unrelated-${"€".repeat(350_000)}`;
	await f.create(source, "stream-one");
	source.appendCustomEntry("unrelated-large-payload", { ordinal: 1, filler });
	await f.create(source, "stream-two");
	const multibytePrompt = `split-${"€".repeat(180_000)}-終`;
	await f.invoke(source, "stream-two", multibytePrompt);
	source.appendCustomEntry("unrelated-large-payload", { ordinal: 2, filler });
	await f.create(source, "stream-three");
	source.appendCustomEntry("unrelated-large-payload", { ordinal: 3, filler });

	const sourceFile = source.getSessionFile()!;
	assert.ok(statSync(sourceFile).size > 4 * 1024 * 1024);
	const destination = forkCurrent(f, source, "streaming-parent");
	const destinationMarkers = checkpointEntries(destination);
	assert.ok(destinationMarkers.length >= 4);
	for (const marker of destinationMarkers) {
		assert.deepEqual(source.getEntry(marker.id), marker, "copied checkpoint IDs and payloads must exactly match the ancestor");
	}
	const names = ["stream-one", "stream-two", "stream-three"];
	const sourceChildren = new Map(names.map((name) => {
		const saved = state(f, source, name);
		return [name, {
			path: saved.resume.filePath,
			digest: fileDigest(saved.resume.filePath),
			entries: SessionManager.open(saved.resume.filePath).getEntries(),
		}] as const;
	}));
	const sourceDigest = fileDigest(sourceFile);
	const launches = f.runner.calls.length;

	const restored = await f.restore(destination);
	assert.deepEqual(new Set(restored.inherited), new Set(names));
	assert.deepEqual(restored.failures, []);
	assert.equal(f.runner.calls.length, launches, "streaming restoration must not launch children");
	assert.equal(fileDigest(sourceFile), sourceDigest);
	const destinationPaths = new Set<string>();
	for (const name of names) {
		const inherited = state(f, destination, name);
		destinationPaths.add(inherited.resume.filePath);
		const original = sourceChildren.get(name)!;
		assert.notEqual(inherited.resume.filePath, original.path);
		assert.deepEqual(SessionManager.open(inherited.resume.filePath).getEntries(), original.entries);
		assert.equal(fileDigest(original.path), original.digest);
	}
	assert.equal(destinationPaths.size, names.length);
	const restoredTexts = texts(state(f, destination, "stream-two").resume.filePath);
	assert.equal(restoredTexts.includes(`Task: ${multibytePrompt}`), true);
	assert.equal(restoredTexts.includes(`child-answer:${multibytePrompt}`), true);
	assert.equal(restoredTexts.some((text) => text.includes("�")), false, "StringDecoder must preserve UTF-8 split across read chunks");
});

test("streaming ancestor reads accept missing newlines and skip malformed tails without repair", async (t) => {
	const f = fixture(t);
	const noNewlineSource = createParent(f.project, f.sessions);
	await f.create(noNewlineSource, "no-newline");
	const noNewlineFork = forkCurrent(f, noNewlineSource, "no-newline");
	const noNewlineFile = noNewlineSource.getSessionFile()!;
	const noNewlineSize = statSync(noNewlineFile).size;
	truncateSync(noNewlineFile, noNewlineSize - 1);
	const noNewlineDigest = fileDigest(noNewlineFile);
	assert.deepEqual(await f.restore(noNewlineFork), { inherited: ["no-newline"], failures: [] });
	assert.equal(fileDigest(noNewlineFile), noNewlineDigest);
	assert.equal(statSync(noNewlineFile).size, noNewlineSize - 1);

	const malformedSource = createParent(f.project, join(f.root, "malformed-tail-source"));
	await f.create(malformedSource, "malformed-tail");
	const malformedFork = forkCurrent(f, malformedSource, "malformed-tail");
	const malformedFile = malformedSource.getSessionFile()!;
	appendFileSync(malformedFile, "{\"type\":\"custom\",\"id\":\"incomplete-tail\"", "utf8");
	const malformedDigest = fileDigest(malformedFile);
	const malformedSize = statSync(malformedFile).size;
	assert.deepEqual(await f.restore(malformedFork), { inherited: ["malformed-tail"], failures: [] });
	assert.equal(fileDigest(malformedFile), malformedDigest);
	assert.equal(statSync(malformedFile).size, malformedSize);
});

test("streaming ancestor reads reject duplicate IDs outside the candidate payload set", async (t) => {
	const f = fixture(t);
	const source = createParent(f.project, f.sessions);
	await f.create(source, "duplicate-guard");
	const destination = forkCurrent(f, source, "duplicate-unrelated-id");
	const sourceFile = source.getSessionFile()!;
	const duplicate = {
		type: "custom",
		id: "duplicate-unrelated-entry",
		parentId: null,
		timestamp: new Date().toISOString(),
		customType: "unrelated-large-payload",
		data: { filler: "not a candidate" },
	};
	appendJsonRecord(sourceFile, duplicate);
	appendJsonRecord(sourceFile, { ...duplicate, timestamp: new Date(Date.now() + 1).toISOString(), data: { filler: "still unrelated" } });
	const sourceDigest = fileDigest(sourceFile);
	const sourceSize = statSync(sourceFile).size;

	const restored = await f.restore(destination);
	assert.deepEqual(restored.inherited, []);
	assert.deepEqual(restored.failures.map((failure) => failure.name), ["duplicate-guard"]);
	assert.match(restored.failures[0].error, /Duplicate session entry IDs/);
	assert.equal(readNamedSubagent(destination.getSessionId(), "duplicate-guard"), undefined);
	assert.equal(fileDigest(sourceFile), sourceDigest);
	assert.equal(statSync(sourceFile).size, sourceSize);
});

if (process.env.PI_NAMED_FORK_LARGE_TEST === "1") test(
	"streaming restore handles an ancestor beyond Node's maximum string length",
	async (t) => {
	const f = fixture(t);
	const source = createParent(f.project, f.sessions);
	await f.create(source, "large-one");
	await f.create(source, "large-two");
	const sourceFile = source.getSessionFile()!;
	const capturedBranch = structuredClone(source.getBranch());
	const capturedMarkers = capturedBranch.filter((entry: any) => entry.type === "custom" && entry.customType === CHECKPOINT_TYPE);
	assert.ok(capturedMarkers.length >= 2);
	for (const marker of capturedMarkers) assert.deepEqual(source.getEntry(marker.id), marker);

	const destinationId = randomUUID();
	const destinationDir = join(f.root, "large-lightweight-destination");
	const destinationFile = join(destinationDir, "destination.jsonl");
	mkdirSync(destinationDir, { recursive: true });
	const destinationHeader = {
		type: "session" as const,
		version: 3,
		id: destinationId,
		timestamp: new Date().toISOString(),
		cwd: f.project,
		parentSession: sourceFile,
	};
	writeFileSync(destinationFile, `${JSON.stringify(destinationHeader)}\n`, { mode: 0o600 });

	const payload = "x".repeat(1024 * 1024);
	const descriptor = openSync(sourceFile, "a");
	try {
		for (let index = 0; index < 520; index++) {
			const record = {
				type: "custom",
				id: `large-unrelated-${index.toString().padStart(4, "0")}`,
				parentId: null,
				timestamp: new Date(1_800_000_000_000 + index).toISOString(),
				customType: "large-unrelated-payload",
				data: { payload },
			};
			writeSync(descriptor, `${JSON.stringify(record)}\n`, undefined, "utf8");
		}
	} finally {
		closeSync(descriptor);
	}
	const sourceStat = statSync(sourceFile);
	assert.ok(sourceStat.size > 536_870_888, `fixture must exceed Node's string limit; got ${sourceStat.size}`);
	const launches = f.runner.calls.length;
	const appended: Array<{ customType: string; data: unknown }> = [];
	const lightweightPi = {
		appendEntry(customType: string, data?: unknown) { appended.push({ customType, data }); },
	} as unknown as ExtensionAPI;
	const lightweightContext = {
		cwd: f.project,
		hasUI: false,
		sessionManager: {
			getSessionId: () => destinationId,
			getSessionFile: () => destinationFile,
			getHeader: () => destinationHeader,
			getBranch: () => capturedBranch,
		},
	} as unknown as ExtensionContext;

	const restored = await restoreNamedSubagents(lightweightPi, lightweightContext);
	assert.deepEqual(new Set(restored.inherited), new Set(["large-one", "large-two"]));
	assert.deepEqual(restored.failures, []);
	assert.equal(f.runner.calls.length, launches);
	assert.deepEqual(new Set(listNamedSubagents(destinationId).map((saved) => saved.name)), new Set(["large-one", "large-two"]));
	assert.equal(appended.filter((entry) => entry.customType === CHECKPOINT_TYPE).length, 2);
	const after = statSync(sourceFile);
	assert.equal(after.size, sourceStat.size);
	assert.equal(after.mtimeMs, sourceStat.mtimeMs);
	},
);


for (const direction of ["normalized fork / inline ancestor", "inline fork / normalized ancestor"]) {
	test(`migration-aware ancestry preserves exact named identity: ${direction}`, async (t) => {
		const f = fixture(t);
		f.setLegacy(true);
		let source = createParent(f.project, f.sessions);
		await f.create(source, "worker");
		const invocation = await f.invoke(source, "worker", "before-migration");
		const sourceFile = source.getSessionFile()!;
		const sourceRecords = records(sourceFile);
		const resultRecord = sourceRecords.find((record) => record.id === invocation.resultEntryId);
		const disk = resultRecord.message.details.result as SingleResult;
		const { transcript: _transcript, finalText: _finalText, sessionFile: _sessionFile, ...rest } = disk;
		const inline: SingleResult = { ...rest, messages: readResultPage(disk).messages };
		if (direction.startsWith("normalized fork")) resultRecord.message.details.result = inline;
		writeFileSync(sourceFile, sourceRecords.map((record) => JSON.stringify(record)).join("\n") + "\n");
		source = SessionManager.open(sourceFile, dirname(sourceFile));
		const sourceBytes = readFileSync(sourceFile);
		const childBytes = readFileSync(state(f, source, "worker").resume.filePath);
		const launches = f.runner.calls.length;
		for (const mutation of ["none", "task", "middle-message", "wrapper", "missing-record"]) {
			let fork = forkCurrent(f, source, `migration-${mutation}`);
			const forkFile = fork.getSessionFile()!;
			const forkRecords = records(forkFile);
			const forkRecord = forkRecords.find((record) => record.id === invocation.resultEntryId);
			const changed = structuredClone(inline);
			if (mutation === "task") changed.task = "different task";
			if (mutation === "middle-message") changed.messages[0].content = "different original prompt";
			const forkResult = direction.startsWith("normalized fork") || mutation === "missing-record"
				? normalizeSingleResult(changed) : changed;
			forkRecord.message.details.result = forkResult;
			if (mutation === "wrapper") forkRecord.message.content[0].text += " changed wrapper";
			if (mutation === "missing-record") rmSync(join(forkResult.transcript!.directory, "0.json"));
			writeFileSync(forkFile, forkRecords.map((record) => JSON.stringify(record)).join("\n") + "\n");
			fork = SessionManager.open(forkFile, dirname(forkFile));
			const restored = await f.restore(fork);
			assert.deepEqual(restored.inherited, mutation === "none" ? ["worker"] : []);
			if (mutation === "missing-record") assert.match(restored.failures[0]?.error ?? "", /ENOENT/);
			if (mutation === "none") assert.match(texts(state(f, fork, "worker").resume.filePath).join("\n"), /child-answer:before-migration/);
		}
		assert.equal(f.runner.calls.length, launches);
		assert.deepEqual(readFileSync(sourceFile), sourceBytes);
		assert.deepEqual(readFileSync(state(f, source, "worker").resume.filePath), childBytes);
	});
}

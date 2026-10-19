import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CURRENT_SESSION_VERSION,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
	type SessionHeader,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	CAPABILITY_TOOLS,
	type AgentCapabilities,
	type AgentConfig,
	type ModelSize,
	MODEL_SIZE_DESCRIPTION,
	discoverAgents,
	formatAgentList,
} from "./agents.js";
import type {
	ContextMode,
	ForkContext,
	ResumeHandle,
	SingleResult,
	SubagentDetails,
} from "./index.js";
import { parseForkTurns, selectForkMessages, writeResumableForkSession } from "./fork-context.js";
import { acquireContinuationLease } from "./continuation-store.js";
import { isQuotaError } from "./quota-error.js";
import {
	renderNamedCreateCall,
	renderNamedCreateResult,
	renderNamedInvokeCall,
	renderNamedInvokeResult,
} from "./monitor-ui.js";
import type { MonitorRunHandle, SubagentMonitorStore } from "./monitor.js";
import type { SubagentParentContext } from "../lib/pi-subprocess.js";

import { normalizeSingleResult, resultOutput, sameMigratedResult } from "./result-store.js";
import { appendSessionRecord, recoverSessionTail, sessionMetadata, sessionRecords } from "./session-records.js";

const NAMED_SUBAGENT_VERSION = 1;
const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const CHECKPOINT_TYPE = "named-subagent-checkpoint";
export const NAMED_SUBAGENT_CONTINUATION_RESULT_TYPE = "named-subagent-continuation-result";

type NamedInvocationReceipt = {
	version: 1;
	toolCallId: string;
	prompt?: string;
	continueOnly?: true;
	phase: "prior" | "prompt";
	existingSession?: ResumeHandle;
	result?: SingleResult;
};

export type NamedSubagentState = {
	version: typeof NAMED_SUBAGENT_VERSION;
	parentSessionId: string;
	name: string;
	description: string;
	template: string;
	size: ModelSize;
	capabilities: AgentCapabilities;
	tools: string[];
	instructions: string;
	cwd: string;
	history: string;
	contextMode: ContextMode;
	resume: ResumeHandle;
	pending?: SingleResult;
	continuation?: NamedInvocationReceipt;
	createdAt: number;
	updatedAt: number;
};

function namedRoot(parentSessionId: string, root = path.join(getAgentDir(), "subagent-runs", "named")) {
	return path.join(root, createHash("sha256").update(parentSessionId).digest("hex"));
}

function statePath(parentSessionId: string, name: string, root?: string) {
	return path.join(namedRoot(parentSessionId, root), `${name}.json`);
}

function ensurePrivateDirectory(directory: string) {
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	fs.chmodSync(directory, 0o700);
}

function fsyncDirectory(directory: string) {
	const descriptor = fs.openSync(directory, "r");
	try {
		fs.fsyncSync(descriptor);
	} finally {
		fs.closeSync(descriptor);
	}
}

function writePrivateJson(file: string, value: unknown) {
	const directory = path.dirname(file);
	ensurePrivateDirectory(directory);
	const temporary = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
	let descriptor: number | undefined;
	try {
		descriptor = fs.openSync(temporary, "wx", 0o600);
		fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`);
		fs.fsyncSync(descriptor);
		fs.closeSync(descriptor);
		descriptor = undefined;
		fs.renameSync(temporary, file);
		fs.chmodSync(file, 0o600);
		fsyncDirectory(directory);
	} finally {
		if (descriptor !== undefined) fs.closeSync(descriptor);
		fs.rmSync(temporary, { force: true });
	}
}

function writeState(state: NamedSubagentState, root?: string) {
	if (state.pending) state.pending = normalizeSingleResult(state.pending);
	if (state.continuation?.result) state.continuation.result = normalizeSingleResult(state.continuation.result);
	writePrivateJson(statePath(state.parentSessionId, state.name, root), state);
}

function isState(value: unknown): value is NamedSubagentState {
	if (!value || typeof value !== "object") return false;
	const state = value as Partial<NamedSubagentState>;
	return state.version === NAMED_SUBAGENT_VERSION
		&& typeof state.parentSessionId === "string"
		&& typeof state.name === "string"
		&& typeof state.instructions === "string"
		&& typeof state.cwd === "string"
		&& (state.size === "small" || state.size === "big" || state.size === "biggest")
		&& (state.capabilities === "general" || state.capabilities === "research")
		&& Array.isArray(state.tools)
		&& !!state.resume
		&& typeof state.resume.filePath === "string";
}

export function readNamedSubagent(parentSessionId: string, name: string, root?: string) {
	if (!NAME_PATTERN.test(name)) return undefined;
	try {
		const parsed = JSON.parse(fs.readFileSync(statePath(parentSessionId, name, root), "utf8"));
		return isState(parsed) && parsed.parentSessionId === parentSessionId && parsed.name === name ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export function listNamedSubagents(parentSessionId: string, root?: string) {
	let names: string[];
	try {
		names = fs.readdirSync(namedRoot(parentSessionId, root));
	} catch {
		return [];
	}
	return names
		.filter((name) => name.endsWith(".json"))
		.map((name) => readNamedSubagent(parentSessionId, name.slice(0, -5), root))
		.filter((state): state is NamedSubagentState => !!state);
}

type CheckpointReference = {
	version: 1;
	name: string;
	parentSessionId: string;
	checkpointId: string;
	toolCallId?: string;
};

type NamedCheckpoint = { version: 1; state: NamedSubagentState; leafId: string };
type SessionFile = { filePath: string; header: SessionHeader; entries: SessionEntry[]; byId: Map<string, SessionEntry> };
type ForkCandidate = { name: string; entry: SessionEntry; reference?: CheckpointReference; toolCallId?: string };

function childMessageTextParts(message: any) {
	if (typeof message?.content === "string") return [message.content];
	if (!Array.isArray(message?.content)) return [];
	return message.content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text);
}

type NamedMonitorInvocation = { boundaryId: string; task?: string };

function namedMonitorInvocations(state: NamedSubagentState) {
	const invocations: NamedMonitorInvocation[] = [];
	let afterCreationBoundary = false;
	for (const entry of sessionRecords(privateNamedFile(state.resume.filePath, state.parentSessionId, "children"), true)) {
		if (!afterCreationBoundary) {
			if (entry.id === state.resume.baselineEntryId) afterCreationBoundary = true;
			continue;
		}
		if (entry.type === "custom" && entry.customType === "subagent-run-boundary") {
			invocations.push({ boundaryId: entry.id });
			continue;
		}
		if (entry.type !== "message" || entry.message.role !== "user" || invocations.length === 0) continue;
		const text = childMessageTextParts(entry.message).join("\n");
		if (text.startsWith("Task: ") && invocations.at(-1)!.task === undefined) {
			invocations.at(-1)!.task = text.slice("Task: ".length);
		}
	}
	return invocations;
}

export function namedMonitorTasks(state: NamedSubagentState, prompt?: string) {
	const invocations = namedMonitorInvocations(state);
	const fillBoundary = (boundaryId: string | undefined, task: string | undefined) => {
		if (!boundaryId || task === undefined) return false;
		const invocation = invocations.find((item) => item.boundaryId === boundaryId);
		if (!invocation) return false;
		invocation.task ??= task;
		return true;
	};
	fillBoundary(state.pending?.resume?.baselineEntryId, state.pending?.task);
	const receipt = state.continuation;
	let currentRecorded = false;
	if (prompt !== undefined && receipt?.phase === "prompt") {
		currentRecorded = fillBoundary(receipt.existingSession?.baselineEntryId, prompt)
			|| fillBoundary(receipt.result?.resume?.baselineEntryId, prompt)
			|| (state.pending?.task === prompt && fillBoundary(state.pending.resume?.baselineEntryId, prompt));
	}
	const tasks = invocations.flatMap((invocation) => invocation.task === undefined ? [] : [invocation.task]);
	if (prompt !== undefined && !currentRecorded) tasks.push(prompt);
	return tasks;
}

function readSessionFile(filePath: string, retainedIds?: ReadonlySet<string>): SessionFile {
	const canonical = fs.realpathSync(filePath);
	// SessionManager.open can repair or migrate its input. Ancestors are read-only.
	// Never turn a whole transcript into one string: Node limits individual strings.
	let header: SessionHeader | undefined;
	const entries: SessionEntry[] = [];
	const byId = new Map<string, SessionEntry>();
	const seen = new Set<string>();
	for (const entry of sessionRecords(canonical, true)) {
		if (!header) {
			if (entry?.type !== "session" || typeof entry.id !== "string") throw new Error(`Invalid saved session: ${filePath}`);
			header = entry;
			continue;
		}
		if (entry.type === "session") continue;
		if (seen.has(entry.id)) throw new Error(`Duplicate session entry IDs: ${filePath}`);
		seen.add(entry.id);
		if (retainedIds && !retainedIds.has(entry.id)) continue;
		entries.push(entry);
		byId.set(entry.id, entry);
	}
	if (!header) throw new Error(`Invalid saved session: ${filePath}`);
	return { filePath: canonical, header, entries, byId };
}

function branchAt(session: SessionFile, leafId: string) {
	const branch: SessionEntry[] = [];
	const seen = new Set<string>();
	let id: string | null = leafId;
	while (id !== null) {
		const entry = session.byId.get(id);
		if (!entry || seen.has(id)) throw new Error(`Saved child checkpoint is missing or invalid: ${leafId}`);
		seen.add(id);
		branch.push(entry);
		id = entry.parentId;
	}
	return branch.reverse();
}

function privateNamedFile(filePath: string, parentSessionId: string, directory: "children" | "checkpoints") {
	if (!fs.lstatSync(filePath).isFile()) throw new Error(`Saved named subagent file is not a regular file: ${filePath}`);
	const canonical = fs.realpathSync(filePath);
	const relative = path.relative(fs.realpathSync(namedRoot(parentSessionId)), canonical);
	if (!relative.startsWith(`${directory}${path.sep}`)) throw new Error(`Saved named subagent file escapes its ${directory} storage: ${filePath}`);
	return canonical;
}

function readNamedChild(state: NamedSubagentState) {
	const filePath = privateNamedFile(state.resume.filePath, state.parentSessionId, "children");
	// A live writer may be midway through its next append. Pin only complete records.
	const session = { filePath, ...sessionMetadata(filePath, true) };
	if (state.resume.sessionId && session.header.id !== state.resume.sessionId) throw new Error(`Saved child session identity changed for ${state.name}.`);
	return session;
}

function checkpointReference(value: unknown): CheckpointReference | undefined {
	const reference = value as Partial<CheckpointReference> | undefined;
	return reference?.version === 1 && typeof reference.name === "string" && NAME_PATTERN.test(reference.name)
		&& typeof reference.parentSessionId === "string" && typeof reference.checkpointId === "string"
		&& /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reference.checkpointId)
		? reference as CheckpointReference : undefined;
}

function checkpointPath(reference: CheckpointReference) {
	return path.join(namedRoot(reference.parentSessionId), "checkpoints", `${reference.checkpointId}.json`);
}

function readCheckpoint(reference: CheckpointReference): NamedCheckpoint {
	const file = privateNamedFile(checkpointPath(reference), reference.parentSessionId, "checkpoints");
	const checkpoint = JSON.parse(fs.readFileSync(file, "utf8"));
	if (checkpoint?.version !== 1 || !isState(checkpoint.state) || typeof checkpoint.leafId !== "string"
		|| checkpoint.state.parentSessionId !== reference.parentSessionId || checkpoint.state.name !== reference.name) {
		throw new Error(`Invalid named subagent checkpoint: ${reference.name}`);
	}
	return checkpoint;
}

function recordNamedCheckpoint(pi: ExtensionAPI, state: NamedSubagentState, toolCallId?: string) {
	const session = readNamedChild(state);
	const leafId = session.entries.at(-1)?.id;
	if (!leafId) throw new Error(`Saved child history is empty for ${state.name}.`);
	const reference: CheckpointReference = {
		version: 1, name: state.name, parentSessionId: state.parentSessionId, checkpointId: randomUUID(),
		...(toolCallId ? { toolCallId } : {}),
	};
	const file = checkpointPath(reference);
	writePrivateJson(file, { version: 1, state, leafId } satisfies NamedCheckpoint);
	try {
		// Only a reference enters the parent transcript; private child state stays 0600.
		pi.appendEntry(CHECKPOINT_TYPE, reference);
	} catch (error) {
		fs.rmSync(file, { force: true });
		throw error;
	}
}

function forkCandidates(branch: SessionEntry[]) {
	const candidates = new Map<string, ForkCandidate>();
	const calls = new Map<string, { name: string; toolName: string }>();
	for (const entry of branch) {
		if (entry.type === "custom" && entry.customType === CHECKPOINT_TYPE) {
			const reference = checkpointReference(entry.data);
			if (reference) candidates.set(reference.name, { name: reference.name, entry, reference, toolCallId: reference.toolCallId });
		} else if (entry.type === "message") {
			const message = entry.message;
			if (message.role === "assistant") {
				for (const part of message.content) {
					if (part.type === "toolCall" && (part.name === "create_subagent" || part.name === "invoke_subagent")
						&& typeof part.arguments?.name === "string" && NAME_PATTERN.test(part.arguments.name)) {
						calls.set(part.id, { name: part.arguments.name, toolName: part.name });
					}
				}
			} else if (message.role === "toolResult" && !message.isError) {
				const call = calls.get(message.toolCallId);
				if (!call || call.toolName !== message.toolName || message.details?.name !== call.name) continue;
				if (candidates.get(call.name)?.toolCallId === message.toolCallId) continue;
				candidates.set(call.name, { name: call.name, entry, toolCallId: message.toolCallId });
			}
		}
	}
	return candidates;
}

function sameForkEntry(left: SessionEntry | undefined, right: SessionEntry) {
	if (!left) return false;
	// Native extraction can re-chain entries around labels, but preserves payloads/IDs.
	const { parentId: _leftParent, ...leftValue } = left;
	const { parentId: _rightParent, ...rightValue } = right;
	if (isDeepStrictEqual(leftValue, rightValue)) return true;
	if (leftValue.type !== "message" || rightValue.type !== "message") return false;
	const a = leftValue.message as any, b = rightValue.message as any;
	if (a.role !== "toolResult" || b.role !== "toolResult" || a.toolName !== "invoke_subagent" || b.toolName !== "invoke_subagent"
		|| !isSingleResult(a.details?.result) || !isSingleResult(b.details?.result)) return false;
	const withoutResult = (entry: any) => ({ ...entry, message: { ...entry.message, details: { ...entry.message.details, result: null } } });
	return isDeepStrictEqual(withoutResult(leftValue), withoutResult(rightValue)) && sameMigratedResult(a.details.result, b.details.result);
}

function legacyCheckpoint(state: NamedSubagentState, candidate: ForkCandidate): NamedCheckpoint {
	const entry = candidate.entry;
	if (entry.type !== "message" || entry.message.role !== "toolResult") throw new Error("Invalid legacy named subagent record.");
	const session = readNamedChild(state);
	const restored = structuredClone(state);
	delete restored.pending;
	delete restored.continuation;
	let leafId = state.resume.baselineEntryId;
	if (entry.message.toolName === "invoke_subagent") {
		const result = entry.message.details?.result as SingleResult | undefined;
		if (!result?.resume || !Array.isArray(result.messages)
			|| fs.realpathSync(result.resume.filePath) !== session.filePath) throw new Error(`Cannot recover the recorded invocation of ${state.name}.`);
		const lastMessage = result.messages.at(-1);
		const savedLast = result.transcript?.lastMessage;
		if (lastMessage || savedLast) {
			let matchingId: string | undefined;
			for (const item of sessionRecords(session.filePath)) {
				if (item.type !== "message" || item.message.role !== (lastMessage?.role ?? savedLast!.role)
					|| item.message.timestamp !== (lastMessage?.timestamp ?? savedLast?.timestamp)) continue;
				if (lastMessage ? isDeepStrictEqual(item.message, lastMessage)
					: createHash("sha256").update(JSON.stringify(item.message)).digest("hex") === savedLast!.sha256) matchingId = item.id;
			}
			if (!matchingId) throw new Error(`The recorded child message is missing for ${state.name}; refusing to use newer history.`);
			leafId = matchingId;
		} else {
			leafId = result.resume.baselineEntryId;
			const index = session.entries.findIndex((item) => item.id === leafId);
			if (index < 0) throw new Error(`The recorded invocation boundary is missing for ${state.name}.`);
			// A pre-launch interruption has no messages. Preserve any durable progress
			// before its parent result, stopping before the next invocation boundary.
			for (const item of session.entries.slice(index + 1)) {
				if (item.timestamp > entry.timestamp || item.type === "custom" && item.customType === "subagent-run-boundary") break;
				leafId = item.id;
			}
		}
		if (result.status === "interrupted" || result.status === "pending" || result.status === "running") restored.pending = normalizeSingleResult(result);
	}
	branchAt(session, leafId);
	return { version: 1, state: restored, leafId };
}

function cloneNamedCheckpoint(checkpoint: NamedCheckpoint, parentSessionId: string): NamedSubagentState {
	const source = checkpoint.state;
	const session = readNamedChild(source);
	const branch = branchAt(session, checkpoint.leafId);
	const ids = new Set(branch.map((entry) => entry.id));
	if (!ids.has(source.resume.baselineEntryId)) throw new Error(`Child history boundary is missing for ${source.name}.`);
	if (source.pending && (!source.pending.resume || !ids.has(source.pending.resume.baselineEntryId)
		|| fs.realpathSync(source.pending.resume.filePath) !== session.filePath)) {
		throw new Error(`Interrupted task has an invalid child session or boundary for ${source.name}.`);
	}
	const receiptHandles = [source.continuation?.existingSession, source.continuation?.result?.resume].filter(
		(handle): handle is ResumeHandle => !!handle,
	);
	if (receiptHandles.some((handle) => !ids.has(handle.baselineEntryId)
		|| fs.realpathSync(handle.filePath) !== session.filePath)) {
		throw new Error(`Named invocation receipt has an invalid child session or boundary for ${source.name}.`);
	}
	const root = path.join(namedRoot(parentSessionId), "children");
	ensurePrivateDirectory(root);
	const runId = randomUUID();
	const dir = path.join(root, runId);
	fs.mkdirSync(dir, { mode: 0o700 });
	const resume: ResumeHandle = {
		runId, dir, filePath: path.join(dir, "session.jsonl"), sessionId: randomUUID(), baselineEntryId: source.resume.baselineEntryId,
	};
	try {
		const header: SessionHeader = {
			type: "session", version: CURRENT_SESSION_VERSION, id: resume.sessionId!, timestamp: new Date().toISOString(),
			cwd: source.cwd, parentSession: source.resume.filePath,
		};
		const descriptor = fs.openSync(resume.filePath, "wx", 0o600);
		try {
			fs.writeFileSync(descriptor, `${JSON.stringify(header)}\n`);
			for (const entry of sessionRecords(session.filePath)) {
				if (ids.has(entry.id)) fs.writeFileSync(descriptor, `${JSON.stringify(entry)}\n`);
				if (entry.id === checkpoint.leafId) break;
			}
			fs.fsyncSync(descriptor);
		} finally {
			fs.closeSync(descriptor);
		}
		fsyncDirectory(dir);
		fsyncDirectory(root);
		const state = structuredClone(source);
		state.parentSessionId = parentSessionId;
		state.resume = resume;
		state.updatedAt = Date.now();
		if (state.pending) {
			state.pending.resume = { ...resume, baselineEntryId: source.pending!.resume!.baselineEntryId };
			state.pending.sessionId = resume.sessionId;
			state.pending.sessionFile = resume.filePath;
			if (state.pending.status === "running") {
				state.pending.status = "interrupted";
				state.pending.stopReason = "aborted";
				state.pending.exitCode = 130;
			}
		}
		if (state.continuation?.existingSession) {
			state.continuation.existingSession = {
				...resume,
				baselineEntryId: source.continuation.existingSession.baselineEntryId,
			};
		}
		if (state.continuation?.result?.resume) {
			state.continuation.result.resume = {
				...resume,
				baselineEntryId: source.continuation.result.resume.baselineEntryId,
			};
			state.continuation.result.sessionId = resume.sessionId;
			state.continuation.result.sessionFile = resume.filePath;
			if (state.continuation.result.status === "running") {
				state.continuation.result.status = "interrupted";
				state.continuation.result.stopReason = "aborted";
				state.continuation.result.exitCode = 130;
			}
		}
		writeState(state);
		return state;
	} catch (error) {
		if (readNamedSubagent(parentSessionId, source.name)?.resume.filePath !== resume.filePath) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
		throw error;
	}
}

export async function restoreNamedSubagents(pi: ExtensionAPI, ctx: ExtensionContext) {
	const result: { inherited: string[]; failures: Array<{ name: string; error: string }> } = { inherited: [], failures: [] };
	const parentSessionId = ctx.sessionManager.getSessionId();
	const header = ctx.sessionManager.getHeader?.();
	const branch = ctx.sessionManager.getBranch?.() ?? [];
	const candidates = forkCandidates(branch);
	const candidateIds = new Set([...candidates.values()].map((candidate) => candidate.entry.id));
	const sessions = new Map<string, SessionFile>();
	const failure = (name: string, error: unknown) => result.failures.push({ name, error: error instanceof Error ? error.message : String(error) });
	for (const candidate of candidates.values()) {
		if (readNamedSubagent(parentSessionId, candidate.name) || candidate.reference?.parentSessionId === parentSessionId) continue;
		if (!header?.parentSession || header.id !== parentSessionId) continue;
		let release: (() => void) | undefined;
		try {
			release = acquireContinuationLease(`named:${candidate.name}`, parentSessionId);
			if (readNamedSubagent(parentSessionId, candidate.name)) continue;
			if (fs.existsSync(statePath(parentSessionId, candidate.name))) throw new Error("Existing local named state is invalid; refusing to overwrite it.");
			let file = path.resolve(path.dirname(ctx.sessionManager.getSessionFile() ?? ctx.cwd), header.parentSession);
			const seen = new Set<string>();
			let legacyOwner: SessionFile | undefined;
			for (let depth = 0; depth < 64; depth++) {
				const canonical = fs.realpathSync(file);
				if (seen.has(canonical)) throw new Error("Cyclic parent session ancestry.");
				seen.add(canonical);
				let ancestor = sessions.get(canonical);
				if (!ancestor) {
					ancestor = readSessionFile(canonical, candidateIds);
					sessions.set(canonical, ancestor);
				}
				// A parentSession header by itself also describes synthetic child contexts.
				if (!sameForkEntry(ancestor.byId.get(candidate.entry.id), candidate.entry)) break;
				let checkpoint: NamedCheckpoint | undefined;
				if (candidate.reference) {
					if (candidate.reference.parentSessionId === ancestor.header.id) checkpoint = readCheckpoint(candidate.reference);
				} else {
					// A closer fork may already own a different child with this name.
					// Legacy records belong to the ancestor that originally wrote them.
					legacyOwner = ancestor;
				}
				if (checkpoint) {
					cloneNamedCheckpoint(checkpoint, parentSessionId);
					result.inherited.push(candidate.name);
					break;
				}
				if (!ancestor.header.parentSession) break;
				if (depth === 63) throw new Error("Parent session ancestry exceeds 64 generations.");
				file = path.resolve(path.dirname(ancestor.filePath), ancestor.header.parentSession);
			}
			if (legacyOwner) {
				const state = readNamedSubagent(legacyOwner.header.id, candidate.name);
				if (!state) throw new Error(`Saved named state is missing in the original session: ${candidate.name}`);
				cloneNamedCheckpoint(legacyCheckpoint(state, candidate), parentSessionId);
				result.inherited.push(candidate.name);
			}
		} catch (error) {
			failure(candidate.name, error);
		} finally {
			release?.();
		}
	}
	// Upgrade existing local threads and pin adopted copies for further forks.
	for (const state of listNamedSubagents(parentSessionId)) {
		try {
			const reference = candidates.get(state.name)?.reference;
			if (reference?.parentSessionId === parentSessionId) {
				const saved = readCheckpoint(reference);
				if (isDeepStrictEqual(saved.state, state) && saved.leafId === readNamedChild(state).entries.at(-1)?.id) continue;
			}
			recordNamedCheckpoint(pi, state);
		} catch (error) {
			failure(state.name, error);
		}
	}
	return result;
}

async function resolveNamedSubagent(pi: ExtensionAPI, ctx: ExtensionContext, name: string) {
	if (!NAME_PATTERN.test(name)) throw new Error("Subagent name must be lowercase kebab-case (1-64 characters).");
	const parentSessionId = ctx.sessionManager.getSessionId();
	const existing = readNamedSubagent(parentSessionId, name);
	if (existing) return existing;
	const restored = await restoreNamedSubagents(pi, ctx);
	const state = readNamedSubagent(parentSessionId, name);
	if (state) return state;
	const error = restored.failures.find((failure) => failure.name === name);
	if (error) throw new Error(`Could not inherit named subagent ${name}: ${error.error}`);
	throw new Error(`Unknown named subagent: ${name}. Available: ${availableNames(listNamedSubagents(parentSessionId))}`);
}

function invocationSession(state: NamedSubagentState): ResumeHandle {
	state.resume.filePath = recoverSessionTail(state.resume.filePath);
	const baselineEntryId = appendSessionRecord(state.resume.filePath, { type: "custom", customType: "subagent-run-boundary", data: {} });
	return { ...state.resume, baselineEntryId };
}

function finalOutput(result: SingleResult) {
	return resultOutput(result) || result.errorMessage || result.stderr || "(no output)";
}

function capabilitiesFor(agent: AgentConfig): AgentCapabilities {
	if (agent.capabilities) return agent.capabilities;
	return agent.tools?.some((tool) => tool === "exa_search" || tool === "write") ? "research" : "general";
}

function agentFromState(state: NamedSubagentState): AgentConfig {
	return {
		name: state.name,
		description: state.description,
		tools: state.tools,
		size: state.size,
		capabilities: state.capabilities,
		cwd: state.cwd,
		cwdBase: undefined,
		history: state.history,
		contextMode: state.contextMode,
		systemPrompt: state.instructions,
		source: "user",
		filePath: statePath(state.parentSessionId, state.name),
	};
}

function availableNames(states: NamedSubagentState[]) {
	return states.length ? states.map((state) => `${state.name} [${state.size}]`).join(", ") : "none";
}

function safeDescription(value: string) {
	return JSON.stringify(value);
}

function projectRoot(cwd: string) {
	let current = fs.realpathSync(cwd);
	while (true) {
		if (fs.existsSync(path.join(current, ".git"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return fs.realpathSync(cwd);
		current = parent;
	}
}

function ensureSafeExportDirectory(root: string) {
	let current = root;
	for (const component of [".agents", "subagents"]) {
		current = path.join(current, component);
		if (fs.existsSync(current)) {
			const stat = fs.lstatSync(current);
			if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe export directory: ${current}`);
		} else {
			fs.mkdirSync(current, { mode: 0o755 });
		}
	}
	const resolved = fs.realpathSync(current);
	if (resolved !== path.join(root, ".agents", "subagents")) throw new Error("Export directory escapes the project root.");
	return resolved;
}

function writeExclusiveAtomic(destination: string, content: string) {
	const directory = path.dirname(destination);
	const temporary = path.join(directory, `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`);
	let descriptor: number | undefined;
	try {
		descriptor = fs.openSync(temporary, "wx", 0o644);
		fs.writeFileSync(descriptor, content, "utf8");
		fs.fsyncSync(descriptor);
		fs.closeSync(descriptor);
		descriptor = undefined;
		fs.linkSync(temporary, destination);
		fsyncDirectory(directory);
	} finally {
		if (descriptor !== undefined) fs.closeSync(descriptor);
		fs.rmSync(temporary, { force: true });
	}
}

function exportedCwd(projectRoot: string, cwd: string) {
	const canonicalCwd = fs.realpathSync(cwd);
	const relative = path.relative(projectRoot, canonicalCwd);
	if (relative === "") return ".";
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`Cannot export subagent cwd ${canonicalCwd} outside project ${projectRoot}.`);
	}
	return relative.split(path.sep).join("/");
}

function renderExport(state: NamedSubagentState, description: string, root: string) {
	const header = [
		"---",
		`name: ${state.name}`,
		`description: ${safeDescription(description)}`,
		`size: ${state.size}`,
		`capabilities: ${state.capabilities}`,
		`tools: ${state.tools.join(", ")}`,
		`cwd: ${JSON.stringify(exportedCwd(root, state.cwd))}`,
		`history: ${JSON.stringify(state.history)}`,
		`context: ${state.contextMode}`,
		"---",
		"",
	].join("\n");
	return `${header}${state.instructions}${state.instructions.endsWith("\n") ? "" : "\n"}`;
}

const SizeSchema = StringEnum(["small", "big", "biggest"] as const, {
	description: MODEL_SIZE_DESCRIPTION,
});
const ContextSchema = StringEnum(["default", "none", "cwd-only"] as const);

export type NamedSubagentDependencies = {
	runSingleAgent: (
		defaultCwd: string,
		agents: AgentConfig[],
		agentName: string,
		task: string,
		cwd: string | undefined,
		contextMode: ContextMode,
		modelOverride: string | undefined,
		forkContext: ForkContext | undefined,
		step: number | undefined,
		signal: AbortSignal | undefined,
		onUpdate: ((partial: any) => void) | undefined,
		makeDetails: (results: SingleResult[]) => SubagentDetails,
		options: { parentContext?: SubagentParentContext; resumeFrom?: SingleResult; existingSession?: ResumeHandle; onCheckpoint?: (result: SingleResult) => void; retainTerminalSession?: boolean; monitor?: MonitorRunHandle },
	) => Promise<SingleResult>;
	sizedModel: (size: ModelSize, provider?: string) => string;
	monitor?: SubagentMonitorStore;
};

type NamedInvocationCall = {
	name: string;
	toolCallId: string;
	prompt?: string;
	continueOnly?: true;
	recordedResult?: SingleResult;
};

function invocationReceipt(call: NamedInvocationCall, phase: "prior" | "prompt", result?: SingleResult): NamedInvocationReceipt {
	return {
		version: 1,
		toolCallId: call.toolCallId,
		...(call.continueOnly ? { continueOnly: true as const } : { prompt: call.prompt }),
		phase,
		...(result ? { result } : {}),
	};
}

function isSingleResult(value: unknown): value is SingleResult {
	const result = value as Partial<SingleResult> | undefined;
	return !!result && typeof result.agent === "string" && typeof result.task === "string"
		&& typeof result.exitCode === "number" && Array.isArray(result.messages);
}

function outstandingNamedInvocations(branch: SessionEntry[]) {
	const calls: NamedInvocationCall[] = [];
	const terminal = new Set<string>();
	const recoverable = new Map<string, SingleResult>();
	const delivered = new Set<string>();
	for (const entry of branch) {
		if (entry.type === "message" && entry.message.role === "assistant"
			&& entry.message.stopReason !== "aborted" && entry.message.stopReason !== "error") {
			for (const part of entry.message.content) {
				if (part.type !== "toolCall" || part.name !== "invoke_subagent"
					|| typeof part.id !== "string" || typeof part.arguments?.name !== "string"
					|| !NAME_PATTERN.test(part.arguments.name)) continue;
				const hasPromptField = part.arguments.prompt !== undefined;
				const hasContinueField = part.arguments.continue !== undefined;
				const promptMode = typeof part.arguments.prompt === "string" && !hasContinueField;
				const continueOnly = !hasPromptField && part.arguments.continue === true;
				if (!promptMode && !continueOnly) continue;
				calls.push({
					name: part.arguments.name,
					toolCallId: part.id,
					...(continueOnly ? { continueOnly: true } : { prompt: part.arguments.prompt }),
				});
			}
		} else if (entry.type === "message" && entry.message.role === "toolResult"
			&& entry.message.toolName === "invoke_subagent") {
			const result = entry.message.details?.result;
			if (isSingleResult(result) && (resumableNamedResult(result) || olderQuotaFailure(result))) {
				recoverable.set(entry.message.toolCallId, result);
			} else {
				terminal.add(entry.message.toolCallId);
			}
		} else if (entry.type === "custom_message" && entry.customType === NAMED_SUBAGENT_CONTINUATION_RESULT_TYPE) {
			const ids = (entry.details as { toolCallIds?: unknown } | undefined)?.toolCallIds;
			if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") delivered.add(id);
		}
	}
	return calls
		.filter((call) => !terminal.has(call.toolCallId) && !delivered.has(call.toolCallId))
		.map((call) => ({ ...call, ...(recoverable.has(call.toolCallId) ? { recordedResult: recoverable.get(call.toolCallId) } : {}) }));
}

export function hasOutstandingNamedInvocations(branch: SessionEntry[]) {
	return outstandingNamedInvocations(branch).length > 0;
}

function resumableNamedResult(result: SingleResult) {
	return result.status === "interrupted" || result.status === "pending" || result.status === "running";
}

function completedNamedResult(result: SingleResult) {
	return result.status === "completed";
}

function saveNamedInvocation(pi: ExtensionAPI, state: NamedSubagentState, toolCallId: string) {
	state.updatedAt = Date.now();
	writeState(state);
	recordNamedCheckpoint(pi, state, toolCallId);
}

function namedFailure(state: NamedSubagentState, task: string, errorMessage: string): SingleResult {
	return {
		agent: state.name,
		agentSource: "user",
		task,
		exitCode: 1,
		messages: [],
		stderr: "",
		status: "failed",
		stopReason: "error",
		errorMessage,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
	};
}

function noPendingContinuation(state: NamedSubagentState): SingleResult {
	const message = `No interrupted work is pending for ${state.name}; nothing was started.`;
	return {
		agent: state.name,
		agentSource: "user",
		task: "Continue pending work",
		exitCode: 0,
		messages: [{
			role: "assistant",
			content: [{ type: "text", text: message }],
			api: "subagent-control",
			provider: "subagent",
			model: "control",
			usage: {
				input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		} as any],
		stderr: "",
		status: "completed",
		stopReason: "stop",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
	};
}

function olderQuotaFailure(result: SingleResult) {
	// Older runners reported quota exhaustion as a terminal failure. Restrict this
	// migration to provider-level error fields; child tool output is never classified.
	return result.status === "failed" && !!result.resume && isQuotaError(result.errorMessage);
}

function beginNamedInvocation(
	pi: ExtensionAPI,
	state: NamedSubagentState,
	call: NamedInvocationCall,
	branch?: SessionEntry[],
) {
	if (state.continuation?.toolCallId === call.toolCallId) return;

	let sawCheckpoint = false;
	let terminal: SingleResult | undefined;
	if (branch) {
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			if (entry.type !== "custom" || entry.customType !== CHECKPOINT_TYPE) continue;
			const reference = checkpointReference(entry.data);
			if (!reference || reference.name !== call.name || reference.toolCallId !== call.toolCallId
				|| reference.parentSessionId !== state.parentSessionId) continue;
			sawCheckpoint = true;
			let checkpoint: NamedCheckpoint;
			try {
				checkpoint = readCheckpoint(reference);
			} catch {
				continue;
			}
			if (checkpoint.state.continuation?.toolCallId === call.toolCallId) {
				const savedReceipt = structuredClone(checkpoint.state.continuation);
				let savedPending = structuredClone(checkpoint.state.pending);
				const completedPrior = state.continuation?.result;
				if (savedReceipt.phase === "prior" && savedPending && completedPrior?.status === "completed"
					&& completedPrior.task === savedPending.task) {
					if (savedReceipt.continueOnly) savedReceipt.result = completedPrior;
					else savedReceipt.phase = "prompt";
					savedPending = undefined;
				}
				state.continuation = savedReceipt;
				state.pending = savedPending;
				saveNamedInvocation(pi, state, call.toolCallId);
				return;
			}
			const previous = checkpoint.state.pending;
			if (!previous?.resume) continue;
			if (resumableNamedResult(previous) || olderQuotaFailure(previous)) {
				state.pending = previous;
				state.continuation = invocationReceipt(call, call.continueOnly ? "prior" : "prompt");
				saveNamedInvocation(pi, state, call.toolCallId);
				return;
			}
			terminal ??= previous;
		}
	}

	if (call.recordedResult?.resume && (resumableNamedResult(call.recordedResult) || olderQuotaFailure(call.recordedResult))) {
		const recorded = structuredClone(call.recordedResult);
		if (path.resolve(recorded.resume!.filePath) !== path.resolve(state.resume.filePath)) {
			recorded.resume = { ...state.resume, baselineEntryId: recorded.resume!.baselineEntryId };
			recorded.sessionId = state.resume.sessionId;
			recorded.sessionFile = state.resume.filePath;
		}
		state.pending = recorded;
		state.continuation = invocationReceipt(call, call.continueOnly ? "prior" : "prompt");
		saveNamedInvocation(pi, state, call.toolCallId);
		return;
	}

	if (branch && (terminal || sawCheckpoint)) {
		state.pending = undefined;
		const result = terminal ?? (call.continueOnly
			? noPendingContinuation(state)
			: namedFailure(
				state,
				call.prompt!,
				"The named child may have run before its parent stopped, but no resumable receipt was saved. Refusing to restart it blindly.",
			));
		state.continuation = invocationReceipt(call, call.continueOnly ? "prior" : "prompt", result);
		saveNamedInvocation(pi, state, call.toolCallId);
		return;
	}

	state.continuation = call.continueOnly && !state.pending
		? invocationReceipt(call, "prior", noPendingContinuation(state))
		: invocationReceipt(call, state.pending ? "prior" : "prompt");
	saveNamedInvocation(pi, state, call.toolCallId);
}

type NamedRunOutcome = { result: SingleResult; stoppedBeforePrompt: boolean };

async function runNamedInvocation(
	pi: ExtensionAPI,
	dependencies: NamedSubagentDependencies,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	state: NamedSubagentState,
	call: NamedInvocationCall,
	onUpdate?: (partial: any) => void,
	monitorRun?: MonitorRunHandle,
): Promise<NamedRunOutcome> {
	const receipt = state.continuation;
	if (!receipt || receipt.toolCallId !== call.toolCallId) throw new Error(`Named invocation receipt disappeared: ${call.name}.`);
	const agent = agentFromState(state);
	const details = (results: SingleResult[]) => ({ mode: "single" as const, agentScope: "user" as const, projectAgentsDir: null, results });

	const persistProgress = (kind: "prior" | "prompt", result: SingleResult) => {
		result = normalizeSingleResult(result);
		if (result.resume && result.resume.runId === state.resume.runId && result.resume.dir === state.resume.dir
			&& result.resume.filePath !== state.resume.filePath) {
			const previous = state.resume.filePath;
			state.resume.filePath = result.resume.filePath;
			if (receipt.existingSession?.filePath === previous) receipt.existingSession.filePath = result.resume.filePath;
		}
		if (resumableNamedResult(result)) {
			state.pending = result;
			receipt.result = undefined;
		} else {
			state.pending = undefined;
			if (kind === "prior" && completedNamedResult(result) && !receipt.continueOnly) {
				receipt.phase = "prompt";
				receipt.result = undefined;
			} else {
				receipt.result = result;
			}
		}
		saveNamedInvocation(pi, state, call.toolCallId);
	};

	const run = async (kind: "prior" | "prompt", task: string, resumeFrom?: SingleResult) => {
		let existingSession: ResumeHandle | undefined;
		if (!resumeFrom) {
			if (!receipt.existingSession) {
				receipt.existingSession = invocationSession(state);
				saveNamedInvocation(pi, state, call.toolCallId);
			}
			existingSession = receipt.existingSession;
		}
		const result = normalizeSingleResult(await dependencies.runSingleAgent(
			ctx.cwd,
			[agent],
			agent.name,
			task,
			state.cwd,
			state.contextMode,
			dependencies.sizedModel(state.size, ctx.model?.provider),
			undefined,
			undefined,
			signal,
			(partial) => {
				const current = partial.details?.results[0] as SingleResult | undefined;
				if (current) persistProgress(kind, current);
				onUpdate?.({ content: partial.content, details: { name: state.name, child: partial.details } });
			},
			details,
			resumeFrom
				? { parentContext: ctx, resumeFrom, retainTerminalSession: true, ...(monitorRun ? { monitor: { ...monitorRun, finalize: kind === "prompt" || receipt.continueOnly === true } } : {}) }
				: {
					parentContext: ctx,
					existingSession,
					retainTerminalSession: true,
					...(monitorRun ? { monitor: { ...monitorRun, finalize: true } } : {}),
					onCheckpoint: (current) => persistProgress(kind, current),
				},
		));
		persistProgress(kind, result);
		return result;
	};

	if (receipt.result && !resumableNamedResult(receipt.result)) {
		return { result: receipt.result, stoppedBeforePrompt: receipt.phase === "prior" };
	}
	if (receipt.phase === "prior") {
		if (state.pending) {
			const resumed = await run("prior", state.pending.task, state.pending);
			if (resumableNamedResult(resumed) || !completedNamedResult(resumed)) {
				monitorRun?.store.finishFromResult(monitorRun.runId, resumed);
				return { result: resumed, stoppedBeforePrompt: true };
			}
		} else {
			if (receipt.continueOnly) receipt.result = noPendingContinuation(state);
			else receipt.phase = "prompt";
			saveNamedInvocation(pi, state, call.toolCallId);
		}
	}
	if (receipt.result && !resumableNamedResult(receipt.result)) return { result: receipt.result, stoppedBeforePrompt: false };
	if (receipt.prompt === undefined) throw new Error(`Named invocation prompt disappeared: ${call.name}.`);
	const promptResult = state.pending
		? await run("prompt", state.pending.task, state.pending)
		: await run("prompt", receipt.prompt);
	return { result: promptResult, stoppedBeforePrompt: false };
}

export async function continueNamedSubagents(
	pi: ExtensionAPI,
	dependencies: NamedSubagentDependencies,
	ctx: ExtensionContext,
	signal: AbortSignal,
): Promise<{ handled: boolean; pending: boolean; results: Array<{ name: string; toolCallId: string; result: SingleResult }> }> {
	const branch = ctx.sessionManager.getBranch?.() ?? [];
	const calls = outstandingNamedInvocations(branch);
	if (calls.length === 0) return { handled: false, pending: false, results: [] };
	await restoreNamedSubagents(pi, ctx);
	const output: { handled: boolean; pending: boolean; results: Array<{ name: string; toolCallId: string; result: SingleResult }> } = {
		handled: true,
		pending: false,
		results: [],
	};
	const blockedNames = new Set<string>();
	for (const call of calls) {
		if (blockedNames.has(call.name)) {
			output.pending = true;
			continue;
		}
		const parentSessionId = ctx.sessionManager.getSessionId();
		const release = acquireContinuationLease(`named:${call.name}`, parentSessionId);
		let monitorRun: MonitorRunHandle | undefined;
		try {
			const state = readNamedSubagent(parentSessionId, call.name);
			if (!state) throw new Error(`Named subagent state is missing for outstanding invocation: ${call.name}.`);
			beginNamedInvocation(pi, state, call, branch);
			if (!state.continuation?.result || resumableNamedResult(state.continuation.result)) {
				const task = call.prompt ?? state.pending?.task;
				if (!task) throw new Error(`No interrupted work is pending for ${state.name}.`);
				monitorRun = dependencies.monitor ? {
					store: dependencies.monitor,
					runId: dependencies.monitor.queueRun({
						orchestrationId: call.toolCallId,
						sessionId: parentSessionId,
						kind: "named",
						mode: "single",
						agent: state.name,
						task,
						model: dependencies.sizedModel(state.size, ctx.model?.provider),
						cwd: state.cwd,
						creationInstructions: state.instructions,
						tasks: namedMonitorTasks(state, call.prompt),
					}),
				} : undefined;
			}
			const outcome = await runNamedInvocation(pi, dependencies, ctx, signal, state, call, undefined, monitorRun);
			if (resumableNamedResult(outcome.result)) {
				output.pending = true;
				blockedNames.add(call.name);
			} else {
				output.results.push({ name: call.name, toolCallId: call.toolCallId, result: outcome.result });
			}
		} catch (error) {
			monitorRun?.store.finishRun(monitorRun.runId, "failed", error instanceof Error ? error.message : String(error));
			throw error;
		} finally {
			release();
		}
	}
	return output;
}

export function registerNamedSubagentTools(
	pi: ExtensionAPI,
	dependencies: NamedSubagentDependencies,
	discoveryCwd = process.cwd(),
	includeProject = false,
	parentSessionId?: string,
) {
	const { sizedModel, monitor } = dependencies;
	const templates = formatAgentList(discoverAgents(discoveryCwd, includeProject ? "both" : "user").agents);
	const templateDescription = `${templates.text}${templates.remaining ? `; +${templates.remaining} more` : ""}`;
	const namedDescription = parentSessionId ? availableNames(listNamedSubagents(parentSessionId)) : "none yet";

	pi.registerTool({
		name: "create_subagent",
		label: "Create subagent",
		description: `Create a reusable named child thread for this parent session. Parent history is copied once; later invoke_subagent calls retain the child's own conversation. Available templates: ${templateDescription}. Trusted .agents/subagents templates are included after session startup.`,
		parameters: Type.Object({
			name: Type.String({ description: "Session-local kebab-case name" }),
			template: Type.Optional(Type.String({ description: "general, researcher, or an exported project template", default: "general" })),
			size: Type.Optional(SizeSchema),
			instructions: Type.Optional(Type.String({ description: "Full replacement for the template instruction body" })),
			cwd: Type.Optional(Type.String({ description: "Absolute path or path relative to the parent cwd" })),
			history: Type.Optional(Type.String({ description: 'Parent history copied at creation: "none", "all", or a positive number of recent turns', default: "none" })),
			context: Type.Optional(ContextSchema),
		}),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			if (!NAME_PATTERN.test(params.name)) throw new Error("Subagent name must be lowercase kebab-case (1-64 characters).");
			const parentSessionId = ctx.sessionManager.getSessionId();
			const restored = await restoreNamedSubagents(pi, ctx);
			const inheritanceError = restored.failures.find((failure) => failure.name === params.name);
			if (inheritanceError) throw new Error(`Could not inherit named subagent ${params.name}: ${inheritanceError.error}`);
			const releaseName = acquireContinuationLease(`named:${params.name}`, parentSessionId);
			try {
			if (fs.existsSync(statePath(parentSessionId, params.name))) throw new Error(`Named subagent already exists: ${params.name}`);
			const projectTrusted = typeof ctx.isProjectTrusted !== "function" || ctx.isProjectTrusted();
			const scope = projectTrusted ? "both" : "user";
			const discovery = discoverAgents(ctx.cwd, scope);
			const templateName = params.template ?? "general";
			const template = discovery.agents.find((agent) => agent.name === templateName);
			if (!template) throw new Error(`Unknown template: ${templateName}. Available: ${discovery.agents.map((agent) => agent.name).join(", ") || "none"}`);
			const history = params.history ?? template.history ?? "none";
			parseForkTurns(history);
			const messages = parseForkTurns(history).kind === "none"
				? []
				: selectForkMessages(
					(ctx.sessionManager as typeof ctx.sessionManager & { buildSessionContext(): { messages: any[] } }).buildSessionContext().messages,
					toolCallId,
					history,
					"create_subagent",
				) ?? [];
			const cwd = params.cwd
				? path.resolve(ctx.cwd, params.cwd)
				: template.cwd
					? path.resolve(template.cwdBase ?? ctx.cwd, template.cwd)
					: ctx.cwd;
			if (!fs.statSync(cwd).isDirectory()) throw new Error(`Subagent cwd is not a directory: ${cwd}`);
			const stateRoot = namedRoot(parentSessionId);
			const resume = await writeResumableForkSession(cwd, messages, ctx.sessionManager.getSessionFile(), path.join(stateRoot, "children"));
			const now = Date.now();
			const capability = capabilitiesFor(template);
			const state: NamedSubagentState = {
				version: NAMED_SUBAGENT_VERSION,
				parentSessionId,
				name: params.name,
				description: template.description,
				template: template.name,
				size: params.size ?? template.size ?? "big",
				capabilities: capability,
				tools: template.tools ?? CAPABILITY_TOOLS[capability],
				instructions: params.instructions ?? template.systemPrompt,
				cwd,
				history,
				contextMode: params.context ?? template.contextMode ?? "default",
				resume,
				createdAt: now,
				updatedAt: now,
			};
			try {
				writeState(state);
			} catch (error) {
				fs.rmSync(resume.dir, { recursive: true, force: true });
				throw error;
			}
			recordNamedCheckpoint(pi, state, toolCallId);
			return {
				content: [{ type: "text", text: `Created ${state.name} [${state.size}] from ${state.template}; history=${state.history}, cwd=${state.cwd}.` }],
				details: { name: state.name, size: state.size, template: state.template, cwd: state.cwd, history: state.history, context: state.contextMode },
			};
			} finally {
				releaseName();
			}
		},
		renderCall(args, theme, context) {
			return renderNamedCreateCall(args, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderNamedCreateResult(result, options, theme, context);
		},
	});

	pi.registerTool({
		name: "invoke_subagent",
		label: "Invoke subagent",
		description: `Continue a reusable named child thread. Supply its name and a new prompt; its configuration and conversation are retained. If the child stopped with an error, use continue: true instead of a prompt to resume its unfinished work without adding a new task. Available named subagents: ${namedDescription}.`,
		parameters: Type.Object({
			name: Type.String({ description: "Previously created session-local subagent name" }),
			prompt: Type.Optional(Type.String({ description: "New follow-up prompt; mutually exclusive with continue" })),
			continue: Type.Optional(Type.Boolean({ description: "Set exactly true to resume interrupted work without sending a follow-up prompt; mutually exclusive with prompt" })),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const hasPrompt = params.prompt !== undefined;
			const hasContinue = params.continue !== undefined;
			if (hasPrompt && hasContinue) throw new Error('invoke_subagent accepts either "prompt" or "continue": true, not both.');
			if (!hasPrompt && !hasContinue) throw new Error('invoke_subagent requires either "prompt" or "continue": true.');
			if (hasPrompt && typeof params.prompt !== "string") throw new Error('invoke_subagent "prompt" must be a string.');
			if (hasContinue && params.continue !== true) throw new Error('invoke_subagent "continue" must be exactly true.');
			const call: NamedInvocationCall = {
				name: params.name,
				toolCallId,
				...(hasPrompt ? { prompt: params.prompt } : { continueOnly: true }),
			};
			const parentSessionId = ctx.sessionManager.getSessionId();
			await resolveNamedSubagent(pi, ctx, params.name);
			const release = acquireContinuationLease(`named:${params.name}`, parentSessionId);
			let monitorRun: MonitorRunHandle | undefined;
			try {
				const state = readNamedSubagent(parentSessionId, params.name);
				if (!state) throw new Error(`Named subagent state disappeared: ${params.name}.`);
				if (!fs.existsSync(state.resume.filePath)) throw new Error(`Saved child session is missing for ${params.name}.`);
				beginNamedInvocation(pi, state, call);
				if (!state.continuation?.result || resumableNamedResult(state.continuation.result)) {
					const task = call.prompt ?? state.pending?.task;
					if (!task) throw new Error(`No interrupted work is pending for ${state.name}.`);
					monitorRun = monitor ? {
						store: monitor,
						runId: monitor.queueRun({
							orchestrationId: toolCallId,
							sessionId: parentSessionId,
							kind: "named",
							mode: "single",
							agent: state.name,
							task,
							model: sizedModel(state.size, ctx.model?.provider),
							cwd: state.cwd,
							creationInstructions: state.instructions,
							tasks: namedMonitorTasks(state, call.prompt),
						}),
					} : undefined;
				}
				const outcome = await runNamedInvocation(pi, dependencies, ctx, signal, state, call, onUpdate, monitorRun);
				if (outcome.stoppedBeforePrompt && resumableNamedResult(outcome.result)) {
					return {
						content: [{ type: "text", text: `Could not finish ${state.name}'s interrupted task: ${finalOutput(outcome.result)}` }],
						details: { name: state.name, result: outcome.result },
					};
				}
				return { content: [{ type: "text", text: finalOutput(outcome.result) }], details: { name: state.name, result: outcome.result } };
			} catch (error) {
				monitorRun?.store.finishRun(monitorRun.runId, "failed", error instanceof Error ? error.message : String(error));
				throw error;
			} finally {
				release();
			}
		},
		renderCall(args, theme, context) {
			return renderNamedInvokeCall(args, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderNamedInvokeResult(result, options, theme, context, monitor);
		},
	});

	pi.registerTool({
		name: "export_subagent",
		label: "Export subagent",
		description: "Export a reusable session-local subagent definition to .agents/subagents/<name>.md for future trusted sessions in this project. Conversation and inherited history contents are never exported.",
		parameters: Type.Object({
			name: Type.String({ description: "Reusable subagent name" }),
			description: Type.String({ description: "Discovery description for future main agents" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = await resolveNamedSubagent(pi, ctx, params.name);
			if (!params.description.trim()) throw new Error("Export description cannot be empty.");
			const root = projectRoot(ctx.cwd);
			const destination = path.join(root, ".agents", "subagents", `${state.name}.md`);
			const content = renderExport(state, params.description, root);
			await withFileMutationQueue(destination, async () => {
				ensureSafeExportDirectory(root);
				try {
					writeExclusiveAtomic(destination, content);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Refusing to overwrite existing export: ${destination}`);
					throw error;
				}
			});
			return { content: [{ type: "text", text: `Exported ${state.name} to ${destination}.` }], details: { path: destination, name: state.name } };
		},
	});
}

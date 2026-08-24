import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { CURRENT_SESSION_VERSION, getAgentDir } from "@earendil-works/pi-coding-agent";

export type ForkMode =
	| { kind: "none" }
	| { kind: "all" }
	| { kind: "recent"; turns: number };

export interface TemporaryForkSession {
	dir: string;
	filePath: string;
}

export interface ResumableForkSession extends TemporaryForkSession {
	runId: string;
	baselineEntryId: string;
}

export function resolveSubagentCwd(defaultCwd: string, cwd: string | undefined) {
	return cwd ? path.resolve(defaultCwd, cwd) : defaultCwd;
}

export function parseForkTurns(value: string | undefined): ForkMode {
	const normalized = value?.trim().toLowerCase() ?? "none";
	if (normalized === "none") return { kind: "none" };
	if (normalized === "all") return { kind: "all" };
	if (!/^[1-9]\d*$/.test(normalized)) {
		throw new Error('forkTurns must be "none", "all", or a positive integer string such as "3".');
	}
	const turns = Number(normalized);
	if (!Number.isSafeInteger(turns)) {
		throw new Error("forkTurns is too large to represent safely.");
	}
	return { kind: "recent", turns };
}

function findInFlightToolCall(messages: AgentMessage[], toolCallId: string, toolName: string) {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		if (message.content.some((part) => part.type === "toolCall" && part.id === toolCallId && part.name === toolName)) {
			return index;
		}
	}
	return -1;
}

export function selectForkMessages(
	messages: AgentMessage[],
	toolCallId: string,
	forkTurns: string | undefined,
	toolName = "subagent",
): AgentMessage[] | undefined {
	const mode = parseForkTurns(forkTurns);
	if (mode.kind === "none") return undefined;

	const toolCallIndex = findInFlightToolCall(messages, toolCallId, toolName);
	if (toolCallIndex < 0) {
		throw new Error("Cannot fork parent context: the active subagent tool-call message was not found.");
	}
	const completedContext = messages.slice(0, toolCallIndex);
	if (mode.kind === "all") return structuredClone(completedContext);

	const userPositions: number[] = [];
	for (let index = 0; index < completedContext.length; index++) {
		if (completedContext[index].role === "user") userPositions.push(index);
	}
	if (userPositions.length === 0) return [];
	const boundary = userPositions[Math.max(0, userPositions.length - mode.turns)];
	return structuredClone(completedContext.slice(boundary));
}

async function syncDirectory(dir: string) {
	const handle = await fs.promises.open(dir, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function writeForkSession(
	dir: string,
	cwd: string,
	messages: AgentMessage[],
	parentSessionFile: string | undefined,
	baselineEntryId?: string,
): Promise<string> {
	const filePath = path.join(dir, "session.jsonl");
	const sessionId = randomUUID();
	const timestamp = new Date().toISOString();
	const records: unknown[] = [{
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: sessionId,
		timestamp,
		cwd,
		...(parentSessionFile ? { parentSession: parentSessionFile } : {}),
	}];
	let parentId: string | null = null;
	const appendMessage = (message: AgentMessage, id = randomUUID()) => {
		const base = {
			id,
			parentId,
			timestamp: new Date(message.timestamp).toISOString(),
		};
		if (message.role === "custom") {
			records.push({
				...base,
				type: "custom_message",
				customType: message.customType,
				content: message.content,
				details: message.details,
				display: message.display,
			});
		} else if (message.role === "branchSummary") {
			records.push({ ...base, type: "branch_summary", fromId: message.fromId, summary: message.summary });
		} else {
			records.push({ ...base, type: "message", message });
		}
		parentId = id;
		return id;
	};

	const compaction = messages[0]?.role === "compactionSummary" ? messages[0] : undefined;
	const contextMessages = compaction ? messages.slice(1) : messages;
	const firstContextEntryId = contextMessages.length > 0 ? randomUUID() : undefined;
	if (compaction) {
		const id = randomUUID();
		records.push({
			type: "compaction",
			id,
			parentId,
			timestamp: new Date(compaction.timestamp).toISOString(),
			summary: compaction.summary,
			firstKeptEntryId: firstContextEntryId ?? id,
			tokensBefore: compaction.tokensBefore,
		});
		parentId = id;
	}
	for (let index = 0; index < contextMessages.length; index++) {
		appendMessage(contextMessages[index], index === 0 ? firstContextEntryId : undefined);
	}
	if (baselineEntryId) {
		records.push({
			type: "custom",
			id: baselineEntryId,
			parentId,
			timestamp: new Date().toISOString(),
			customType: "subagent-run-boundary",
			data: {},
		});
	}

	const handle = await fs.promises.open(filePath, "wx", 0o600);
	try {
		await handle.writeFile(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	await syncDirectory(dir);
	return filePath;
}

export async function writeTemporaryForkSession(
	cwd: string,
	messages: AgentMessage[],
	parentSessionFile: string | undefined,
): Promise<TemporaryForkSession> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-session-"));
	try {
		await fs.promises.chmod(dir, 0o700);
		return { dir, filePath: await writeForkSession(dir, cwd, messages, parentSessionFile) };
	} catch (error) {
		await fs.promises.rm(dir, { recursive: true, force: true });
		throw error;
	}
}

export async function writeResumableForkSession(
	cwd: string,
	messages: AgentMessage[],
	parentSessionFile: string | undefined,
	root = path.join(getAgentDir(), "subagent-runs"),
): Promise<ResumableForkSession> {
	await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
	await fs.promises.chmod(root, 0o700);
	const runId = randomUUID();
	const baselineEntryId = randomUUID();
	const dir = path.join(root, runId);
	await fs.promises.mkdir(dir, { mode: 0o700 });
	try {
		const filePath = await writeForkSession(dir, cwd, messages, parentSessionFile, baselineEntryId);
		await syncDirectory(root);
		return { runId, dir, filePath, baselineEntryId };
	} catch (error) {
		await fs.promises.rm(dir, { recursive: true, force: true });
		throw error;
	}
}

export async function cloneResumableForkSession(
	source: ResumableForkSession,
	root = path.join(getAgentDir(), "subagent-runs"),
): Promise<ResumableForkSession> {
	await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
	await fs.promises.chmod(root, 0o700);
	const runId = randomUUID();
	const dir = path.join(root, runId);
	const filePath = path.join(dir, "session.jsonl");
	await fs.promises.mkdir(dir, { mode: 0o700 });
	try {
		const sourceHandle = await fs.promises.open(source.filePath, "r");
		try {
			await sourceHandle.sync();
		} finally {
			await sourceHandle.close();
		}
		await fs.promises.copyFile(source.filePath, filePath);
		await fs.promises.chmod(filePath, 0o600);
		const handle = await fs.promises.open(filePath, "r");
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
		await syncDirectory(dir);
		await syncDirectory(root);
		return { runId, dir, filePath, baselineEntryId: source.baselineEntryId };
	} catch (error) {
		await fs.promises.rm(dir, { recursive: true, force: true });
		throw error;
	}
}

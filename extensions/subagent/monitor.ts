import { parseStreamingJson } from "@earendil-works/pi-ai";

export type MonitorRunKind = "one-off" | "named" | "continuation";
export type MonitorRunMode = "single" | "parallel" | "fan-in" | "chain";
export type MonitorPromptLabel = "Creation instructions" | "Initial task" | `Follow-up task ${number}` | "Recovery prompt";
export type MonitorRunPhase =
	| "queued"
	| "starting"
	| "thinking"
	| "responding"
	| "tool"
	| "completed"
	| "failed"
	| "interrupted";

export type MonitorTerminalPhase = Extract<MonitorRunPhase, "completed" | "failed" | "interrupted">;

export interface MonitorActivity {
	id: number;
	at: number;
	label: string;
	status: "running" | "success" | "error" | "muted";
	durationMs?: number;
	toolId?: string;
}

interface MonitorToolResult {
	content: Array<{ type: "text"; text: string }>;
	details?: any;
	isError: boolean;
}

export interface MonitorToolSpan {
	id: string;
	name: string;
	preview: string;
	details: string;
	startedAt: number;
	endedAt?: number;
	isError?: boolean;
	resultText?: string;
	args: any;
	result?: MonitorToolResult;
	revision: number;
	argsComplete: boolean;
	executionStarted: boolean;
}

export type MonitorTranscriptEntry =
	| {
		type: "prompt" | "text" | "thinking";
		id: number;
		revision: number;
		text: string;
		streaming?: boolean;
		label?: MonitorPromptLabel;
		pinned?: boolean;
	}
	| {
		type: "tool";
		id: number;
		revision: number;
		toolId: string;
	};

type MonitorTextTranscriptEntry = Exclude<MonitorTranscriptEntry, { type: "tool" }>;
type MonitorToolTranscriptEntry = Extract<MonitorTranscriptEntry, { type: "tool" }>;

export interface MonitorRun {
	id: string;
	orchestrationId: string;
	sessionId: string;
	kind: MonitorRunKind;
	mode: MonitorRunMode;
	slot?: number;
	agent: string;
	task: string;
	model?: string;
	cwd?: string;
	pid?: number;
	phase: MonitorRunPhase;
	currentLabel: string;
	queuedAt: number;
	startedAt?: number;
	endedAt?: number;
	updatedAt: number;
	turns: number;
	latestText: string;
	error?: string;
	tools: MonitorToolSpan[];
	activities: MonitorActivity[];
	transcript: MonitorTranscriptEntry[];
	omittedEntries: number;
}

export interface MonitorSummary {
	total: number;
	queued: number;
	active: number;
}

export interface MonitorStoreEvent {
	revision: number;
	summaryChanged: boolean;
	urgent: boolean;
}

export interface QueueMonitorRunInput {
	orchestrationId: string;
	sessionId: string;
	kind: MonitorRunKind;
	mode: MonitorRunMode;
	agent: string;
	task: string;
	slot?: number;
	model?: string;
	cwd?: string;
	creationInstructions?: string;
	tasks?: string[];
}

export interface MonitorRunHandle {
	store: SubagentMonitorStore;
	runId: string;
	finalize?: boolean;
}

type ResultLike = {
	exitCode: number;
	status?: string;
	stopReason?: string;
	errorMessage?: string;
	stderr?: string;
	model?: string;
};

type StreamBlock = {
	type: "text" | "thinking" | "tool";
	entryId: number;
	toolId?: string;
	argsText?: string;
	redacted?: boolean;
};

type MessageStream = {
	blocks: Map<number, StreamBlock>;
};

type RunState = {
	stream?: MessageStream;
	canSuppressInitialTaskEcho: boolean;
	currentTaskEntryId: number;
	taskHistoryPinned: boolean;
	recoveryPrompt?: string;
	evictedToolIds: Set<string>;
};

const MAX_ACTIVITIES = 120;
const MAX_TOOLS = 80;
const MAX_TRANSCRIPT_ENTRIES = 240;
const IMAGE_PLACEHOLDER = "[image omitted]";
const REDACTED_THINKING_PLACEHOLDER = "[redacted thinking]";

function terminalPhase(phase: MonitorRunPhase): phase is MonitorTerminalPhase {
	return phase === "completed" || phase === "failed" || phase === "interrupted";
}

function compactText(value: unknown, max = 120) {
	if (typeof value !== "string") return "";
	const compact = value.replace(/\s+/g, " ").trim();
	return compact.length > max ? `${compact.slice(0, Math.max(0, max - 1))}…` : compact;
}

function messageTextParts(message: unknown) {
	if (!message || typeof message !== "object") return [];
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	return content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text);
}

function visibleToolResultText(result: unknown) {
	if (typeof result === "string") return result.replace(/\r/g, "");
	if (!result || typeof result !== "object") return "";
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n")
		.replace(/\r/g, "");
}

function sanitizedDetails(value: any, seen = new WeakMap<object, any>()): any {
	if (value === null || typeof value !== "object") return value;
	if (seen.has(value)) return "[circular]";
	if (!Array.isArray(value) && value.type === "image" && typeof value.data === "string") {
		return { type: "text", text: IMAGE_PLACEHOLDER };
	}
	const copy: any = Array.isArray(value) ? [] : {};
	seen.set(value, copy);
	for (const [key, child] of Object.entries(value)) {
		if (/^(?:thinkingSignature|textSignature|signature|encryptedThinking|encrypted_reasoning)$/i.test(key)) continue;
		copy[key] = sanitizedDetails(child, seen);
	}
	return copy;
}

function normalizeToolResult(value: unknown, isError: boolean): MonitorToolResult {
	if (typeof value === "string") {
		return { content: [{ type: "text", text: value.replace(/\r/g, "") }], isError };
	}
	if (!value || typeof value !== "object") return { content: [], isError };
	const source = value as { content?: unknown; details?: any };
	const content: MonitorToolResult["content"] = [];
	if (Array.isArray(source.content)) {
		for (const part of source.content) {
			if (part?.type === "text" && typeof part.text === "string") {
				content.push({ type: "text", text: part.text.replace(/\r/g, "") });
			} else if (part?.type === "image") {
				content.push({ type: "text", text: IMAGE_PLACEHOLDER });
			}
		}
	}
	return {
		content,
		...(Object.prototype.hasOwnProperty.call(source, "details") ? { details: sanitizedDetails(source.details) } : {}),
		isError,
	};
}

function parsedToolArgs(text: string) {
	return text ? parseStreamingJson(text) : undefined;
}

function privateThinking(value: any) {
	return Boolean(value?.redacted || value?.encrypted || value?.content?.redacted || value?.content?.encrypted);
}

function assistantStatusText(message: any, content: any[]) {
	if (message?.stopReason !== "error" && message?.stopReason !== "length") return "";
	const fallback = message.stopReason === "error"
		? "Assistant response failed."
		: "Response truncated: output length limit reached.";
	const status = typeof message.errorMessage === "string" && message.errorMessage.trim() ? message.errorMessage.trim() : fallback;
	const visible = content
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
	if (visible.includes(status)) return "";
	if (message.stopReason === "length" && /(?:truncat|length limit)/i.test(visible)) return "";
	return status;
}

export function monitorToolPreview(name: string, args: unknown) {
	if (!args || typeof args !== "object" || Array.isArray(args)) return "";
	const values = args as Record<string, unknown>;
	if (name === "bash" && typeof values.command === "string") return values.command.replace(/\r/g, "").trim();
	if (name === "read" || name === "write" || name === "edit") {
		const path = typeof values.path === "string" ? values.path : values.file_path;
		if (typeof path === "string") return path;
	}
	if ((name === "grep" || name === "find") && typeof values.pattern === "string") {
		const location = typeof values.path === "string" ? ` in ${values.path}` : "";
		return `${values.pattern}${location}`;
	}
	try {
		return JSON.stringify(values);
	} catch {
		return "";
	}
}

export function monitorToolDetails(name: string, args: unknown) {
	if (!args || typeof args !== "object" || Array.isArray(args)) return "";
	if (name !== "bash" && name !== "read" && name !== "write" && name !== "edit" && name !== "grep" && name !== "find") return "";
	const details = { ...(args as Record<string, unknown>) };
	if (name === "bash") delete details.command;
	if (name === "read" || name === "write" || name === "edit") {
		delete details.path;
		delete details.file_path;
	}
	if (name === "grep" || name === "find") {
		delete details.pattern;
		delete details.path;
	}
	if (Object.keys(details).length === 0) return "";
	try {
		return JSON.stringify(details, null, 2);
	} catch {
		return "";
	}
}

export class SubagentMonitorStore {
	private readonly runs = new Map<string, MonitorRun>();
	private readonly runStates = new Map<string, RunState>();
	private readonly listeners = new Set<(event: MonitorStoreEvent) => void>();
	private readonly now: () => number;
	private nextRunId = 0;
	private nextActivityId = 0;
	private nextTranscriptId = 0;
	private revisionValue = 0;
	private batchDepth = 0;
	private batchedChanged = false;
	private batchedSummaryChanged = false;
	private batchedUrgent = false;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	get revision() {
		return this.revisionValue;
	}

	subscribe(listener: (event: MonitorStoreEvent) => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	batch<T>(operation: () => T) {
		this.batchDepth++;
		try {
			return operation();
		} finally {
			this.batchDepth--;
			if (this.batchDepth === 0 && this.batchedChanged) {
				const summaryChanged = this.batchedSummaryChanged;
				const urgent = this.batchedUrgent;
				this.batchedChanged = false;
				this.batchedSummaryChanged = false;
				this.batchedUrgent = false;
				this.emit(summaryChanged, urgent);
			}
		}
	}

	reset() {
		const changed = this.runs.size > 0;
		this.runs.clear();
		this.runStates.clear();
		if (changed) this.emit(true, true);
	}

	queueRun(input: QueueMonitorRunInput) {
		const at = this.now();
		const id = `${input.orchestrationId}:${++this.nextRunId}`;
		const tasks = input.tasks?.length ? input.tasks : [input.task];
		const transcript: MonitorTextTranscriptEntry[] = [];
		if (input.creationInstructions !== undefined) {
			transcript.push({
				type: "prompt",
				id: ++this.nextTranscriptId,
				revision: 1,
				text: input.creationInstructions || "(none)",
				label: "Creation instructions",
				pinned: true,
			});
		}
		for (let index = 0; index < tasks.length; index++) {
			transcript.push({
				type: "prompt",
				id: ++this.nextTranscriptId,
				revision: 1,
				text: tasks[index]!,
				label: index === 0 ? "Initial task" : `Follow-up task ${index}`,
				pinned: true,
			});
		}
		const currentTaskEntryId = transcript.at(-1)!.id;
		const { creationInstructions: _creationInstructions, tasks: _tasks, ...runInput } = input;
		const run: MonitorRun = {
			...runInput,
			id,
			phase: "queued",
			currentLabel: "queued",
			queuedAt: at,
			updatedAt: at,
			turns: 0,
			latestText: "",
			tools: [],
			activities: [],
			transcript,
			omittedEntries: 0,
		};
		this.runs.set(id, run);
		this.runStates.set(id, {
			canSuppressInitialTaskEcho: true,
			currentTaskEntryId,
			taskHistoryPinned: input.tasks !== undefined,
			evictedToolIds: new Set(),
		});
		this.addActivity(run, "queued", "muted", at);
		this.emit(true, true);
		return id;
	}

	updateMetadata(runId: string, metadata: { model?: string; cwd?: string; task?: string }) {
		const run = this.runs.get(runId);
		const state = this.runStates.get(runId);
		if (!run || !state || terminalPhase(run.phase)) return;
		if (metadata.model) run.model = metadata.model;
		if (metadata.cwd) run.cwd = metadata.cwd;
		if (metadata.task !== undefined) {
			run.task = metadata.task;
			const prompt = state.taskHistoryPinned ? undefined : run.transcript.find((entry) => entry.id === state.currentTaskEntryId);
			if (prompt?.type === "prompt" && prompt.text !== metadata.task) {
				prompt.text = metadata.task;
				prompt.revision++;
			}
		}
		run.updatedAt = this.now();
		this.emit(false, false);
	}

	expectRecoveryPrompt(runId: string, prompt: string) {
		const state = this.runStates.get(runId);
		if (state) state.recoveryPrompt = prompt;
	}

	markStarting(runId: string) {
		const run = this.runs.get(runId);
		if (!run || terminalPhase(run.phase)) return;
		const at = this.now();
		const summaryChanged = run.phase === "queued";
		run.phase = "starting";
		run.currentLabel = "starting";
		run.startedAt ??= at;
		run.updatedAt = at;
		this.addActivity(run, "starting child", "running", at);
		this.emit(summaryChanged, true);
	}

	markSpawned(runId: string, pid?: number) {
		const run = this.runs.get(runId);
		if (!run || terminalPhase(run.phase)) return;
		const at = this.now();
		run.pid = pid;
		run.phase = "starting";
		run.currentLabel = pid ? `spawned pid ${pid}` : "spawned";
		run.updatedAt = at;
		this.addActivity(run, run.currentLabel, "running", at);
		this.emit(false, true);
	}

	observeJsonEvent(runId: string, event: any) {
		const run = this.runs.get(runId);
		const state = this.runStates.get(runId);
		if (!run || !state || terminalPhase(run.phase) || !event || typeof event.type !== "string") return;
		const at = this.now();

		switch (event.type) {
			case "agent_start":
				run.startedAt ??= at;
				run.phase = "thinking";
				run.currentLabel = "agent started";
				this.addActivity(run, "agent started", "running", at);
				break;
			case "turn_start":
				run.turns++;
				run.phase = "thinking";
				run.currentLabel = `thinking · turn ${run.turns}`;
				this.addActivity(run, `turn ${run.turns} started`, "running", at);
				break;
			case "message_start":
				this.cleanupStream(runId, run, state);
				if (event.message?.role === "assistant") {
					state.stream = { blocks: new Map() };
				}
				break;
			case "message_update": {
				const update = event.assistantMessageEvent;
				if (!update || typeof update.type !== "string") return;
				state.stream ??= { blocks: new Map() };
				const contentIndex = Number.isInteger(update.contentIndex) ? update.contentIndex : 0;
				if (update.type.startsWith("thinking_")) {
					run.phase = "thinking";
					run.currentLabel = `thinking · turn ${Math.max(1, run.turns)}`;
					this.updateStreamingText(run, state.stream, contentIndex, "thinking", update);
				} else if (update.type.startsWith("text_")) {
					run.phase = "responding";
					run.currentLabel = "responding";
					this.updateStreamingText(run, state.stream, contentIndex, "text", update);
				} else if (update.type.startsWith("toolcall_")) {
					run.phase = "responding";
					this.updateStreamingTool(run, state, state.stream, contentIndex, update, at);
					const block = state.stream.blocks.get(contentIndex);
					const tool = block?.toolId ? run.tools.find((candidate) => candidate.id === block.toolId) : undefined;
					run.currentLabel = tool ? `preparing ${tool.name}` : "preparing tool call";
				}
				break;
			}
			case "message_end": {
				const role = event.message?.role;
				if (role === "assistant") {
					if (typeof event.message.model === "string") run.model = event.message.model;
					state.stream ??= { blocks: new Map() };
					this.reconcileAssistantMessage(run, state, state.stream, event.message, at);
					state.stream = undefined;
				} else if (role === "user") {
					this.cleanupStream(runId, run, state);
					this.appendUserMessage(run, state, event.message);
				} else if (role === "toolResult") {
					this.applyToolResultMessage(run, state, event.message, at);
				}
				break;
			}
			case "tool_execution_start": {
				const id = typeof event.toolCallId === "string" ? event.toolCallId : `tool-${run.tools.length + 1}`;
				if (state.evictedToolIds.has(id)) break;
				const name = compactText(event.toolName, 80) || "tool";
				const tool = this.ensureTool(run, state, id, name, at);
				if (!tool) break;
				tool.name = name;
				tool.args = event.args;
				tool.argsComplete = true;
				tool.executionStarted = true;
				tool.startedAt = at;
				tool.preview = monitorToolPreview(name, event.args);
				tool.details = monitorToolDetails(name, event.args);
				tool.endedAt = undefined;
				tool.isError = undefined;
				tool.result = undefined;
				tool.resultText = undefined;
				this.touchTool(run, tool);
				run.phase = "tool";
				run.currentLabel = `tool ${name}${tool.preview ? ` · ${compactText(tool.preview)}` : ""}`;
				this.addActivity(run, `${name}${tool.preview ? ` · ${tool.preview}` : ""}`, "running", at, undefined, id);
				break;
			}
			case "tool_execution_update": {
				const id = typeof event.toolCallId === "string" ? event.toolCallId : "unknown";
				if (state.evictedToolIds.has(id)) break;
				const name = compactText(event.toolName, 80) || "tool";
				const tool = this.ensureTool(run, state, id, name, at);
				if (!tool) break;
				if (!tool.executionStarted) {
					tool.executionStarted = true;
					tool.startedAt = at;
				}
				if (Object.prototype.hasOwnProperty.call(event, "args")) {
					tool.args = event.args;
					tool.argsComplete = true;
					tool.preview = monitorToolPreview(tool.name, event.args) || tool.preview;
					tool.details = monitorToolDetails(tool.name, event.args) || tool.details;
				}
				if (Object.prototype.hasOwnProperty.call(event, "partialResult")) {
					tool.result = normalizeToolResult(event.partialResult, Boolean(event.partialResult?.isError));
					tool.resultText = visibleToolResultText(tool.result);
					tool.isError = tool.result.isError;
				}
				this.touchTool(run, tool);
				const activity = [...run.activities].reverse().find((candidate) => candidate.toolId === tool.id && candidate.status === "running");
				if (activity) activity.label = `${tool.name}${tool.preview ? ` · ${tool.preview}` : ""}`;
				break;
			}
			case "tool_execution_end": {
				const id = typeof event.toolCallId === "string" ? event.toolCallId : "unknown";
				if (state.evictedToolIds.has(id)) break;
				const name = compactText(event.toolName, 80) || "tool";
				const tool = this.ensureTool(run, state, id, name, at);
				if (!tool) break;
				if (Object.prototype.hasOwnProperty.call(event, "args")) {
					tool.args = event.args;
					tool.argsComplete = true;
					tool.preview = monitorToolPreview(tool.name, event.args) || tool.preview;
					tool.details = monitorToolDetails(tool.name, event.args) || tool.details;
				}
				tool.executionStarted = true;
				tool.endedAt = at;
				tool.isError = Boolean(event.isError);
				tool.result = normalizeToolResult(event.result, tool.isError);
				tool.resultText = visibleToolResultText(tool.result);
				this.touchTool(run, tool);
				const active = run.tools.filter((candidate) => candidate.executionStarted && candidate.endedAt === undefined);
				run.phase = active.length ? "tool" : "thinking";
				run.currentLabel = active.length ? `tool ${active[active.length - 1]!.name}` : "waiting for next turn";
				const activity = [...run.activities].reverse().find((candidate) => candidate.toolId === id && candidate.status === "running");
				if (activity) {
					activity.label = `${name}${tool.preview ? ` · ${tool.preview}` : ""}`;
					activity.status = event.isError ? "error" : "success";
					activity.durationMs = Math.max(0, at - tool.startedAt);
				} else {
					this.addActivity(run, `${name}${tool.preview ? ` · ${tool.preview}` : ""}`, event.isError ? "error" : "success", tool.startedAt, Math.max(0, at - tool.startedAt), id);
				}
				break;
			}
			case "agent_end":
				this.cleanupStream(runId, run, state);
				run.phase = "responding";
				run.currentLabel = "settling";
				break;
			default:
				return;
		}

		run.updatedAt = at;
		this.emit(false, event.type === "agent_start" || event.type === "tool_execution_start" || event.type === "tool_execution_end");
	}

	finishFromResult(runId: string, result: ResultLike) {
		const status = result.status;
		const phase: MonitorTerminalPhase = status === "completed"
			? "completed"
			: status === "failed"
				? "failed"
				: status === "interrupted" || status === "pending" || result.stopReason === "aborted"
					? "interrupted"
					: result.exitCode === 0 && result.stopReason !== "error"
						? "completed"
						: "failed";
		this.finishRun(runId, phase);
	}

	finishRun(runId: string, phase: MonitorTerminalPhase, _error?: string, _model?: string) {
		const run = this.runs.get(runId);
		if (!run || terminalPhase(run.phase)) return;
		const state = this.runStates.get(runId);
		if (state) this.cleanupStream(runId, run, state);
		const at = this.now();
		for (const tool of run.tools) {
			if (tool.executionStarted && tool.endedAt === undefined) {
				tool.endedAt = at;
				tool.isError = phase === "failed";
				this.touchTool(run, tool);
				const activity = [...run.activities].reverse().find((candidate) => candidate.toolId === tool.id && candidate.status === "running");
				if (activity) {
					activity.status = phase === "failed" ? "error" : "muted";
					activity.durationMs = Math.max(0, at - tool.startedAt);
				} else {
					this.addActivity(run, `${tool.name}${tool.preview ? ` · ${tool.preview}` : ""}`, phase === "failed" ? "error" : "muted", tool.startedAt, Math.max(0, at - tool.startedAt), tool.id);
				}
			}
		}
		this.runs.delete(runId);
		this.runStates.delete(runId);
		this.emit(true, true);
	}

	finishQueued(orchestrationId: string, reason: string) {
		this.batch(() => {
			for (const run of this.runs.values()) {
				if (run.orchestrationId === orchestrationId && run.phase === "queued") this.finishRun(run.id, "interrupted", reason);
			}
		});
	}

	getRun(runId: string) {
		return this.runs.get(runId);
	}

	getRuns(sessionId: string) {
		return Array.from(this.runs.values()).filter((run) => run.sessionId === sessionId);
	}

	getOrchestrationRuns(orchestrationId: string) {
		return Array.from(this.runs.values()).filter((run) => run.orchestrationId === orchestrationId);
	}

	getSummary(sessionId: string): MonitorSummary {
		const runs = this.getRuns(sessionId);
		const queued = runs.filter((run) => run.phase === "queued").length;
		return { total: runs.length, queued, active: runs.length - queued };
	}

	private appendUserMessage(run: MonitorRun, state: RunState, message: unknown) {
		const parts = messageTextParts(message);
		if (parts.length === 0) return;
		const complete = parts.join("\n");
		if (state.recoveryPrompt === complete) {
			state.recoveryPrompt = undefined;
			if (complete === `Task: ${run.task}`) state.canSuppressInitialTaskEcho = false;
			for (const text of parts) this.appendTextEntry(run, "prompt", text, "Recovery prompt");
			return;
		}
		if (state.canSuppressInitialTaskEcho && complete === `Task: ${run.task}`) {
			state.canSuppressInitialTaskEcho = false;
			return;
		}
		for (const text of parts) this.appendTextEntry(run, "prompt", text);
	}

	private updateStreamingText(run: MonitorRun, stream: MessageStream, contentIndex: number, type: "text" | "thinking", update: any) {
		let block = stream.blocks.get(contentIndex);
		let entry = block?.type === type ? this.textEntry(run, block.entryId) : undefined;
		if (block && block.type !== type) {
			this.removeStreamBlock(run, block);
			stream.blocks.delete(contentIndex);
			block = undefined;
		}
		const redacted = type === "thinking" && (block?.redacted || privateThinking(update));
		if (!block) {
			const initial = redacted
				? REDACTED_THINKING_PLACEHOLDER
				: update.type.endsWith("_delta") && typeof update.delta === "string" ? update.delta : "";
			entry = this.insertMessageTextEntry(run, stream, contentIndex, type, initial, !update.type.endsWith("_end"));
			block = { type, entryId: entry.id, ...(redacted ? { redacted: true } : {}) };
			stream.blocks.set(contentIndex, block);
		} else if (!entry) {
			return;
		} else if (redacted) {
			block.redacted = true;
			this.setTextEntry(run, entry, REDACTED_THINKING_PLACEHOLDER, !update.type.endsWith("_end"));
		} else if (update.type.endsWith("_start")) {
			this.setTextEntry(run, entry, "", true);
		} else if (update.type.endsWith("_delta") && typeof update.delta === "string") {
			this.setTextEntry(run, entry, entry.text + update.delta, true);
		} else if (update.type.endsWith("_end")) {
			const text = typeof update.content === "string" ? update.content : entry.text;
			this.setTextEntry(run, entry, text, false);
		}
	}

	private updateStreamingTool(run: MonitorRun, state: RunState, stream: MessageStream, contentIndex: number, update: any, at: number) {
		let block = stream.blocks.get(contentIndex);
		if (block && block.type !== "tool") {
			this.removeStreamBlock(run, block);
			stream.blocks.delete(contentIndex);
			block = undefined;
		}
		const finalCall = update.toolCall && typeof update.toolCall === "object" ? update.toolCall : undefined;
		const id = finalCall?.id || update.id || block?.toolId || `tool-${this.nextTranscriptId + 1}`;
		if (typeof id !== "string" || state.evictedToolIds.has(id)) return;
		const name = compactText(finalCall?.name || update.toolName, 80) || "tool";
		let tool = this.ensureTool(run, state, id, name, at, stream, contentIndex);
		if (!tool) return;
		if (!block) {
			const entry = run.transcript.find((candidate) => candidate.type === "tool" && candidate.toolId === id);
			if (!entry) return;
			block = { type: "tool", entryId: entry.id, toolId: id, argsText: "" };
			stream.blocks.set(contentIndex, block);
		}
		if (update.type === "toolcall_start") {
			const initialArgs = update.args ?? update.arguments;
			if (initialArgs !== undefined) {
				tool.args = initialArgs;
				block.argsText = typeof initialArgs === "string" ? initialArgs : JSON.stringify(initialArgs);
			}
			tool.argsComplete = false;
			this.refreshToolPresentation(tool);
			this.touchTool(run, tool);
		} else if (update.type === "toolcall_delta" && typeof update.delta === "string") {
			block.argsText = (block.argsText || "") + update.delta;
			tool.args = parsedToolArgs(block.argsText);
			tool.argsComplete = false;
			this.refreshToolPresentation(tool);
			this.touchTool(run, tool);
		} else if (update.type === "toolcall_end") {
			tool.name = name;
			tool.args = finalCall?.arguments ?? finalCall?.args ?? parsedToolArgs(block.argsText || "");
			tool.argsComplete = true;
			this.refreshToolPresentation(tool);
			this.touchTool(run, tool);
		}
	}

	private reconcileAssistantMessage(run: MonitorRun, state: RunState, stream: MessageStream, message: any, at: number) {
		const content = Array.isArray(message?.content) ? message.content : [];
		this.registerAuthoritativeTools(run, stream, content);
		const authoritative = new Set<number>();
		for (let contentIndex = 0; contentIndex < content.length; contentIndex++) {
			const part = content[contentIndex];
			if (part?.type === "text" && typeof part.text === "string") {
				authoritative.add(contentIndex);
				this.reconcileTextBlock(run, stream, contentIndex, "text", part.text);
			} else if (part?.type === "thinking") {
				authoritative.add(contentIndex);
				const prior = stream.blocks.get(contentIndex);
				const redacted = (prior?.type === "thinking" && prior.redacted === true) || privateThinking(part);
				const text = redacted ? REDACTED_THINKING_PLACEHOLDER : typeof part.thinking === "string" ? part.thinking : "";
				this.reconcileTextBlock(run, stream, contentIndex, "thinking", text, redacted);
			} else if (part?.type === "toolCall" && typeof part.id === "string") {
				authoritative.add(contentIndex);
				this.reconcileToolBlock(run, state, stream, contentIndex, part, at);
			}
		}
		const status = assistantStatusText(message, content);
		if (status) {
			const contentIndex = content.length;
			authoritative.add(contentIndex);
			this.reconcileTextBlock(run, stream, contentIndex, "text", status);
		}
		for (const [contentIndex, block] of [...stream.blocks]) {
			if (!authoritative.has(contentIndex)) {
				this.removeStreamBlock(run, block);
				stream.blocks.delete(contentIndex);
			}
		}
		this.syncLatestText(run);
	}

	private registerAuthoritativeTools(run: MonitorRun, stream: MessageStream, content: any[]) {
		for (let contentIndex = 0; contentIndex < content.length; contentIndex++) {
			const part = content[contentIndex];
			if (part?.type !== "toolCall" || typeof part.id !== "string") continue;
			const existing = [...stream.blocks].find(([, block]) => block.type === "tool" && block.toolId === part.id);
			const entry = run.transcript.find((candidate) => candidate.type === "tool" && candidate.toolId === part.id);
			if (!entry) continue;
			const target = stream.blocks.get(contentIndex);
			if (target && target.entryId !== entry.id) this.removeStreamBlock(run, target);
			if (existing && existing[0] !== contentIndex) stream.blocks.delete(existing[0]);
			stream.blocks.set(contentIndex, existing?.[1] ?? { type: "tool", entryId: entry.id, toolId: part.id });
		}
	}

	private reconcileTextBlock(run: MonitorRun, stream: MessageStream, contentIndex: number, type: "text" | "thinking", text: string, redacted = false) {
		let block = stream.blocks.get(contentIndex);
		if (block && block.type !== type) {
			this.removeStreamBlock(run, block);
			stream.blocks.delete(contentIndex);
			block = undefined;
		}
		if (!block) {
			const entry = this.insertMessageTextEntry(run, stream, contentIndex, type, text, false);
			stream.blocks.set(contentIndex, { type, entryId: entry.id, ...(redacted ? { redacted: true } : {}) });
			return;
		}
		if (redacted) block.redacted = true;
		const entry = this.textEntry(run, block.entryId);
		if (entry) this.setTextEntry(run, entry, text, false);
	}

	private reconcileToolBlock(run: MonitorRun, state: RunState, stream: MessageStream, contentIndex: number, part: any, at: number) {
		let block = stream.blocks.get(contentIndex);
		if (block && block.type !== "tool") {
			this.removeStreamBlock(run, block);
			stream.blocks.delete(contentIndex);
			block = undefined;
		}
		if (state.evictedToolIds.has(part.id)) return;
		const tool = this.ensureTool(run, state, part.id, compactText(part.name, 80) || "tool", at, stream, contentIndex);
		if (!tool) return;
		const entry = run.transcript.find((candidate) => candidate.type === "tool" && candidate.toolId === part.id);
		if (!block && entry) {
			block = { type: "tool", entryId: entry.id, toolId: part.id };
			stream.blocks.set(contentIndex, block);
		}
		tool.name = compactText(part.name, 80) || tool.name;
		tool.args = part.arguments ?? part.args;
		tool.argsComplete = true;
		this.refreshToolPresentation(tool);
		this.touchTool(run, tool);
	}

	private applyToolResultMessage(run: MonitorRun, state: RunState, message: any, at: number) {
		const id = typeof message.toolCallId === "string" ? message.toolCallId : "unknown";
		if (state.evictedToolIds.has(id)) return;
		const name = compactText(message.toolName, 80) || "tool";
		const tool = this.ensureTool(run, state, id, name, at);
		if (!tool) return;
		tool.executionStarted = true;
		tool.endedAt ??= at;
		tool.isError = Boolean(message.isError);
		tool.result = normalizeToolResult(message, tool.isError);
		tool.resultText = visibleToolResultText(tool.result);
		this.touchTool(run, tool);
	}

	private ensureTool(run: MonitorRun, state: RunState, id: string, name: string, at: number, stream?: MessageStream, contentIndex?: number) {
		if (state.evictedToolIds.has(id)) return undefined;
		let tool = run.tools.find((candidate) => candidate.id === id);
		if (!tool) {
			tool = {
				id,
				name,
				preview: "",
				details: "",
				startedAt: at,
				args: undefined,
				revision: 1,
				argsComplete: false,
				executionStarted: false,
			};
			run.tools.push(tool);
		}
		let entry = run.transcript.find((candidate) => candidate.type === "tool" && candidate.toolId === id) as MonitorToolTranscriptEntry | undefined;
		if (!entry) {
			entry = { type: "tool", id: ++this.nextTranscriptId, revision: 1, toolId: id };
			this.insertMessageEntry(run, stream, contentIndex, entry);
		}
		this.enforceBounds(run, state);
		return run.tools.find((candidate) => candidate.id === id);
	}

	private refreshToolPresentation(tool: MonitorToolSpan) {
		tool.preview = monitorToolPreview(tool.name, tool.args);
		tool.details = monitorToolDetails(tool.name, tool.args);
	}

	private touchTool(run: MonitorRun, tool: MonitorToolSpan) {
		tool.revision++;
		const entry = run.transcript.find((candidate) => candidate.type === "tool" && candidate.toolId === tool.id);
		if (entry) entry.revision++;
	}

	private appendTextEntry(run: MonitorRun, type: "prompt" | "text" | "thinking", text: string, label?: MonitorPromptLabel) {
		const entry: MonitorTextTranscriptEntry = { type, id: ++this.nextTranscriptId, revision: 1, text, ...(label ? { label } : {}) };
		run.transcript.push(entry);
		const state = this.runStates.get(run.id);
		if (state) this.enforceBounds(run, state);
		this.syncLatestText(run);
		return entry;
	}

	private insertMessageTextEntry(run: MonitorRun, stream: MessageStream, contentIndex: number, type: "text" | "thinking", text: string, streaming: boolean) {
		const entry: MonitorTextTranscriptEntry = {
			type,
			id: ++this.nextTranscriptId,
			revision: 1,
			text,
			...(streaming ? { streaming: true } : {}),
		};
		this.insertMessageEntry(run, stream, contentIndex, entry);
		const state = this.runStates.get(run.id);
		if (state) this.enforceBounds(run, state);
		this.syncLatestText(run);
		return entry;
	}

	private insertMessageEntry(run: MonitorRun, stream: MessageStream | undefined, contentIndex: number | undefined, entry: MonitorTranscriptEntry) {
		if (!stream || contentIndex === undefined) {
			run.transcript.push(entry);
			return;
		}
		const indexes = [...stream.blocks.keys()].sort((left, right) => left - right);
		for (let index = indexes.length - 1; index >= 0; index--) {
			const priorIndex = indexes[index]!;
			if (priorIndex >= contentIndex) continue;
			const prior = stream.blocks.get(priorIndex);
			const position = prior ? run.transcript.findIndex((candidate) => candidate.id === prior.entryId) : -1;
			if (position >= 0) {
				run.transcript.splice(position + 1, 0, entry);
				return;
			}
		}
		for (const nextIndex of indexes) {
			if (nextIndex <= contentIndex) continue;
			const next = stream.blocks.get(nextIndex);
			const position = next ? run.transcript.findIndex((candidate) => candidate.id === next.entryId) : -1;
			if (position >= 0) {
				run.transcript.splice(position, 0, entry);
				return;
			}
		}
		run.transcript.push(entry);
	}

	private setTextEntry(run: MonitorRun, entry: MonitorTextTranscriptEntry, text: string, streaming: boolean) {
		const wasStreaming = entry.streaming === true;
		if (entry.text === text && wasStreaming === streaming) return;
		entry.text = text;
		if (streaming) entry.streaming = true;
		else delete entry.streaming;
		entry.revision++;
		this.syncLatestText(run);
	}

	private textEntry(run: MonitorRun, id: number) {
		const entry = run.transcript.find((candidate) => candidate.id === id);
		return entry?.type === "text" || entry?.type === "thinking" ? entry : undefined;
	}

	private removeStreamBlock(run: MonitorRun, block: StreamBlock) {
		const index = run.transcript.findIndex((candidate) => candidate.id === block.entryId);
		if (index >= 0) run.transcript.splice(index, 1);
		if (block.type === "tool" && block.toolId) {
			const toolIndex = run.tools.findIndex((candidate) => candidate.id === block.toolId);
			if (toolIndex >= 0) run.tools.splice(toolIndex, 1);
		}
		this.syncLatestText(run);
	}

	private cleanupStream(runId: string, run: MonitorRun, state: RunState) {
		if (!state.stream) return;
		for (const block of state.stream.blocks.values()) {
			if (block.type === "tool") continue;
			const entry = this.textEntry(run, block.entryId);
			if (entry?.streaming) this.setTextEntry(run, entry, entry.text, false);
		}
		state.stream = undefined;
		this.runStates.set(runId, state);
	}

	private enforceBounds(run: MonitorRun, state: RunState) {
		const transcriptOrder = new Map<string, number>();
		for (let index = 0; index < run.transcript.length; index++) {
			const entry = run.transcript[index]!;
			if (entry.type === "tool") transcriptOrder.set(entry.toolId, index);
		}
		run.tools.sort((left, right) => (transcriptOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (transcriptOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER));
		while (run.tools.length > MAX_TOOLS) {
			const tool = run.tools.shift()!;
			state.evictedToolIds.add(tool.id);
			const transcriptIndex = run.transcript.findIndex((entry) => entry.type === "tool" && entry.toolId === tool.id);
			if (transcriptIndex >= 0) {
				run.transcript.splice(transcriptIndex, 1);
				run.omittedEntries++;
			}
		}
		const pinnedEntries = run.transcript.filter((entry) => entry.type !== "tool" && entry.pinned).length;
		while (run.transcript.length > MAX_TRANSCRIPT_ENTRIES + pinnedEntries) {
			const index = run.transcript.findIndex((entry) => entry.type === "tool" || !entry.pinned);
			if (index < 0) break;
			const [entry] = run.transcript.splice(index, 1);
			if (!entry) break;
			run.omittedEntries++;
			if (entry.type === "tool") {
				const toolIndex = run.tools.findIndex((tool) => tool.id === entry.toolId);
				if (toolIndex >= 0) run.tools.splice(toolIndex, 1);
				state.evictedToolIds.add(entry.toolId);
			}
		}
		this.syncLatestText(run);
	}

	private syncLatestText(run: MonitorRun) {
		run.latestText = run.transcript
			.filter((entry): entry is MonitorTextTranscriptEntry => entry.type === "text")
			.map((entry) => entry.text)
			.filter(Boolean)
			.join("\n");
	}

	private addActivity(run: MonitorRun, label: string, status: MonitorActivity["status"], at: number, durationMs?: number, toolId?: string) {
		run.activities.push({
			id: ++this.nextActivityId,
			at,
			label,
			status,
			...(durationMs === undefined ? {} : { durationMs }),
			...(toolId === undefined ? {} : { toolId }),
		});
		if (run.activities.length > MAX_ACTIVITIES) run.activities.splice(0, run.activities.length - MAX_ACTIVITIES);
	}

	private emit(summaryChanged: boolean, urgent: boolean) {
		if (this.batchDepth > 0) {
			this.batchedChanged = true;
			this.batchedSummaryChanged ||= summaryChanged;
			this.batchedUrgent ||= urgent;
			return;
		}
		this.revisionValue++;
		const event = { revision: this.revisionValue, summaryChanged, urgent };
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				/* Monitor observers must never affect child execution. */
			}
		}
	}
}

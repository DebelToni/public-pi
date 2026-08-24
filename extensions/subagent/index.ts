/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	buildSessionContext,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	type ExtensionContext,
	getMarkdownTheme,
	SessionManager,
	truncateHead,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, matchesKey, Spacer, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
	type AgentConfig,
	type AgentScope,
	type ModelSize,
	discoverAgents,
	formatAgentList,
} from "./agents.js";
import {
	cloneResumableForkSession,
	parseForkTurns,
	resolveSubagentCwd,
	selectForkMessages,
	writeResumableForkSession,
} from "./fork-context.js";
import { registerNamedSubagentTools } from "./named-subagents.js";
import { installSubagentWrapSupport, registerActiveSubagent } from "./wrap-subagents.js";
import {
	CONTINUATION_REQUEST_CHANNEL,
	type ContinuationRequest,
} from "../lib/continuation-request.js";
import {
	acquireContinuationLease,
	CONTINUATION_MANIFEST_VERSION,
	getContinuationLocation,
	listContinuationManifests,
	removeContinuation,
	writeContinuationManifest,
	type ContinuationLocation,
	type ContinuationManifest,
} from "./continuation-store.js";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const CONTINUATION_STATE_TYPE = "subagent-continuation";
const MAIN_CONTINUATION_MESSAGE_TYPE = "main-continuation";
const SUBAGENT_CONTINUATION_MESSAGE_TYPE = "subagent-continuation-result";
const SUBAGENT_CONTINUATION_TRIGGER_TYPE = "subagent-continuation-trigger";
const RESUME_PROMPT = "Continue the original delegated task from the saved conversation. Preserve completed work and inspect current state before retrying an interrupted side effect.";

function selectedAgent(agents: AgentConfig[], name: string) {
	return agents.find((agent) => agent.name === name);
}

export function sizedModel(size: ModelSize, provider?: string) {
	const targetProvider = provider && (provider.startsWith("codex-") || provider === "openai-codex")
		? provider
		: "openai-codex";
	const model = size === "small" ? "gpt-5.6-luna" : "gpt-5.6-sol";
	return `${targetProvider}/${model}:high`;
}

function invocationModel(agents: AgentConfig[], name: string, size: ModelSize | undefined, provider?: string) {
	const agent = selectedAgent(agents, name);
	const effectiveSize = size ?? agent?.size;
	return effectiveSize ? sizedModel(effectiveSize, provider) : agent?.model;
}

function invocationAgents(agents: AgentConfig[], name: string, instructions: string | undefined) {
	if (instructions === undefined) return agents;
	return agents.map((agent) => agent.name === name ? { ...agent, systemPrompt: instructions } : agent);
}

function invocationContextMode(agents: AgentConfig[], name: string, mode: ContextMode | undefined) {
	return mode ?? selectedAgent(agents, name)?.contextMode ?? "default";
}

function invocationHistory(agents: AgentConfig[], name: string, history: string | undefined) {
	return history ?? selectedAgent(agents, name)?.history;
}

function legacyModelSize(value: unknown): ModelSize | undefined {
	if (typeof value !== "string") return undefined;
	if (value.includes("luna")) return "small";
	if (value.includes("sol")) return "big";
	return undefined;
}

function prepareSubagentArguments(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const input = value as Record<string, unknown>;
	const normalize = (item: unknown) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return item;
		const record = item as Record<string, unknown>;
		const { model, ...rest } = record;
		return { ...rest, ...(rest.size === undefined && legacyModelSize(model) ? { size: legacyModelSize(model) } : {}) };
	};
	const normalized = normalize(input) as Record<string, unknown>;
	return {
		...normalized,
		...(Array.isArray(input.tasks) ? { tasks: input.tasks.map(normalize) } : {}),
		...(Array.isArray(input.chain) ? { chain: input.chain.map(normalize) } : {}),
	};
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export type RunStatus = "running" | "completed" | "failed" | "interrupted" | "pending";

export type ResumeHandle = {
	runId: string;
	dir: string;
	filePath: string;
	baselineEntryId: string;
	pid?: number;
};

export interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	status?: RunStatus;
	resume?: ResumeHandle;
}

export interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
	continuationId?: string;
}

type ContinuationState = {
	id: string;
	status: "interrupted" | "completed";
	details: SubagentDetails;
	updatedAt: number;
};

export type ContinuationCandidate = {
	id: string;
	details: SubagentDetails;
	args: SubagentInput;
	toolCallEntryId: string;
	manifestStatus?: StoredContinuation["status"];
	manifest?: StoredContinuation;
	sourceManifest?: StoredContinuation;
};

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function getRunStatus(result: SingleResult): RunStatus {
	if (result.status) return result.status;
	if (result.exitCode === -1) return "running";
	if (result.stopReason === "aborted") return "interrupted";
	if (result.exitCode === 0 && result.stopReason !== "error") return "completed";
	return "failed";
}

function isResumable(result: SingleResult) {
	const status = getRunStatus(result);
	return status === "interrupted" || status === "pending";
}

function hasResumableWork(details: SubagentDetails) {
	return details.results.some(isResumable);
}

function resultError(result: SingleResult) {
	return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
}

function pendingResult(agent: string, task: string, step?: number): SingleResult {
	return {
		agent,
		agentSource: "unknown",
		task,
		exitCode: 130,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		status: "pending",
		stopReason: "aborted",
		step,
	};
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	let failure: unknown;
	const workers = new Array(limit).fill(null).map(async () => {
		while (failure === undefined) {
			const current = nextIndex++;
			if (current >= items.length) return;
			try {
				results[current] = await fn(items[current], current);
			} catch (error) {
				failure ??= error;
			}
		}
	});
	await Promise.all(workers);
	if (failure !== undefined) throw failure;
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function isProcessAlive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function childMessagesAfterBoundary(filePath: string, baselineEntryId: string) {
	const branch = SessionManager.open(filePath).getBranch();
	const boundaryIndex = branch.findIndex((entry) => entry.id === baselineEntryId);
	if (boundaryIndex < 0) return undefined;
	return branch
		.slice(boundaryIndex + 1)
		.filter((entry): entry is Extract<(typeof branch)[number], { type: "message" }> => entry.type === "message")
		.map((entry) => entry.message);
}

function recoverTerminalChildSession(filePath: string, task: string, baselineEntryId: string) {
	const messages = childMessagesAfterBoundary(filePath, baselineEntryId);
	if (!messages) return undefined;
	const taskText = `Task: ${task}`;
	const taskIndex = messages.findIndex((message) => {
		if (message.role !== "user") return false;
		if (typeof message.content === "string") return message.content === taskText;
		return message.content.some((part) => part.type === "text" && part.text === taskText);
	});
	if (taskIndex < 0) return undefined;
	const childMessages = messages.slice(taskIndex).filter(
		(message): message is Message =>
			message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	);
	const tail = childMessages[childMessages.length - 1];
	if (tail?.role !== "assistant" || tail.stopReason !== "stop") return undefined;
	const usage: UsageStats = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		contextTokens: 0,
		turns: 0,
	};
	for (const message of childMessages) {
		if (message.role !== "assistant") continue;
		usage.turns++;
		usage.input += message.usage?.input ?? 0;
		usage.output += message.usage?.output ?? 0;
		usage.cacheRead += message.usage?.cacheRead ?? 0;
		usage.cacheWrite += message.usage?.cacheWrite ?? 0;
		usage.cost += message.usage?.cost?.total ?? 0;
		usage.contextTokens = message.usage?.totalTokens ?? usage.contextTokens;
	}
	return { messages: childMessages, usage, model: tail.model };
}

export function repairInterruptedToolCalls(filePath: string, baselineEntryId?: string) {
	const manager = SessionManager.open(filePath);
	const messages = baselineEntryId
		? childMessagesAfterBoundary(filePath, baselineEntryId) ?? []
		: manager.buildSessionContext().messages;
	const pending = new Map<string, string>();
	for (const message of messages) {
		if (message.role === "assistant") {
			pending.clear();
			if (message.stopReason === "aborted" || message.stopReason === "error") continue;
			for (const part of message.content) {
				if (part.type === "toolCall") pending.set(part.id, part.name);
			}
		} else if (message.role === "toolResult") {
			pending.delete(message.toolCallId);
		} else if (message.role === "user") {
			pending.clear();
		}
	}
	for (const [toolCallId, toolName] of pending) {
		manager.appendMessage({
			role: "toolResult",
			toolCallId,
			toolName,
			content: [{ type: "text", text: "Interrupted before this tool returned. Inspect external state before retrying it." }],
			details: { interrupted: true },
			isError: true,
			timestamp: Date.now(),
		});
	}
	return pending.size;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;
export type ContextMode = "default" | "none" | "cwd-only";
export type ForkContext = { messages: AgentMessage[]; parentSessionFile: string | undefined };
type RunSingleAgentOptions = {
	resumeFrom?: SingleResult;
	existingSession?: ResumeHandle;
	onCheckpoint?: (result: SingleResult) => void;
	runsRoot?: string;
	retainTerminalSession?: boolean;
	invocation?: (args: string[]) => { command: string; args: string[] };
};

function findContextFileInDir(dir: string): string | undefined {
	for (const filename of ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]) {
		const filePath = path.join(dir, filename);
		if (fs.existsSync(filePath)) return filePath;
	}
	return undefined;
}

export async function runSingleAgent(
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
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	options: RunSingleAgentOptions = {},
): Promise<SingleResult> {
	const resumeFrom = options.resumeFrom;
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		const error = `Unknown agent: "${agentName}". Available agents: ${available}.`;
		if (resumeFrom?.resume) {
			return {
				...resumeFrom,
				status: getRunStatus(resumeFrom) === "pending" ? "pending" : "interrupted",
				stopReason: "aborted",
				errorMessage: error,
			};
		}
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: error,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
			status: "failed",
		};
	}

	const args: string[] = ["--mode", "json", "-p"];
	const effectiveCwd = cwd
		? resolveSubagentCwd(defaultCwd, cwd)
		: agent.cwd
			? resolveSubagentCwd(agent.cwdBase ?? defaultCwd, agent.cwd)
			: defaultCwd;
	const model = modelOverride ?? agent.model;
	if (model) args.push("--model", model);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
	if (contextMode !== "default") args.push("--no-context-files");
	if (contextMode === "cwd-only") {
		const contextFile = findContextFileInDir(effectiveCwd);
		if (contextFile) args.push("--append-system-prompt", contextFile);
	}

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;
	let runSession = resumeFrom?.resume ?? options.existingSession;
	let retainRunSession = false;

	const currentResult: SingleResult = resumeFrom
		? {
				...resumeFrom,
				agentSource: agent.source,
				messages: [...resumeFrom.messages],
				stderr: "",
				usage: { ...resumeFrom.usage },
				model,
				exitCode: -1,
				status: "running",
				stopReason: undefined,
				errorMessage: undefined,
			}
		: {
				agent: agentName,
				agentSource: agent.source,
				task,
				exitCode: -1,
				messages: [],
				stderr: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				model,
				step,
				status: "running",
			};

	const emitUpdate = () => {
		if (runSession?.filePath) {
			const fd = fs.openSync(runSession.filePath, "r");
			try {
				fs.fsyncSync(fd);
			} finally {
				fs.closeSync(fd);
			}
		}
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (runSession) {
			if (!fs.existsSync(runSession.filePath)) {
				currentResult.exitCode = 1;
				currentResult.status = "failed";
				currentResult.stopReason = "error";
				currentResult.errorMessage = "Saved subagent session is missing.";
				delete currentResult.resume;
				return currentResult;
			}
		} else {
			const resumable = await writeResumableForkSession(
				effectiveCwd,
				forkContext?.messages ?? [],
				forkContext?.parentSessionFile,
				options.runsRoot,
			);
			runSession = resumable;
			currentResult.resume = resumable;
		}
		if (resumeFrom) {
			if (runSession.pid && isProcessAlive(runSession.pid)) {
				currentResult.exitCode = 130;
				currentResult.status = "interrupted";
				currentResult.stopReason = "aborted";
				currentResult.errorMessage = `The prior child process (${runSession.pid}) is still running. Wait briefly, then run /continue again.`;
				currentResult.resume = runSession;
				retainRunSession = true;
				return currentResult;
			}
			delete runSession.pid;
			const recovered = recoverTerminalChildSession(runSession.filePath, task, runSession.baselineEntryId);
			if (recovered) {
				currentResult.messages = recovered.messages;
				currentResult.usage = recovered.usage;
				currentResult.model = recovered.model ?? currentResult.model;
				currentResult.exitCode = 0;
				currentResult.status = "completed";
				currentResult.stopReason = "stop";
				if (options.retainTerminalSession) {
					currentResult.resume = runSession;
					retainRunSession = true;
				} else {
					delete currentResult.resume;
				}
				emitUpdate();
				return currentResult;
			}
			repairInterruptedToolCalls(runSession.filePath, runSession.baselineEntryId);
		}
		args.push("--session", runSession.filePath);
		currentResult.resume = runSession;
		options.onCheckpoint?.(cloneResult(currentResult));
		onUpdate?.({
			content: [{ type: "text", text: resumeFrom ? "Resuming saved subagent…" : "Starting subagent…" }],
			details: makeDetails([currentResult]),
		});

		if (signal?.aborted) {
			currentResult.exitCode = 130;
			currentResult.status = !resumeFrom || getRunStatus(resumeFrom) === "pending" ? "pending" : "interrupted";
			currentResult.stopReason = "aborted";
			retainRunSession = true;
			return currentResult;
		}

		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(resumeFrom && getRunStatus(resumeFrom) !== "pending" ? RESUME_PROMPT : `Task: ${task}`);
		let wasAborted = false;

		const childExit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
			const invocation = options.invocation?.(args) ?? getPiInvocation(args);
			const env: NodeJS.ProcessEnv = { ...process.env, PI_SUBAGENT: "1" };
			delete env.TMUX;
			delete env.TMUX_PANE;
			const proc = spawn(invocation.command, invocation.args, {
				cwd: effectiveCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env,
			});
			let wrapSignalReady = false;
			let wrapSignalPending = false;
			let releaseWrapRegistration: (() => void) | undefined;
			if (proc.pid) {
				runSession!.pid = proc.pid;
				currentResult.resume = runSession;
				releaseWrapRegistration = registerActiveSubagent(() => {
					if (!wrapSignalReady) {
						wrapSignalPending = true;
						return true;
					}
					return proc.kill("SIGUSR2");
				});
			}
			let buffer = "";
			let exited = false;
			let killTimer: NodeJS.Timeout | undefined;
			let abortHandler: (() => void) | undefined;
			const markExited = () => {
				exited = true;
				releaseWrapRegistration?.();
				releaseWrapRegistration = undefined;
				if (killTimer) clearTimeout(killTimer);
				if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
			};

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "agent_start") {
					wrapSignalReady = true;
					if (wrapSignalPending) {
						wrapSignalPending = false;
						proc.kill("SIGUSR2");
					}
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code, exitSignal) => {
				markExited();
				if (runSession) delete runSession.pid;
				if (buffer.trim()) processLine(buffer);
				resolve({ code, signal: exitSignal });
			});

			proc.on("error", () => {
				markExited();
				if (runSession) delete runSession.pid;
				resolve({ code: 1, signal: null });
			});

			if (proc.pid) emitUpdate();

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					if (!exited) proc.kill("SIGTERM");
					killTimer = setTimeout(() => {
						if (!exited) proc.kill("SIGKILL");
					}, 5000);
				};
				abortHandler = killProc;
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		const exitedBySignal = childExit.signal !== null;
		const interrupted =
			currentResult.stopReason === "aborted" ||
			((wasAborted || exitedBySignal) && currentResult.stopReason !== "stop");
		const exitCode = childExit.code ?? (exitedBySignal ? 128 : 1);
		currentResult.exitCode = interrupted ? 130 : exitCode;
		if (interrupted) {
			currentResult.status = "interrupted";
			currentResult.stopReason = "aborted";
			currentResult.resume = runSession;
			retainRunSession = true;
			return currentResult;
		}
		currentResult.status = exitCode === 0 && currentResult.stopReason !== "error" ? "completed" : "failed";
		if (options.retainTerminalSession) {
			currentResult.resume = runSession;
			retainRunSession = true;
		} else {
			delete currentResult.resume;
		}
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
		if (runSession && !retainRunSession)
			try {
				fs.rmSync(runSession.dir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
	}
}

const ContextModeSchema = StringEnum(["default", "none", "cwd-only"] as const, {
	description: 'Context-file loading for subagent cwd. "default" loads Pi context normally; "none" disables AGENTS/CLAUDE files; "cwd-only" disables discovery and appends only AGENTS.md/CLAUDE.md directly in the subagent cwd.',
	default: "default",
});

const ForkTurnsSchema = Type.String({
	description: 'Parent conversation turns to inherit. Use "none" (default), "all", or a positive integer string such as "3" for the most recent user turns.',
	default: "none",
});

const ModelSizeSchema = StringEnum(["big", "small"] as const, {
	description: "Model class. big is GPT-5.6 Sol/high; small is GPT-5.6 Luna/high.",
});

const TaskItem = Type.Object({
	agent: Type.String({ description: "Configured agent/template name" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	instructions: Type.Optional(Type.String({ description: "Full replacement for the selected agent's instruction body" })),
	size: Type.Optional(ModelSizeSchema),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	contextMode: Type.Optional(ContextModeSchema),
	forkTurns: Type.Optional(ForkTurnsSchema),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Configured agent/template name" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	instructions: Type.Optional(Type.String({ description: "Full replacement for the selected agent's instruction body" })),
	size: Type.Optional(ModelSizeSchema),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	contextMode: Type.Optional(ContextModeSchema),
	forkTurns: Type.Optional(ForkTurnsSchema),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "both" so trusted project exports are available.',
	default: "both",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	instructions: Type.Optional(Type.String({ description: "Full replacement for the selected agent's instruction body (single mode)" })),
	size: Type.Optional(ModelSizeSchema),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	contextMode: Type.Optional(ContextModeSchema),
	forkTurns: Type.Optional(ForkTurnsSchema),
});

export type SubagentInput = Static<typeof SubagentParams>;
type StoredContinuation = ContinuationManifest<SubagentInput, SubagentDetails>;

function pendingDetailsFromInput(input: SubagentInput, continuationId: string): SubagentDetails | undefined {
	const agentScope: AgentScope = input.agentScope ?? "user";
	if (input.chain?.length) {
		return {
			mode: "chain",
			agentScope,
			projectAgentsDir: null,
			results: [pendingResult(input.chain[0].agent, input.chain[0].task.replace(/\{previous\}/g, ""), 1)],
			continuationId,
		};
	}
	if (input.tasks?.length) {
		if (input.tasks.length > MAX_PARALLEL_TASKS) return undefined;
		return {
			mode: "parallel",
			agentScope,
			projectAgentsDir: null,
			results: input.tasks.map((task) => pendingResult(task.agent, task.task)),
			continuationId,
		};
	}
	if (input.agent && input.task) {
		return {
			mode: "single",
			agentScope,
			projectAgentsDir: null,
			results: [pendingResult(input.agent, input.task)],
			continuationId,
		};
	}
	return undefined;
}

function cloneResult(result: SingleResult): SingleResult {
	return {
		...result,
		messages: [...result.messages],
		usage: { ...result.usage },
		...(result.resume ? { resume: { ...result.resume } } : {}),
	};
}

function cleanupCommittedSessions(details: SubagentDetails): SubagentDetails {
	return {
		...details,
		results: details.results.map((result) => {
			const cloned = cloneResult(result);
			if (cloned.resume && (getRunStatus(cloned) === "completed" || getRunStatus(cloned) === "failed")) {
				try {
					fs.rmSync(cloned.resume.dir, { recursive: true, force: true });
					try {
						fs.rmdirSync(path.dirname(cloned.resume.dir));
					} catch {
						/* Other child sessions still use the shared directory. */
					}
					delete cloned.resume;
				} catch {
					/* Keep the path for a later cleanup attempt. */
				}
			}
			return cloned;
		}),
	};
}

async function cloneContinuationDetails(details: SubagentDetails, childrenRoot: string) {
	const results: SingleResult[] = [];
	const created: ResumeHandle[] = [];
	try {
		for (const result of details.results) {
			const cloned = cloneResult(result);
			if (cloned.resume && !isResumable(cloned)) delete cloned.resume;
			if (cloned.resume) {
				if (cloned.resume.pid && isProcessAlive(cloned.resume.pid)) {
					throw new Error(`The source child process (${cloned.resume.pid}) is still running.`);
				}
				cloned.resume = await cloneResumableForkSession(cloned.resume, childrenRoot);
				created.push(cloned.resume);
			}
			results.push(cloned);
		}
		return { ...details, results };
	} catch (error) {
		for (const resume of created) fs.rmSync(resume.dir, { recursive: true, force: true });
		throw error;
	}
}

function isSubagentDetails(value: unknown): value is SubagentDetails {
	if (!value || typeof value !== "object") return false;
	const details = value as Partial<SubagentDetails>;
	return (
		(details.mode === "single" || details.mode === "parallel" || details.mode === "chain") &&
		Array.isArray(details.results)
	);
}

function normalizeInterruptedDetails(details: SubagentDetails): SubagentDetails {
	return {
		...details,
		results: details.results.map((result) => {
			if (getRunStatus(result) !== "running") return cloneResult(result);
			return {
				...cloneResult(result),
				status: result.resume ? "interrupted" : "pending",
				stopReason: "aborted",
				exitCode: 130,
			};
		}),
	};
}

export function findLatestContinuation(
	entries: readonly any[],
	owner?: { sessionId?: string; sessionFile?: string },
): ContinuationCandidate | undefined {
	const calls: Array<{ id: string; args: SubagentInput; entryId: string }> = [];
	const states = new Map<string, ContinuationState>();
	const toolResults = new Map<string, SubagentDetails>();
	const seenToolResults = new Set<string>();
	const deliveredContinuations = new Set<string>();
	const allManifests = listContinuationManifests<SubagentInput, SubagentDetails>()
		.filter((manifest) => isSubagentDetails(manifest.details))
		.sort((left, right) => {
			const readiness = Number(hasReadyResults(left.status)) - Number(hasReadyResults(right.status));
			return readiness || left.updatedAt - right.updatedAt;
		});
	const sourceManifests = new Map(allManifests.map((manifest) => [manifest.parentToolCallId, manifest] as const));
	const manifests = new Map(
		allManifests
			.filter((manifest) => {
				if (owner?.sessionId && manifest.parentSessionId !== owner.sessionId) return false;
				if (owner?.sessionFile && manifest.parentSessionFile && path.resolve(manifest.parentSessionFile) !== path.resolve(owner.sessionFile)) return false;
				return true;
			})
			.map((manifest) => [manifest.parentToolCallId, manifest] as const),
	);

	for (const entry of entries) {
		if (entry?.type === "message" && entry.message?.role === "assistant") {
			if (entry.message.stopReason === "aborted" || entry.message.stopReason === "error") continue;
			for (const part of entry.message.content ?? []) {
				if (part?.type === "toolCall" && part.name === "subagent" && typeof part.id === "string") {
					calls.push({ id: part.id, args: part.arguments as SubagentInput, entryId: entry.id });
				}
			}
		}
		if (entry?.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === "subagent") {
			if (typeof entry.message.toolCallId === "string") seenToolResults.add(entry.message.toolCallId);
			const details = entry.message.details;
			if (isSubagentDetails(details) && typeof entry.message.toolCallId === "string") {
				toolResults.set(entry.message.toolCallId, details);
			}
		}
		if (entry?.type === "custom_message" && entry.customType === SUBAGENT_CONTINUATION_MESSAGE_TYPE) {
			const continuationId = entry.details?.continuationId;
			if (typeof continuationId === "string") deliveredContinuations.add(continuationId);
		}
		if (entry?.type === "custom" && entry.customType === CONTINUATION_STATE_TYPE) {
			const state = entry.data as ContinuationState | undefined;
			if (state && typeof state.id === "string" && isSubagentDetails(state.details)) states.set(state.id, state);
		}
	}

	for (let index = calls.length - 1; index >= 0; index--) {
		const call = calls[index];
		const state = states.get(call.id);
		if (state?.status === "completed" || deliveredContinuations.has(call.id)) continue;
		const parentToolResult = toolResults.get(call.id);
		if (parentToolResult && !hasResumableWork(normalizeInterruptedDetails(parentToolResult))) continue;
		const manifest = manifests.get(call.id);
		const globalSource = sourceManifests.get(call.id);
		const sourceManifest = globalSource && hasReadyResults(globalSource.status)
			? globalSource
			: manifest ?? globalSource;
		const rawDetails = sourceManifest?.details ?? state?.details ?? parentToolResult ?? (!seenToolResults.has(call.id) ? pendingDetailsFromInput(call.args, call.id) : undefined);
		if (!isSubagentDetails(rawDetails)) continue;
		let details = normalizeInterruptedDetails(rawDetails);
		if (sourceManifest && sourceManifest !== manifest && hasReadyResults(sourceManifest.status)) {
			details = {
				...details,
				results: details.results.map((result) => {
					const cloned = cloneResult(result);
					delete cloned.resume;
					return cloned;
				}),
			};
		}
		if (!hasResumableWork(details) && !sourceManifest) continue;
		return {
			id: call.id,
			details,
			args: sourceManifest?.args ?? call.args,
			toolCallEntryId: call.entryId,
			manifestStatus: sourceManifest?.status,
			manifest,
			sourceManifest: sourceManifest === manifest ? undefined : sourceManifest,
		};
	}
	return undefined;
}

function hasReadyResults(status: StoredContinuation["status"] | undefined) {
	return status === "ready" || status === "resolved";
}

function formatContinuationOutput(details: SubagentDetails) {
	if (!details.results.length) return "No subagent output was recovered.";
	const perResultBytes = Math.max(2000, Math.floor((DEFAULT_MAX_BYTES - 2000) / details.results.length));
	const perResultLines = Math.max(100, Math.floor((DEFAULT_MAX_LINES - 100) / details.results.length));
	const blocks = details.results.map((result) => {
		const output = getFinalOutput(result.messages) || resultError(result);
		const truncated = truncateHead(output, { maxBytes: perResultBytes, maxLines: perResultLines });
		const label = result.step ? `Step ${result.step}: ${result.agent}` : result.agent;
		return `## ${label} (${getRunStatus(result)})\n${truncated.content}${truncated.truncated ? "\n[output truncated]" : ""}`;
	});
	return truncateHead(blocks.join("\n\n"), {
		maxBytes: DEFAULT_MAX_BYTES,
		maxLines: DEFAULT_MAX_LINES,
	}).content;
}

export async function resumeContinuation(
	candidate: ContinuationCandidate,
	ctx: any,
	signal: AbortSignal,
	onProgress: (details: SubagentDetails) => void,
	runOptions: Omit<RunSingleAgentOptions, "resumeFrom"> = {},
): Promise<SubagentDetails> {
	const input = prepareSubagentArguments(candidate.args) as SubagentInput;
	const requestedScope: AgentScope = candidate.details.agentScope ?? input.agentScope ?? "user";
	const projectTrusted = typeof ctx.isProjectTrusted !== "function" || ctx.isProjectTrusted();
	if (requestedScope === "project" && !projectTrusted) throw new Error("Cannot resume a project subagent in an untrusted project.");
	const agentScope: AgentScope = requestedScope === "both" && !projectTrusted ? "user" : requestedScope;
	const discovery = discoverAgents(ctx.cwd, agentScope);
	const agents = discovery.agents;
	const makeDetails = (mode: "single" | "parallel" | "chain", results: SingleResult[]): SubagentDetails => ({
		mode,
		agentScope,
		projectAgentsDir: discovery.projectAgentsDir,
		results,
		...(results.some(isResumable) ? { continuationId: candidate.id } : {}),
	});
	const parentMessages = buildSessionContext(
		ctx.sessionManager.getEntries(),
		candidate.toolCallEntryId,
	).messages;
	const forkContextFor = (value: string | undefined): ForkContext | undefined => {
		if (parseForkTurns(value).kind === "none") return undefined;
		return {
			messages: selectForkMessages(parentMessages, candidate.id, value)!,
			parentSessionFile: ctx.sessionManager.getSessionFile(),
		};
	};

	if (candidate.details.mode === "single") {
		const prior = cloneResult(candidate.details.results[0]);
		const agentName = input.agent ?? prior.agent;
		const result = await runSingleAgent(
			ctx.cwd,
			invocationAgents(agents, agentName, input.instructions),
			agentName,
			input.task ?? prior.task,
			input.cwd,
			invocationContextMode(agents, agentName, input.contextMode),
			invocationModel(agents, agentName, input.size, ctx.model?.provider),
			prior.resume ? undefined : forkContextFor(invocationHistory(agents, agentName, input.forkTurns)),
			undefined,
			signal,
			(partial) => {
				const current = partial.details?.results[0];
				if (current) onProgress(makeDetails("single", [current]));
			},
			(results) => makeDetails("single", results),
			{ ...runOptions, resumeFrom: prior },
		);
		return makeDetails("single", [result]);
	}

	if (candidate.details.mode === "parallel") {
		const results = candidate.details.results.map(cloneResult);
		const resumableIndexes = results.flatMap((result, index) => (isResumable(result) ? [index] : []));
		await mapWithConcurrencyLimit(resumableIndexes, MAX_CONCURRENCY, async (index) => {
			const prior = results[index];
			const task = input.tasks?.[index];
			const agentName = task?.agent ?? prior.agent;
			const result = await runSingleAgent(
				ctx.cwd,
				invocationAgents(agents, agentName, task?.instructions),
				agentName,
				task?.task ?? prior.task,
				task?.cwd,
				invocationContextMode(agents, agentName, task?.contextMode ?? input.contextMode),
				invocationModel(agents, agentName, task?.size ?? input.size, ctx.model?.provider),
				prior.resume ? undefined : forkContextFor(invocationHistory(agents, agentName, task?.forkTurns ?? input.forkTurns)),
				undefined,
				signal,
				(partial) => {
					const current = partial.details?.results[0];
					if (current) {
						results[index] = current;
						onProgress(makeDetails("parallel", results.map(cloneResult)));
					}
				},
				(items) => makeDetails("parallel", items),
				{ ...runOptions, resumeFrom: prior },
			);
			results[index] = result;
			onProgress(makeDetails("parallel", results.map(cloneResult)));
			return result;
		});
		return makeDetails("parallel", results);
	}

	const results = candidate.details.results.map(cloneResult);
	const interruptedIndex = results.findIndex(isResumable);
	let nextIndex = results.length;
	if (interruptedIndex >= 0) {
		const prior = results[interruptedIndex];
		const interruptedStep = input.chain?.[interruptedIndex];
		const agentName = interruptedStep?.agent ?? prior.agent;
		results[interruptedIndex] = await runSingleAgent(
			ctx.cwd,
			invocationAgents(agents, agentName, interruptedStep?.instructions),
			agentName,
			prior.task,
			interruptedStep?.cwd,
			invocationContextMode(agents, agentName, interruptedStep?.contextMode ?? input.contextMode),
			invocationModel(agents, agentName, interruptedStep?.size ?? input.size, ctx.model?.provider),
			prior.resume ? undefined : forkContextFor(invocationHistory(agents, agentName, interruptedStep?.forkTurns ?? input.forkTurns)),
			interruptedIndex + 1,
			signal,
			(partial) => {
				const current = partial.details?.results[0];
				if (current) {
					results[interruptedIndex] = current;
					onProgress(makeDetails("chain", results.map(cloneResult)));
				}
			},
			(items) => makeDetails("chain", items),
			{ ...runOptions, resumeFrom: prior },
		);
		if (isResumable(results[interruptedIndex]) || getRunStatus(results[interruptedIndex]) === "failed") {
			return makeDetails("chain", results);
		}
		nextIndex = interruptedIndex + 1;
	}

	let previousOutput = results.length > 0 ? getFinalOutput(results[results.length - 1].messages) : "";
	for (let index = nextIndex; index < (input.chain?.length ?? 0); index++) {
		const step = input.chain![index];
		const task = step.task.replace(/\{previous\}/g, previousOutput);
		const result = await runSingleAgent(
			ctx.cwd,
			invocationAgents(agents, step.agent, step.instructions),
			step.agent,
			task,
			step.cwd,
			invocationContextMode(agents, step.agent, step.contextMode ?? input.contextMode),
			invocationModel(agents, step.agent, step.size ?? input.size, ctx.model?.provider),
			forkContextFor(invocationHistory(agents, step.agent, step.forkTurns ?? input.forkTurns)),
			index + 1,
			signal,
			(partial) => {
				const current = partial.details?.results[0];
				if (current) onProgress(makeDetails("chain", [...results, current]));
			},
			(items) => makeDetails("chain", items),
			runOptions,
		);
		results.push(result);
		onProgress(makeDetails("chain", results.map(cloneResult)));
		if (isResumable(result) || getRunStatus(result) === "failed") break;
		previousOutput = getFinalOutput(result.messages);
	}
	return makeDetails("chain", results);
}

export default function (pi: ExtensionAPI) {
	installSubagentWrapSupport(pi);
	registerNamedSubagentTools(pi, { runSingleAgent, sizedModel });
	pi.on("session_start", (_event, ctx) => {
		const projectTrusted = typeof ctx.isProjectTrusted !== "function" || ctx.isProjectTrusted();
		registerNamedSubagentTools(pi, { runSingleAgent, sizedModel }, ctx.cwd, projectTrusted, ctx.sessionManager.getSessionId());
	});
	const subagentDescription = (cwd: string, includeProject: boolean) => {
		const available = formatAgentList(discoverAgents(cwd, includeProject ? "both" : "user").agents);
		const agentDescription = `${available.text}${available.remaining ? `; +${available.remaining} more` : ""}`;
		return [
			"Run a quick one-off subagent. Supports single, parallel, and sequential chain modes.",
			`Configured templates: ${agentDescription}.`,
			'Trusted project templates under .agents/subagents are included by default and override same-named user templates.',
			'Use size="big" for GPT-5.6 Sol/high or size="small" for GPT-5.6 Luna/high; template defaults apply when omitted.',
			"instructions replaces the selected template's instruction body while retaining its capabilities.",
			'Use forkTurns="none" (default), "all", or a positive number of recent parent turns.',
		].join(" ");
	};
	const registerSubagentTool = (description: string) => pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description,
		parameters: SubagentParams,
		prepareArguments: prepareSubagentArguments,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const requestedScope: AgentScope = params.agentScope ?? "both";
			const projectTrusted = typeof ctx.isProjectTrusted !== "function" || ctx.isProjectTrusted();
			if (requestedScope === "project" && !projectTrusted) {
				return { content: [{ type: "text", text: "Project subagents are unavailable because this project is not trusted." }], details: undefined };
			}
			const agentScope: AgentScope = requestedScope === "both" && !projectTrusted ? "user" : requestedScope;
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
					...(results.some(isResumable) ? { continuationId: toolCallId } : {}),
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			const effectiveForkTurns: Array<string | undefined> = params.chain?.length
				? params.chain.map((step) => invocationHistory(agents, step.agent, step.forkTurns ?? params.forkTurns))
				: params.tasks?.length
					? params.tasks.map((task) => invocationHistory(agents, task.agent, task.forkTurns ?? params.forkTurns))
					: [invocationHistory(agents, params.agent ?? "", params.forkTurns)];
			for (const value of effectiveForkTurns) parseForkTurns(value);

			let parentMessages: AgentMessage[] | undefined;
			const forkContextFor = (value: string | undefined): ForkContext | undefined => {
				if (parseForkTurns(value).kind === "none") return undefined;
				const sessionManager = ctx.sessionManager as typeof ctx.sessionManager & {
					buildSessionContext(): { messages: AgentMessage[] };
				};
				const messages = parentMessages ??= sessionManager.buildSessionContext().messages;
				return {
					messages: selectForkMessages(messages, toolCallId, value)!,
					parentSessionFile: ctx.sessionManager.getSessionFile(),
				};
			};

			if (params.tasks && params.tasks.length > MAX_PARALLEL_TASKS) {
				return {
					content: [{ type: "text", text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
					details: makeDetails("parallel")([]),
				};
			}

			if (agentScope === "project" || agentScope === "both") {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					if (!ctx.hasUI) {
						return {
							content: [{ type: "text", text: `Canceled: project-local agents require interactive approval (${names}).` }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
					}
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			const mode: "single" | "parallel" | "chain" = hasChain ? "chain" : hasTasks ? "parallel" : "single";
			const initialResults = params.chain
				? [pendingResult(params.chain[0].agent, params.chain[0].task.replace(/\{previous\}/g, ""), 1)]
				: params.tasks
					? params.tasks.map((task) => pendingResult(task.agent, task.task))
					: [pendingResult(params.agent!, params.task!)];
			let manifest: StoredContinuation = {
				version: CONTINUATION_MANIFEST_VERSION,
				id: toolCallId,
				parentSessionId: ctx.sessionManager.getSessionId(),
				...(ctx.sessionManager.getSessionFile() ? { parentSessionFile: ctx.sessionManager.getSessionFile() } : {}),
				parentBranchAnchor: ctx.sessionManager.getLeafId(),
				parentToolCallId: toolCallId,
				mode,
				args: { ...params, agentScope } as SubagentInput,
				details: makeDetails(mode)(initialResults),
				status: "pending",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
			const releaseLease = acquireContinuationLease(toolCallId, manifest.parentSessionId);
			let leaseReleased = false;
			const releaseOrchestrationLease = () => {
				if (leaseReleased) return;
				leaseReleased = true;
				releaseLease();
			};
			let continuationLocation: ContinuationLocation;
			try {
				continuationLocation = writeContinuationManifest(manifest);
			} catch (error) {
				releaseOrchestrationLease();
				throw error;
			}
			const persistContinuation = (
				details: SubagentDetails,
				status?: StoredContinuation["status"],
			) => {
				const inferredStatus = details.results.some((result) => getRunStatus(result) === "running")
					? "pending"
					: hasResumableWork(details)
						? "interrupted"
						: "ready";
				manifest = {
					...manifest,
					details,
					status: status ?? inferredStatus,
					updatedAt: Date.now(),
				};
				writeContinuationManifest(manifest);
			};
			const commitContinuation = (details: SubagentDetails, status?: StoredContinuation["status"]) => {
				persistContinuation(details, status);
				if (!details.results.some((result) => result.resume && (getRunStatus(result) === "completed" || getRunStatus(result) === "failed"))) {
					return details;
				}
				const cleaned = cleanupCommittedSessions(details);
				persistContinuation(cleaned, status);
				return cleaned;
			};
			const finishContinuation = (details: SubagentDetails) => {
				const interrupted = hasResumableWork(details);
				const committed = commitContinuation(details, interrupted ? "interrupted" : "ready");
				if (interrupted) {
					pi.appendEntry(CONTINUATION_STATE_TYPE, {
						id: toolCallId,
						status: "interrupted",
						details: committed,
						updatedAt: Date.now(),
					} satisfies ContinuationState);
				}
				releaseOrchestrationLease();
				return committed;
			};

			try {
			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					const chainUpdate: OnUpdateCallback = (partial) => {
						const currentResult = partial.details?.results[0];
						if (!currentResult) return;
						const details = makeDetails("chain")([...results, currentResult]);
						persistContinuation(details, "pending");
						onUpdate?.({ content: partial.content, details });
					};

					const result = await runSingleAgent(
						ctx.cwd,
						invocationAgents(agents, step.agent, step.instructions),
						step.agent,
						taskWithContext,
						step.cwd,
						invocationContextMode(agents, step.agent, step.contextMode ?? params.contextMode),
						invocationModel(agents, step.agent, step.size ?? params.size, ctx.model?.provider),
						forkContextFor(invocationHistory(agents, step.agent, step.forkTurns ?? params.forkTurns)),
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
						{ runsRoot: continuationLocation.childrenRoot, retainTerminalSession: true },
					);
					results.push(result);

					if (isResumable(result)) {
						const details = finishContinuation(makeDetails("chain")(results));
						return {
							content: [{ type: "text", text: `Chain interrupted at step ${i + 1}. Run /continue to resume.` }],
							details,
						};
					}
					if (getRunStatus(result) === "failed") {
						const details = finishContinuation(makeDetails("chain")(results));
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${resultError(result)}` }],
							details,
						};
					}
					previousOutput = getFinalOutput(result.messages);
					if (i + 1 < params.chain.length) {
						const committed = commitContinuation(makeDetails("chain")(results), "pending");
						results.splice(0, results.length, ...committed.results);
					}
				}
				const details = finishContinuation(makeDetails("chain")(results));
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details,
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						status: "running",
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					const running = allResults.filter((result) => getRunStatus(result) === "running").length;
					const done = allResults.length - running;
					const details = commitContinuation(makeDetails("parallel")([...allResults]));
					allResults.splice(0, allResults.length, ...details.results);
					onUpdate?.({
						content: [
							{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
						],
						details,
					});
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						invocationAgents(agents, t.agent, t.instructions),
						t.agent,
						t.task,
						t.cwd,
						invocationContextMode(agents, t.agent, t.contextMode ?? params.contextMode),
						invocationModel(agents, t.agent, t.size ?? params.size, ctx.model?.provider),
						forkContextFor(invocationHistory(agents, t.agent, t.forkTurns ?? params.forkTurns)),
						undefined,
						signal,
						// Per-task update callback
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
						{ runsRoot: continuationLocation.childrenRoot, retainTerminalSession: true },
					);
					allResults[index] = result;
					emitParallelUpdate();
					return allResults[index];
				});

				let details = makeDetails("parallel")(results);
				if (hasResumableWork(details)) {
					details = finishContinuation(details);
					const completed = results.filter((result) => getRunStatus(result) === "completed").length;
					return {
						content: [{ type: "text", text: `Parallel subagents interrupted after ${completed}/${results.length} completed. Run /continue to resume.` }],
						details,
					};
				}
				const successCount = results.filter((result) => getRunStatus(result) === "completed").length;
				const summaries = results.map((result) => {
					const output = getFinalOutput(result.messages);
					const preview = output.slice(0, 100) + (output.length > 100 ? "..." : "");
					return `[${result.agent}] ${getRunStatus(result)}: ${preview || "(no output)"}`;
				});
				details = finishContinuation(details);
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
						},
					],
					details,
				};
			}

			if (params.agent && params.task) {
				const singleUpdate: OnUpdateCallback = (partial) => {
					const current = partial.details?.results[0];
					if (!current) return;
					const details = makeDetails("single")([current]);
					persistContinuation(details);
					onUpdate?.({ content: partial.content, details });
				};
				const result = await runSingleAgent(
					ctx.cwd,
					invocationAgents(agents, params.agent, params.instructions),
					params.agent,
					params.task,
					params.cwd,
					invocationContextMode(agents, params.agent, params.contextMode),
					invocationModel(agents, params.agent, params.size, ctx.model?.provider),
					forkContextFor(invocationHistory(agents, params.agent, params.forkTurns)),
					undefined,
					signal,
					singleUpdate,
					makeDetails("single"),
					{ runsRoot: continuationLocation.childrenRoot, retainTerminalSession: true },
				);
				if (isResumable(result)) {
					const details = finishContinuation(makeDetails("single")([result]));
					return {
						content: [{ type: "text", text: "Subagent interrupted. Run /continue to resume." }],
						details,
					};
				}
				if (getRunStatus(result) === "failed") {
					const details = finishContinuation(makeDetails("single")([result]));
					return {
						content: [{ type: "text", text: `Agent failed: ${resultError(result)}` }],
						details,
					};
				}
				const details = finishContinuation(makeDetails("single")([result]));
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details,
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			releaseOrchestrationLease();
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
			} catch (error) {
				releaseOrchestrationLease();
				throw error;
			}
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "both";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const failCount = details.results.filter((r) => r.exitCode > 0).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: r.exitCode === 0
								? theme.fg("success", "✓")
								: theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
	registerSubagentTool(subagentDescription(process.cwd(), false));
	pi.on("session_start", (_event, ctx) => {
		const projectTrusted = typeof ctx.isProjectTrusted !== "function" || ctx.isProjectTrusted();
		registerSubagentTool(subagentDescription(ctx.cwd, projectTrusted));
	});

	pi.on("agent_end", (_event, ctx) => {
		const branch = ctx.sessionManager.getBranch();
		const terminalToolCalls = new Set<string>();
		const deliveredContinuations = new Set<string>();
		const resolvedContinuations = new Set<string>();
		for (const entry of branch as readonly any[]) {
			if (entry?.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === "subagent") {
				const details = entry.message.details;
				if (isSubagentDetails(details) && !hasResumableWork(normalizeInterruptedDetails(details))) {
					terminalToolCalls.add(entry.message.toolCallId);
				}
			}
			if (entry?.type === "custom_message" && entry.customType === SUBAGENT_CONTINUATION_MESSAGE_TYPE) {
				const continuationId = entry.details?.continuationId;
				if (typeof continuationId === "string") deliveredContinuations.add(continuationId);
			}
			if (entry?.type === "custom" && entry.customType === CONTINUATION_STATE_TYPE && entry.data?.status === "completed") {
				if (typeof entry.data.id === "string") resolvedContinuations.add(entry.data.id);
			}
		}
		const sessionFile = ctx.sessionManager.getSessionFile();
		for (const manifest of listContinuationManifests<SubagentInput, SubagentDetails>()) {
			if (manifest.parentSessionId !== ctx.sessionManager.getSessionId()) continue;
			if (manifest.parentSessionFile && sessionFile && path.resolve(manifest.parentSessionFile) !== path.resolve(sessionFile)) continue;
			const parentResultIsTerminal = terminalToolCalls.has(manifest.parentToolCallId);
			if (resolvedContinuations.has(manifest.id)) {
				if (parentResultIsTerminal) removeContinuation(manifest.id, manifest.parentSessionId);
				continue;
			}
			if (!parentResultIsTerminal && !deliveredContinuations.has(manifest.id)) continue;
			if (!parentResultIsTerminal && manifest.status !== "resolved") {
				writeContinuationManifest({ ...manifest, status: "resolved", updatedAt: Date.now() });
			}
			pi.appendEntry(CONTINUATION_STATE_TYPE, {
				id: manifest.id,
				status: "completed",
				details: manifest.details,
				updatedAt: Date.now(),
			} satisfies ContinuationState);
			if (parentResultIsTerminal) removeContinuation(manifest.id, manifest.parentSessionId);
		}
	});

	const continueMain = async () => {
		await pi.sendMessage(
			{
				customType: MAIN_CONTINUATION_MESSAGE_TYPE,
				content: "<system-reminder>\nContinue the interrupted main task from the current conversation and external state. Preserve completed work, verify uncertain side effects, and do not restart the task unnecessarily.\n</system-reminder>",
				display: false,
			},
			{ deliverAs: "steer", triggerTurn: true },
		);
	};

	const continueCommand = {
		description: "Resume interrupted subagents, or continue the main agent",
		handler: async (_args: string, ctx: ExtensionContext) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the current run to stop before using /continue.", "warning");
				return;
			}

			let candidate = findLatestContinuation(ctx.sessionManager.getBranch(), {
				sessionId: ctx.sessionManager.getSessionId(),
				sessionFile: ctx.sessionManager.getSessionFile(),
			});
			if (!candidate) return continueMain();

			const scope = candidate.args.agentScope ?? "user";
			if (scope === "project" || scope === "both") {
				const discovery = discoverAgents(ctx.cwd, scope);
				const requested = new Set([
					...(candidate.args.agent ? [candidate.args.agent] : []),
					...(candidate.args.tasks?.map((task) => task.agent) ?? []),
					...(candidate.args.chain?.map((step) => step.agent) ?? []),
				]);
				const projectAgents = discovery.agents.filter((agent) => agent.source === "project" && requested.has(agent.name));
				if (projectAgents.length > 0) {
					if (!ctx.hasUI) {
						ctx.ui.notify("Project-local continuation requires interactive approval.", "warning");
						return;
					}
					const approved = await ctx.ui.confirm(
						"Resume project-local agents?",
						`Agents: ${projectAgents.map((agent) => agent.name).join(", ")}\nSource: ${discovery.projectAgentsDir ?? "(unknown)"}`,
					);
					if (!approved) return;
				}
			}

			const ownerSessionId = ctx.sessionManager.getSessionId();
			let releaseLease: () => void;
			try {
				releaseLease = acquireContinuationLease(candidate.id, ownerSessionId);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
				return;
			}

			if (!candidate.manifest && candidate.details.results.some((result) => result.resume)) {
				let releaseSource: (() => void) | undefined;
				try {
					if (candidate.sourceManifest && candidate.sourceManifest.parentSessionId !== ownerSessionId) {
						releaseSource = acquireContinuationLease(candidate.id, candidate.sourceManifest.parentSessionId);
					}
					const childrenRoot = getContinuationLocation(
						candidate.id,
						ctx.sessionManager.getSessionId(),
					).childrenRoot;
					candidate = {
						...candidate,
						details: await cloneContinuationDetails(candidate.details, childrenRoot),
					};
				} catch (error) {
					releaseLease();
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
					return;
				} finally {
					releaseSource?.();
				}
			}

			const controller = new AbortController();
			let latestDetails = candidate.details;
			let manifest = candidate.manifest;
			if (!manifest) {
				manifest = {
					version: CONTINUATION_MANIFEST_VERSION,
					id: candidate.id,
					parentSessionId: ctx.sessionManager.getSessionId(),
					...(ctx.sessionManager.getSessionFile() ? { parentSessionFile: ctx.sessionManager.getSessionFile() } : {}),
					parentBranchAnchor: candidate.toolCallEntryId,
					parentToolCallId: candidate.id,
					mode: candidate.details.mode,
					args: candidate.args,
					details: candidate.details,
					status: candidate.manifestStatus ?? "pending",
					createdAt: Date.now(),
					updatedAt: Date.now(),
				};
				try {
					writeContinuationManifest(manifest);
				} catch (error) {
					releaseLease();
					throw error;
				}
			}
			const persistResumedState = (details: SubagentDetails, status: StoredContinuation["status"]) => {
				if (!manifest) return;
				manifest = { ...manifest, details, status, updatedAt: Date.now() };
				writeContinuationManifest(manifest);
			};
			const commitResumedState = (details: SubagentDetails, status: StoredContinuation["status"]) => {
				persistResumedState(details, status);
				if (!details.results.some((result) => result.resume && (getRunStatus(result) === "completed" || getRunStatus(result) === "failed"))) {
					return details;
				}
				const cleaned = cleanupCommittedSessions(details);
				persistResumedState(cleaned, status);
				return cleaned;
			};
			const updateStatus = (details: SubagentDetails) => {
				const completed = details.results.filter((result) => getRunStatus(result) === "completed").length;
				const unfinished = details.results.filter(isResumable).length;
				const running = details.results.some((result) => getRunStatus(result) === "running");
				latestDetails = commitResumedState(details, running ? "pending" : unfinished > 0 ? "interrupted" : "ready");
				ctx.ui.setStatus(
					"subagent-continue",
					`resuming subagents: ${completed} completed, ${unfinished} unfinished (Esc to pause)`,
				);
			};
			const unsubscribe =
				ctx.mode === "tui"
					? ctx.ui.onTerminalInput((data) => {
							if (!matchesKey(data, "escape")) return undefined;
							controller.abort();
							return { consume: true };
						})
					: () => {};

			try {
				ctx.ui.setStatus("subagent-continue", hasReadyResults(candidate.manifestStatus) ? "recovering subagent results…" : "resuming subagents… (Esc to pause)");
				if (!hasReadyResults(candidate.manifestStatus)) {
					latestDetails = await resumeContinuation(
						candidate,
						ctx,
						controller.signal,
						updateStatus,
						{
							runsRoot: getContinuationLocation(candidate.id, manifest.parentSessionId).childrenRoot,
							retainTerminalSession: true,
						},
					);
				}
				latestDetails = commitResumedState(latestDetails, hasResumableWork(latestDetails) ? "interrupted" : "ready");
			} catch (error) {
				latestDetails = commitResumedState(normalizeInterruptedDetails(latestDetails), "interrupted");
				pi.appendEntry(CONTINUATION_STATE_TYPE, {
					id: candidate.id,
					status: "interrupted",
					details: latestDetails,
					updatedAt: Date.now(),
				} satisfies ContinuationState);
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			} finally {
				releaseLease();
				unsubscribe();
				ctx.ui.setStatus("subagent-continue", undefined);
			}

			if (hasResumableWork(latestDetails)) {
				latestDetails = commitResumedState(latestDetails, "interrupted");
				pi.appendEntry(CONTINUATION_STATE_TYPE, {
					id: candidate.id,
					status: "interrupted",
					details: latestDetails,
					updatedAt: Date.now(),
				} satisfies ContinuationState);
				ctx.ui.notify("Subagent continuation paused. Run /continue again to resume.", "warning");
				return;
			}

			const releaseDeliveryLease = acquireContinuationLease(candidate.id, manifest.parentSessionId);
			try {
				latestDetails = commitResumedState(latestDetails, "ready");
				pi.sendMessage(
					{
						customType: SUBAGENT_CONTINUATION_MESSAGE_TYPE,
						content: `<system-reminder>\nInterrupted subagent work has resumed and completed. Treat these results as the completion of the earlier subagent call, continue the original task, and verify external side effects before retrying uncertain work.\n\n${formatContinuationOutput(latestDetails)}\n</system-reminder>`,
						display: false,
						details: { continuationId: candidate.id },
					},
					{ deliverAs: "steer", triggerTurn: false },
				);
			} finally {
				releaseDeliveryLease();
			}
			pi.sendMessage(
				{
					customType: SUBAGENT_CONTINUATION_TRIGGER_TYPE,
					content: "<system-reminder>\nUse the resumed subagent results immediately above and continue the original parent task now.\n</system-reminder>",
					display: false,
				},
				{ deliverAs: "steer", triggerTurn: true },
			);
		},
	};
	pi.registerCommand("continue", continueCommand);

	const unsubscribeContinueRequests = pi.events.on(CONTINUATION_REQUEST_CHANNEL, (value) => {
		if (!value || typeof value !== "object" || !("context" in value) || "run" in value) return;
		const request = value as ContinuationRequest;
		request.run = request.target === "main"
			? continueMain()
			: continueCommand.handler("", request.context);
	});
	pi.on("session_shutdown", () => unsubscribeContinueRequests());
}

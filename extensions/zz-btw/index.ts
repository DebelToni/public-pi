import { spawnSync } from "node:child_process";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	cleanupSessionResources,
	streamSimple,
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type Model,
	type ModelThinkingLevel,
	type UserMessage,
} from "@earendil-works/pi-ai/compat";
import {
	convertToLlm,
	copyToClipboard,
	getMarkdownTheme,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Input,
	Markdown,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type Focusable,
	type TUI,
} from "@earendil-works/pi-tui";
import {
	CacheSafetyError,
	buildCacheForkPayload,
	cloneValue,
	formatUsage,
	isRecord,
	promptCacheKey,
	roughSharedTokenEstimate,
	type CacheUsage,
	type JsonRecord,
} from "./cache.ts";
import { BtwRunLogger, errorDiagnostics, payloadDiagnostics } from "./log.ts";

const SUPPORTED_API = "openai-codex-responses";
const MIN_CACHEABLE_TOKENS = 1_024;
const MAX_CAPSULE_AGE_MS = 4 * 60 * 1_000;
const SIDE_TIMEOUT_MS = 3 * 60 * 1_000;
// A first output delta precedes globally routable prompt-cache visibility.
export const CACHE_VISIBILITY_DELAY_MS = 2_000;
const MAX_VISIBLE_ANSWER_LINES = 26;
const MAX_DIRECT_OSC52_ENCODED_LENGTH = 100_000;

export function cacheVisibilityReadyAt(firstParentContentAt: number) {
	return firstParentContentAt + CACHE_VISIBILITY_DELAY_MS;
}

const SIDE_MODE_PROMPT = `<system-reminder>
This is an ephemeral /btw side conversation running independently from the main agent.

- The main agent continues independently; do not describe yourself as interrupting it.
- Use only the inherited conversation snapshot and this side thread.
- Tool definitions are present only to preserve the parent's prompt cache. You have no tool access: never call, request, simulate, or promise to use a tool.
- Do not continue or implement the main task.
- You will not receive later parent progress. If an answer requires it, say so briefly.
- Be concise unless the question explicitly asks for detail.
</system-reminder>`;

type ParentCapsule = {
	captureId: number;
	capturedAt: number;
	payload: JsonRecord;
	model: Model<Api>;
	thinkingLevel: ModelThinkingLevel;
	sessionId: string;
	auth: SideAuth;
	contextMessages: AgentMessage[];
	readyAt?: number;
	completedAt?: number;
	response?: AssistantMessage;
	responseId?: string;
	parentPromptTokens?: number;
	roughSharedTokens: number;
	consumedAt?: number;
	runLogger?: BtwRunLogger;
};

type SideAuth = {
	apiKey: string;
	headers?: Record<string, string | null>;
	env?: Record<string, string>;
};

type PendingParentAuth = Omit<SideAuth, "headers"> & {
	modelKey: string;
	headers: Record<string, string | null>;
};

type SideThread = {
	capsule: ParentCapsule;
	baseMessages: AgentMessage[];
	messages: Array<UserMessage | AssistantMessage>;
	transportSessionId: string;
	requestSequence: number;
};

type SideTurn = {
	question: string;
	answer: string;
	state: "loading" | "done" | "error";
	phase: "waiting" | "streaming";
	error: string;
	usage?: CacheUsage;
	cacheMiss: boolean;
};

type RenderedSideTurn = {
	width: number;
	index: number;
	answer: string;
	state: SideTurn["state"];
	phase: SideTurn["phase"];
	error: string;
	usage?: CacheUsage;
	cacheMiss: boolean;
	lines: string[];
};

function modelKey(model: Pick<Model<Api>, "provider" | "id" | "api">) {
	return `${model.provider}/${model.id}/${model.api}`;
}

function assistantMatchesCapsule(message: AgentMessage, capsule: ParentCapsule | undefined): message is AssistantMessage {
	return !!capsule
		&& message.role === "assistant"
		&& message.provider === capsule.model.provider
		&& message.model === capsule.model.id
		&& (!capsule.responseId || !message.responseId || capsule.responseId === message.responseId);
}

function promptTokens(message: AssistantMessage) {
	return message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
}

function sidePrompt(question: string) {
	return `${SIDE_MODE_PROMPT}\n\n${question}`;
}

function toolSafetyProblem(payload: JsonRecord) {
	if (Array.isArray(payload.tools)) {
		const hostedTool = payload.tools.find((tool) => !isRecord(tool) || tool.type !== "function");
		if (hostedTool) return "/btw cannot safely inherit provider-hosted tools from this parent request.";
	}
	if (payload.tool_choice !== undefined && payload.tool_choice !== "auto" && payload.tool_choice !== "none") {
		return "/btw cannot safely inherit a parent request that forces tool use.";
	}
	return undefined;
}

function cleanOneLine(text: string) {
	return text.replace(/\s+/g, " ").trim();
}

function padToWidth(text: string, width: number) {
	const truncated = truncateToWidth(text, width, "");
	return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

function copyOverOsc52(text: string) {
	if (process.env.TMUX) {
		const result = spawnSync("tmux", ["load-buffer", "-w", "-"], {
			input: text,
			encoding: "utf8",
			timeout: 5_000,
			maxBuffer: 4_096,
		});
		if (result.error) throw result.error;
		if (result.status !== 0) {
			throw new Error((result.stderr || "").trim() || `tmux load-buffer exited with status ${result.status}`);
		}
		return;
	}

	const encoded = Buffer.from(text).toString("base64");
	if (encoded.length > MAX_DIRECT_OSC52_ENCODED_LENGTH) {
		throw new Error("Conversation is too large for safe direct OSC 52 copying");
	}
	process.stdout.write(`\x1b]52;c;${encoded}\x07`);
}

async function copyBtwConversation(text: string) {
	await copyToClipboard(text);
	copyOverOsc52(text);
}

export class BtwOverlay implements Component, Focusable {
	private readonly turns: SideTurn[];
	private readonly input = new Input();
	private turnRenderCache = new WeakMap<SideTurn, RenderedSideTurn>();
	private scrollOffset = 0;
	private renderedTranscriptLines = 0;
	private followTail = true;
	private followUpsEnabled = false;
	private copyInProgress = false;
	private copyNotice?: { text: string; color: "dim" | "success" | "error" };
	private closed = false;
	private closeReason?: string;
	private _focused = false;
	readonly controller = new AbortController();

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		question: string,
		private readonly done: () => void,
		private readonly onFollowUp: (question: string) => void,
		private readonly copyText: (text: string) => Promise<void> = copyBtwConversation,
	) {
		this.turns = [{ question, answer: "", state: "loading", phase: "streaming", error: "", cacheMiss: false }];
		this.input.onSubmit = (value) => this.submitFollowUp(value);
		this.input.onEscape = () => this.close("input-cancel");
	}

	get focused() {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value && this.canAcceptInput();
	}

	get signal() {
		return this.controller.signal;
	}

	get isClosed() {
		return this.closed;
	}

	get closedBy() {
		return this.closeReason;
	}

	get turnCount() {
		return this.turns.length;
	}

	get isLoading() {
		return this.activeTurn().state === "loading";
	}

	enableFollowUps() {
		this.followUpsEnabled = true;
		this.input.focused = this._focused && this.canAcceptInput();
		this.tui.requestRender();
	}

	setWaiting() {
		this.activeTurn().phase = "waiting";
		this.tui.requestRender();
	}

	setStreaming() {
		this.activeTurn().phase = "streaming";
		this.tui.requestRender();
	}

	appendText(delta: string) {
		this.activeTurn().answer += delta;
		this.tui.requestRender();
	}

	setAnswer(text: string) {
		this.activeTurn().answer = text;
		this.tui.requestRender();
	}

	setDone(usage: CacheUsage, cacheMiss: boolean) {
		const turn = this.activeTurn();
		turn.state = "done";
		turn.usage = usage;
		turn.cacheMiss = cacheMiss;
		this.input.focused = this._focused && this.canAcceptInput();
		this.tui.requestRender();
	}

	setError(message: string) {
		const turn = this.activeTurn();
		turn.state = "error";
		turn.error = message;
		this.input.focused = this._focused && this.canAcceptInput();
		this.tui.requestRender();
	}

	close(reason = "programmatic") {
		if (this.closed) return;
		this.closed = true;
		this.closeReason = reason;
		this.input.focused = false;
		this.controller.abort();
		this.done();
	}

	private activeTurn() {
		return this.turns[this.turns.length - 1]!;
	}

	private conversationText() {
		return this.turns.map((turn, index) => {
			let answer: string;
			if (turn.state === "error") {
				answer = `[error]\n${turn.error || "Unknown /btw error."}`;
			} else if (turn.answer.trim()) {
				answer = turn.state === "loading"
					? `${turn.answer.trim()}\n\n[response still streaming]`
					: turn.answer.trim();
			} else {
				answer = turn.state === "loading" ? "[response pending]" : "[no text response]";
			}
			return `Q${index + 1}:\n${turn.question.trim()}\n\nA${index + 1}:\n${answer}`;
		}).join("\n\n---\n\n");
	}

	private async copyConversation() {
		if (this.copyInProgress) return;
		this.copyInProgress = true;
		this.copyNotice = { text: "Copying whole /btw conversation…", color: "dim" };
		this.tui.requestRender();
		try {
			await this.copyText(this.conversationText());
			this.copyNotice = { text: "Copied whole conversation to clipboard + OSC 52", color: "success" };
		} catch (error) {
			this.copyNotice = {
				text: `Copy failed: ${error instanceof Error ? error.message : String(error)}`,
				color: "error",
			};
		} finally {
			this.copyInProgress = false;
			if (!this.closed) this.tui.requestRender();
		}
	}

	private canAcceptInput() {
		return this.followUpsEnabled && !this.closed && !this.isLoading;
	}

	private submitFollowUp(value: string) {
		const question = value.trim();
		if (!question || !this.canAcceptInput()) return;
		this.copyNotice = undefined;
		this.input.setValue("");
		this.turns.push({ question, answer: "", state: "loading", phase: "streaming", error: "", cacheMiss: false });
		this.input.focused = false;
		this.followTail = true;
		this.tui.requestRender();
		try {
			this.onFollowUp(question);
		} catch (error) {
			this.setError(error instanceof Error ? error.message : String(error));
		}
	}

	private visibleTranscriptLimit() {
		return Math.max(1, Math.min(MAX_VISIBLE_ANSWER_LINES, Math.floor(this.tui.terminal.rows * 0.85) - 5));
	}

	private scroll(data: string) {
		const limit = this.visibleTranscriptLimit();
		const maxScroll = Math.max(0, this.renderedTranscriptLines - limit);
		if (matchesKey(data, "pageUp") || matchesKey(data, "alt+up")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - limit);
			this.followTail = false;
		} else if (matchesKey(data, "pageDown") || matchesKey(data, "alt+down")) {
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + limit);
			this.followTail = this.scrollOffset === maxScroll;
		} else if (this.isLoading && (matchesKey(data, "up") || data === "k")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			this.followTail = false;
		} else if (this.isLoading && (matchesKey(data, "down") || data === "j")) {
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
			this.followTail = this.scrollOffset === maxScroll;
		} else {
			return false;
		}
		return true;
	}

	handleInput(data: string) {
		if (matchesKey(data, "escape")) {
			this.close("escape");
			return;
		}
		if (matchesKey(data, "ctrl+x")) {
			void this.copyConversation();
			return;
		}
		if (this.scroll(data)) {
			this.tui.requestRender();
			return;
		}
		if (!this.canAcceptInput()) return;
		this.input.handleInput(data);
		this.tui.requestRender();
	}

	private renderTurn(turn: SideTurn, index: number, innerWidth: number) {
		const cached = this.turnRenderCache.get(turn);
		if (cached
			&& cached.width === innerWidth
			&& cached.index === index
			&& cached.answer === turn.answer
			&& cached.state === turn.state
			&& cached.phase === turn.phase
			&& cached.error === turn.error
			&& cached.usage === turn.usage
			&& cached.cacheMiss === turn.cacheMiss) {
			return cached.lines;
		}
		const lines = [this.theme.fg("muted", truncateToWidth(`Q${index + 1}: ${cleanOneLine(turn.question)}`, innerWidth, "…"))];
		if (turn.state === "error") {
			lines.push(...new Markdown(turn.error || "Unknown /btw error.", 0, 0, getMarkdownTheme()).render(innerWidth));
		} else if (turn.answer) {
			lines.push(...new Markdown(turn.answer, 0, 0, getMarkdownTheme()).render(innerWidth));
		} else {
			const text = turn.state === "loading"
				? turn.phase === "waiting" ? "Waiting for the parent prompt cache…" : "Thinking…"
				: "(no text response)";
			lines.push(this.theme.fg("dim", text));
		}
		if (turn.state === "done" && turn.usage) {
			const telemetry = formatUsage(turn.usage);
			lines.push(turn.cacheMiss || turn.usage.cacheWrite > 0
				? this.theme.fg("warning", `${telemetry} · not retried`)
				: this.theme.fg("dim", telemetry));
		}
		this.turnRenderCache.set(turn, {
			width: innerWidth,
			index,
			answer: turn.answer,
			state: turn.state,
			phase: turn.phase,
			error: turn.error,
			usage: turn.usage,
			cacheMiss: turn.cacheMiss,
			lines,
		});
		return lines;
	}

	private transcriptLines(innerWidth: number) {
		const lines: string[] = [];
		for (let index = 0; index < this.turns.length; index++) {
			if (index > 0) lines.push("");
			lines.push(...this.renderTurn(this.turns[index]!, index, innerWidth));
		}
		return lines;
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width > 2 ? width - 2 : width);
		const row = width > 2
			? (text: string) => ` ${padToWidth(text, innerWidth)} `
			: (text: string) => padToWidth(text, width);
		const title = " /btw ";
		const titleWidth = visibleWidth(title);
		const left = Math.max(0, Math.floor((width - titleWidth) / 2));
		const right = Math.max(0, width - titleWidth - left);
		const topText = width >= titleWidth ? `${"─".repeat(left)}${title}${"─".repeat(right)}` : "─".repeat(width);
		const top = this.theme.fg("borderAccent", topText);
		const bottom = this.theme.fg("borderAccent", "─".repeat(width));

		const transcript = this.transcriptLines(innerWidth);
		this.renderedTranscriptLines = transcript.length;
		const visibleLimit = this.visibleTranscriptLimit();
		const maxScroll = Math.max(0, transcript.length - visibleLimit);
		if (this.followTail) this.scrollOffset = maxScroll;
		else this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
		const visible = transcript.slice(this.scrollOffset, this.scrollOffset + visibleLimit);
		const lines = [top, ...visible.map(row)];

		if (maxScroll > 0) {
			lines.push(row(this.theme.fg("dim", `${this.scrollOffset + 1}-${Math.min(transcript.length, this.scrollOffset + visibleLimit)} / ${transcript.length} lines · Option+↑/↓ scroll`)));
		}
		if (this.isLoading) {
			const activity = this.activeTurn().phase === "waiting" ? "Waiting for cache warmup" : "Streaming in parallel";
			const notice = this.copyNotice;
			lines.push(row(this.theme.fg(
				notice?.color ?? "dim",
				notice?.text ?? `${activity} · Ctrl+X copies all · Esc closes`,
			)));
		} else if (!this.followUpsEnabled) {
			const notice = this.copyNotice;
			lines.push(row(this.theme.fg(
				notice?.color ?? "error",
				notice?.text ?? "Side thread unavailable · Ctrl+X copies all · Esc closes",
			)));
		} else {
			this.input.focused = this._focused;
			const [inputLine = "> "] = this.input.render(innerWidth);
			lines.push(row(inputLine));
			const status = this.activeTurn().state === "error"
				? "Request failed; Ctrl+X copies all; the next message continues from the last successful turn"
				: "Enter sends follow-up · Ctrl+X copies all · Esc closes · Option+↑/↓ scroll";
			const notice = this.copyNotice;
			lines.push(row(this.theme.fg(
				notice?.color ?? (this.activeTurn().state === "error" ? "warning" : "dim"),
				notice?.text ?? status,
			)));
		}
		lines.push(bottom);
		return lines;
	}

	invalidate() {
		this.turnRenderCache = new WeakMap();
		this.input.invalidate();
	}
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<boolean> {
	if (signal.aborted) return Promise.resolve(false);
	return new Promise((resolve) => {
		const onAbort = () => finish(false);
		const timer = setTimeout(() => finish(true), ms);
		const finish = (completed: boolean) => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			resolve(completed);
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

export function streamEventForLog(event: AssistantMessageEvent) {
	if (!("partial" in event)) return event;
	// Deltas plus the final result reconstruct the cumulative partial exactly;
	// omitting it avoids synchronously rewriting the full answer on every token.
	const { partial, ...eventWithoutPartial } = event;
	if (event.type === "toolcall_start" || event.type === "toolcall_delta" || event.type === "toolcall_end") {
		return { ...eventWithoutPartial, partialContent: partial.content[event.contentIndex] };
	}
	return eventWithoutPartial;
}

function sharedMessagePrefixLength(prefix: AgentMessage[], messages: AgentMessage[]) {
	const limit = Math.min(prefix.length, messages.length);
	let index = 0;
	while (index < limit && JSON.stringify(prefix[index]) === JSON.stringify(messages[index])) index++;
	return index;
}

function requireDiagnosticLog(logger: BtwRunLogger, event: string, data: Record<string, unknown> = {}) {
	if (logger.write(event, data)) return;
	throw new Error(`Cannot write /btw diagnostic log: ${logger.lastError?.message ?? "unknown error"}`);
}

export default function(pi: ExtensionAPI) {
	let agentRunning = false;
	let latestContextMessages: AgentMessage[] = [];
	let pendingCapsule: ParentCapsule | undefined;
	let latestCapsule: ParentCapsule | undefined;
	let recentCapsules: ParentCapsule[] = [];
	let pendingParentAuth: PendingParentAuth | undefined;
	let lastCaptureProblem = "No cache-ready parent request yet. Send a normal prompt first.";
	let currentProviderProblem = "Waiting for the parent provider request to start.";
	let activeController: AbortController | undefined;
	let activeOverlay: BtwOverlay | undefined;
	let activeLogger: BtwRunLogger | undefined;
	const parentRunLoggers = new Set<BtwRunLogger>();
	let captureSequence = 0;

	function resetCapture(message = "No cache-ready parent request yet. Send a normal prompt first.") {
		latestContextMessages = [];
		pendingCapsule = undefined;
		latestCapsule = undefined;
		recentCapsules = [];
		pendingParentAuth = undefined;
		lastCaptureProblem = message;
		currentProviderProblem = message;
	}

	function capsuleForAssistant(message: AgentMessage) {
		if (message.role !== "assistant") return undefined;
		if (message.responseId) {
			const exact = [...recentCapsules].reverse().find((capsule) => capsule.responseId === message.responseId);
			if (exact) return exact;
		}
		return [...recentCapsules].reverse().find((capsule) => !capsule.completedAt && assistantMatchesCapsule(message, capsule));
	}

	function abortActive(reason: string) {
		activeLogger?.write("lifecycle_abort", { reason });
		activeOverlay?.close(reason);
		activeController?.abort();
	}

	function associateAssistant(message: AgentMessage) {
		const capsule = capsuleForAssistant(message);
		if (!capsule || !assistantMatchesCapsule(message, capsule)) return undefined;
		if (message.responseId) capsule.responseId = message.responseId;
		if (capsule === pendingCapsule || !pendingCapsule) latestCapsule = capsule;
		return capsule;
	}

	function markReady(message: AgentMessage, readyAt = Date.now()) {
		const capsule = associateAssistant(message);
		if (!capsule) return;
		if (!capsule.readyAt) capsule.readyAt = readyAt;
	}

	function capsuleProblem(ctx: ExtensionContext, capsule: ParentCapsule | undefined, requireCompletedResponse: boolean): string | undefined {
		if (!capsule?.readyAt) return lastCaptureProblem;
		if (capsule.consumedAt) return "That parent cache prefix was already used by /btw. Wait for the next parent model request.";
		const cacheAge = Date.now() - capsule.readyAt;
		if (cacheAge > MAX_CAPSULE_AGE_MS) {
			return "The parent cache capsule is over 4 minutes old. Send a normal prompt first.";
		}
		if (!ctx.model || modelKey(ctx.model) !== modelKey(capsule.model)) {
			return "The active model differs from the cache-ready parent request. Send a normal prompt first.";
		}
		if (pi.getThinkingLevel() !== capsule.thinkingLevel) {
			return "The active reasoning level differs from the cache-ready parent request. Send a normal prompt first.";
		}
		if (ctx.sessionManager.getSessionId() !== capsule.sessionId) {
			return "The active session differs from the cache-ready parent request.";
		}
		const toolProblem = toolSafetyProblem(capsule.payload);
		if (toolProblem) return toolProblem;
		if (requireCompletedResponse && (capsule.parentPromptTokens ?? 0) < MIN_CACHEABLE_TOKENS) {
			return `The completed parent prefix is only ${capsule.parentPromptTokens ?? 0} tokens; OpenAI caching requires at least ${MIN_CACHEABLE_TOKENS}.`;
		}
		if (requireCompletedResponse && (capsule.response?.stopReason !== "stop" || !capsule.response.responseId)) {
			return "The latest parent response has no clean continuation point. Send a normal prompt first.";
		}
		return undefined;
	}

	async function waitForReadyCapsule(
		ctx: ExtensionCommandContext,
		initialCapsule: ParentCapsule | undefined,
		signal: AbortSignal,
		logger: BtwRunLogger,
	) {
		let capsule = initialCapsule;
		requireDiagnosticLog(logger, "cache_wait_started", { initialCaptureId: capsule?.captureId, agentRunning, idle: ctx.isIdle() });
		while (!signal.aborted) {
			const newest = pendingCapsule ?? latestCapsule;
			if (!capsule || (!capsule.readyAt && newest && newest !== capsule)) {
				requireDiagnosticLog(logger, "cache_capsule_retargeted", { fromCaptureId: capsule?.captureId, toCaptureId: newest?.captureId });
				capsule = newest;
			}
			if (capsule?.readyAt && Date.now() >= capsule.readyAt) {
				requireDiagnosticLog(logger, "cache_ready", {
					captureId: capsule.captureId,
					capturedAt: capsule.capturedAt,
					readyAt: capsule.readyAt,
					warmupMs: capsule.readyAt - capsule.capturedAt,
					parentCompleted: !!capsule.completedAt,
				});
				return capsule;
			}
			const waitingForProvider = currentProviderProblem === "Waiting for the parent provider request to start."
				|| currentProviderProblem === "The current parent request has not warmed its cache yet.";
			if ((!capsule || capsule !== pendingCapsule) && !newest && !waitingForProvider) {
				throw new CacheSafetyError(currentProviderProblem);
			}
			if (!capsule?.readyAt) {
				let idle: boolean;
				try {
					idle = ctx.isIdle();
				} catch {
					return undefined;
				}
				if (idle) throw new CacheSafetyError(currentProviderProblem || lastCaptureProblem);
			}
			if (!await abortableDelay(20, signal)) return undefined;
		}
		return undefined;
	}

	function createSideThread(capsule: ParentCapsule, includeParentResponse: boolean): SideThread {
		if (includeParentResponse && !capsule.response?.responseId) {
			throw new CacheSafetyError("The parent response has no continuation id.");
		}
		const baseMessages = cloneValue(capsule.contextMessages);
		if (includeParentResponse) baseMessages.push(cloneValue(capsule.response!));
		return {
			capsule,
			baseMessages,
			messages: [],
			transportSessionId: `${capsule.sessionId}:btw:${capsule.captureId}:${Date.now().toString(36)}`,
			requestSequence: 0,
		};
	}

	async function runSideTurn(
		question: string,
		thread: SideThread,
		overlay: BtwOverlay,
		logger: BtwRunLogger,
	) {
		const capsule = thread.capsule;
		const turnIndex = ++thread.requestSequence;
		const firstSuccessfulTurn = thread.messages.length === 0;
		const exactSidePrompt = firstSuccessfulTurn ? sidePrompt(question) : question;
		const agentMessages: AgentMessage[] = cloneValue([...thread.baseMessages, ...thread.messages]);
		const messages = convertToLlm(agentMessages);
		const sideMessage: UserMessage = {
			role: "user",
			content: [{ type: "text", text: exactSidePrompt }],
			timestamp: Date.now(),
		};
		messages.push(sideMessage);

		const instructions = typeof capsule.payload.instructions === "string" ? capsule.payload.instructions : undefined;
		if (!instructions) throw new CacheSafetyError("Parent Codex request has no instructions string.");
		const serviceTier = capsule.payload.service_tier;
		requireDiagnosticLog(logger, "side_context_built", {
			turnIndex,
			question,
			firstSuccessfulTurn,
			exactSidePrompt,
			agentMessageCount: agentMessages.length,
			agentMessageRoles: agentMessages.map((message) => message.role),
			llmMessageCount: messages.length,
			llmMessageRoles: messages.map((message) => message.role),
			instructionsBytes: Buffer.byteLength(instructions),
		});

		let payloadVerified = false;
		let toolCallAttempted = false;
		let timedOut = false;
		let firstEventAt: number | undefined;
		let firstTextAt: number | undefined;
		const markCapsuleConsumed = () => {
			if (capsule.consumedAt) return;
			const consumedAt = Date.now();
			requireDiagnosticLog(logger, "capsule_consumed", { captureId: capsule.captureId, consumedAt });
			capsule.consumedAt = consumedAt;
			lastCaptureProblem = "That parent cache prefix was already used by /btw. Wait for the next parent model request.";
		};
		const requestController = new AbortController();
		const abortRequest = () => requestController.abort();
		if (overlay.signal.aborted) requestController.abort();
		else overlay.signal.addEventListener("abort", abortRequest, { once: true });
		const timer = setTimeout(() => {
			timedOut = true;
			logger.write("side_timeout", { turnIndex, timeoutMs: SIDE_TIMEOUT_MS });
			requestController.abort();
		}, SIDE_TIMEOUT_MS);

		try {
			const auth = capsule.auth;
			requireDiagnosticLog(logger, "side_request_starting", {
				turnIndex,
				parentCompleted: !!capsule.completedAt,
				agentRunning,
				transport: "auto",
				cacheRetention: "short",
				transportSessionId: thread.transportSessionId,
				cacheSessionId: capsule.sessionId,
				promptCacheKey: promptCacheKey(capsule.payload),
				headerNames: Object.keys(auth.headers ?? {}),
				envNames: Object.keys(auth.env ?? {}),
			});

			const eventStream = streamSimple(
				capsule.model,
				{ systemPrompt: instructions, messages, tools: [] },
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					env: auth.env,
					signal: requestController.signal,
					// The side thread owns a separate WebSocket continuation while
					// cacheSessionId and the rewritten payload preserve parent affinity.
					transport: "auto",
					cacheRetention: "short",
					sessionId: thread.transportSessionId,
					cacheSessionId: capsule.sessionId,
					reasoning: capsule.thinkingLevel === "off" ? undefined : capsule.thinkingLevel,
					...(serviceTier === "auto" || serviceTier === "default" || serviceTier === "flex" || serviceTier === "priority"
						? { serviceTier }
						: {}),
					timeoutMs: SIDE_TIMEOUT_MS,
					maxRetries: 0,
					onPayload(candidatePayload) {
						if (requestController.signal.aborted) throw new Error("Request was aborted");
						const fork = buildCacheForkPayload(capsule.payload, candidatePayload, exactSidePrompt);
						const candidateRecord = candidatePayload as JsonRecord;
						const candidateInput = candidateRecord.input as unknown[];
						const { input: _candidateInput, ...candidateBody } = candidateRecord;
						requireDiagnosticLog(logger, "side_payload_verified", {
							turnIndex,
							// capsule_selected stores the exact parent payload. Together with
							// these fields it reconstructs both candidate and transmitted payloads.
							candidateBody,
							candidateSuffixInput: candidateInput.slice(fork.sharedInputItems),
							candidateDiagnostics: payloadDiagnostics(candidatePayload),
							forkDiagnostics: payloadDiagnostics(fork.payload),
							sharedInputItems: fork.sharedInputItems,
							suffixInputItems: fork.suffixInputItems,
						});
						payloadVerified = true;
						return fork.payload;
					},
					onResponse(response) {
						requireDiagnosticLog(logger, "side_provider_response", {
							turnIndex,
							status: response.status,
							headers: response.headers,
						});
						markCapsuleConsumed();
					},
				},
			);

			let streamedText = "";
			for await (const event of eventStream) {
				const now = Date.now();
				firstEventAt ??= now;
				try {
					markCapsuleConsumed();
					requireDiagnosticLog(logger, "side_stream_event", {
						turnIndex,
						streamEvent: streamEventForLog(event),
						parentCompleted: !!capsule.completedAt,
						agentRunning,
					});
				} catch (error) {
					requestController.abort();
					throw error;
				}
				if (requestController.signal.aborted) break;
				if (event.type === "text_delta") {
					firstTextAt ??= now;
					streamedText += event.delta;
					overlay.appendText(event.delta);
				} else if (event.type === "toolcall_start" || event.type === "toolcall_delta" || event.type === "toolcall_end") {
					toolCallAttempted = true;
					logger.write("side_tool_call_blocked", { turnIndex, streamEvent: streamEventForLog(event) });
					requestController.abort();
					break;
				}
			}

			const result = await eventStream.result();
			const resultText = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
			requireDiagnosticLog(logger, "side_result", {
				turnIndex,
				result,
				streamedTextBytes: Buffer.byteLength(streamedText),
				streamedTextMatchesResult: streamedText === resultText,
				payloadVerified,
				firstEventAt,
				firstTextAt,
				parentCompletedBeforeResult: !!capsule.completedAt,
				agentRunningAtResult: agentRunning,
			});
			if (requestController.signal.aborted) {
				if (toolCallAttempted) throw new Error("The side model attempted a tool call; no tool was executed.");
				if (timedOut) throw new Error("The /btw request timed out after 3 minutes.");
				logger.write("side_cancelled", { turnIndex, closedBy: overlay.closedBy });
				return;
			}
			if (!payloadVerified) throw new CacheSafetyError("Side payload was not verified before sending.");
			if (result.stopReason === "error" || result.stopReason === "aborted") {
				throw new Error(result.errorMessage || `Side request ${result.stopReason}.`);
			}
			const cacheExpected = (capsule.parentPromptTokens ?? capsule.roughSharedTokens) >= MIN_CACHEABLE_TOKENS;
			const cacheMiss = result.usage.cacheRead === 0;
			requireDiagnosticLog(logger, "side_complete", {
				turnIndex,
				usage: result.usage,
				cacheExpected,
				cacheMiss,
				cacheHitRatio: (result.usage.input + result.usage.cacheRead + result.usage.cacheWrite) > 0
					? result.usage.cacheRead / (result.usage.input + result.usage.cacheRead + result.usage.cacheWrite)
					: 0,
				sideHistoryMessages: thread.messages.length + 2,
				parentCompleted: !!capsule.completedAt,
				agentRunning,
			});
			thread.messages.push(cloneValue(sideMessage), cloneValue(result));
			overlay.setAnswer(resultText);
			overlay.setDone(result.usage, cacheMiss);
		} finally {
			clearTimeout(timer);
			overlay.signal.removeEventListener("abort", abortRequest);
			logger.write("side_request_finished", {
				turnIndex,
				parentCompleted: !!capsule.completedAt,
				agentRunning,
			});
		}
	}

	pi.on("session_start", () => {
		abortActive("session_start");
		resetCapture();
	});
	pi.on("session_shutdown", (event) => {
		abortActive(`session_shutdown:${event.reason}`);
		const loggers = new Set(parentRunLoggers);
		if (activeLogger) loggers.add(activeLogger);
		for (const logger of loggers) {
			logger.write("session_shutdown", { reason: event.reason, targetSessionFile: event.targetSessionFile });
		}
		parentRunLoggers.clear();
		activeController = undefined;
		activeOverlay = undefined;
		activeLogger = undefined;
		resetCapture();
	});
	pi.on("session_compact", () => {
		abortActive("session_compact");
		resetCapture("The session was compacted. Send a normal prompt to warm the new prefix.");
	});
	pi.on("session_tree", () => {
		abortActive("session_tree");
		resetCapture("The session branch changed. Send a normal prompt to warm that branch.");
	});
	pi.on("model_select", () => {
		abortActive("model_select");
		resetCapture("The model changed. Send a normal prompt to warm its cache.");
	});
	pi.on("thinking_level_select", () => {
		abortActive("thinking_level_select");
		resetCapture("The reasoning level changed. Send a normal prompt to warm its cache.");
	});

	pi.on("agent_start", () => {
		agentRunning = true;
		latestContextMessages = [];
		pendingCapsule = undefined;
		latestCapsule = undefined;
		recentCapsules = [];
		pendingParentAuth = undefined;
		currentProviderProblem = "Waiting for the parent provider request to start.";
	});
	pi.on("agent_end", (event, ctx) => {
		agentRunning = false;
		for (const logger of parentRunLoggers) {
			const capsule = [...recentCapsules].reverse().find((candidate) => candidate.runLogger === logger);
			const sharedContextMessages = capsule
				? sharedMessagePrefixLength(capsule.contextMessages, event.messages)
				: 0;
			logger.write("parent_agent_end", {
				messageCount: event.messages.length,
				sharedContextMessages,
				messagesAfterSharedContext: event.messages.slice(sharedContextMessages),
			});
			if (logger.lastError) {
				try {
					ctx.ui.notify(`/btw parent diagnostics became incomplete: ${logger.lastError.message}`, "error");
				} catch { }
			}
			if (capsule) capsule.runLogger = undefined;
		}
		parentRunLoggers.clear();
	});

	// This extension is named zz-btw so these snapshots run after the other
	// user extensions and reflect their final context/provider mutations.
	pi.on("context", (event) => {
		if (agentRunning) latestContextMessages = cloneValue(event.messages);
	});

	pi.on("before_provider_headers", async (event, ctx) => {
		pendingParentAuth = undefined;
		if (!agentRunning || !ctx.model || ctx.model.api !== SUPPORTED_API) return;
		const model = ctx.model;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!agentRunning || !ctx.model || modelKey(ctx.model) !== modelKey(model)) return;
		if (!auth.ok || !auth.apiKey) {
			currentProviderProblem = auth.ok ? `No API key for ${model.provider}.` : auth.error;
			lastCaptureProblem = currentProviderProblem;
			return;
		}
		// Keep the mutable object reference. Later header hooks finish mutating it
		// before before_provider_request snapshots the final parent request identity.
		pendingParentAuth = {
			modelKey: modelKey(model),
			apiKey: auth.apiKey,
			env: auth.env ? { ...auth.env } : undefined,
			headers: event.headers,
		};
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!agentRunning || !ctx.model) return;
		latestCapsule = undefined;
		pendingCapsule = undefined;
		const parentAuth = pendingParentAuth;
		pendingParentAuth = undefined;

		if (ctx.model.api !== SUPPORTED_API) {
			currentProviderProblem = `/btw cache for ${ctx.model.api} is not implemented; only ${SUPPORTED_API} is currently strict-tested.`;
			lastCaptureProblem = currentProviderProblem;
			return;
		}
		if (!parentAuth || parentAuth.modelKey !== modelKey(ctx.model)) {
			currentProviderProblem = "Pi did not expose the parent request credentials for an exact account fork.";
			lastCaptureProblem = currentProviderProblem;
			return;
		}
		if (!isRecord(event.payload) || !Array.isArray(event.payload.input)) {
			currentProviderProblem = "The parent provider payload is not a cache-forkable Responses request.";
			lastCaptureProblem = currentProviderProblem;
			return;
		}
		if (!promptCacheKey(event.payload)) {
			currentProviderProblem = "The parent provider request has no prompt_cache_key.";
			lastCaptureProblem = currentProviderProblem;
			return;
		}
		if (latestContextMessages.length === 0) {
			currentProviderProblem = "Pi did not expose a parent context snapshot for this provider request.";
			lastCaptureProblem = currentProviderProblem;
			return;
		}

		const payload = cloneValue(event.payload);
		const capsule: ParentCapsule = {
			captureId: ++captureSequence,
			capturedAt: Date.now(),
			payload,
			model: cloneValue(ctx.model as Model<Api>),
			thinkingLevel: pi.getThinkingLevel(),
			sessionId: ctx.sessionManager.getSessionId(),
			auth: {
				apiKey: parentAuth.apiKey,
				headers: { ...parentAuth.headers },
				env: parentAuth.env,
			},
			contextMessages: cloneValue(latestContextMessages),
			roughSharedTokens: roughSharedTokenEstimate(payload),
		};
		pendingCapsule = capsule;
		const retainedCapsules = recentCapsules.filter((candidate) => candidate.runLogger || !candidate.completedAt);
		recentCapsules = [...retainedCapsules.slice(-7), capsule];
		currentProviderProblem = "The current parent request has not warmed its cache yet.";
		lastCaptureProblem = currentProviderProblem;
	});

	pi.on("message_start", (event) => { associateAssistant(event.message); });
	pi.on("message_update", (event) => {
		const type = event.assistantMessageEvent.type;
		if (type === "text_delta" || type === "thinking_delta" || type === "toolcall_start" || type === "toolcall_delta" || type === "toolcall_end") {
			const capsule = capsuleForAssistant(event.message);
			const firstCacheSignal = !!capsule && !capsule.readyAt;
			markReady(event.message, cacheVisibilityReadyAt(Date.now()));
			if (firstCacheSignal) {
				activeLogger?.write("parent_cache_signal", {
					captureId: capsule.captureId,
					assistantMessageEvent: event.assistantMessageEvent,
					readyAt: capsule.readyAt,
					visibilityDelayMs: CACHE_VISIBILITY_DELAY_MS,
				});
			}
		}
	});
	pi.on("message_end", (event) => {
		const message = event.message;
		markReady(message);
		const capsule = capsuleForAssistant(message);
		if (!capsule || !assistantMatchesCapsule(message, capsule)) return;
		capsule.completedAt = Date.now();
		capsule.parentPromptTokens = promptTokens(message);
		if (message.stopReason === "stop") capsule.response = cloneValue(message);
		capsule.runLogger?.write("parent_message_end", {
			captureId: capsule.captureId,
			message,
			completedAt: capsule.completedAt,
			parentPromptTokens: capsule.parentPromptTokens,
		});
	});

	const btwCommand = {
		description: "Open an ephemeral side conversation using the parent prompt cache",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/btw currently requires Pi's TUI.", "warning");
				return;
			}
			const question = args.trim();
			if (!question) {
				ctx.ui.notify("Usage: /btw <side question>", "warning");
				return;
			}
			if (activeController) {
				ctx.ui.notify("A /btw question is already open.", "warning");
				return;
			}
			const sessionId = ctx.sessionManager.getSessionId();
			let logger: BtwRunLogger;
			try {
				logger = new BtwRunLogger(sessionId);
			} catch (error) {
				ctx.ui.notify(`Cannot create /btw diagnostic log: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			activeLogger = logger;
			const invokedWhileParentRunning = !ctx.isIdle();
			const initialCapsule = pendingCapsule ?? latestCapsule;
			const commandLogged = logger.write("command_received", {
				question,
				invokedWhileParentRunning,
				agentRunning,
				idle: ctx.isIdle(),
				cwd: ctx.cwd,
				sessionFile: ctx.sessionManager.getSessionFile(),
				model: ctx.model,
				thinkingLevel: pi.getThinkingLevel(),
				initialCaptureId: initialCapsule?.captureId,
				logPath: logger.path,
			});
			if (!commandLogged) {
				ctx.ui.notify(`Cannot write /btw diagnostic log: ${logger.lastError?.message ?? "unknown error"}`, "error");
				activeLogger = undefined;
				return;
			}

			if (!invokedWhileParentRunning) {
				const problem = capsuleProblem(ctx, latestCapsule, true);
				if (problem) {
					logger.write("command_rejected", { problem });
					ctx.ui.notify(problem, "warning");
					activeLogger = undefined;
					return;
				}
			}

			let overlayRef: BtwOverlay | undefined;
			let sideTurnTask: Promise<void> | undefined;
			let sideTransportSessionId: string | undefined;
			try {
				await ctx.ui.custom<void>(
					(tui, theme, _keybindings, done) => {
						let thread: SideThread | undefined;
						let overlay: BtwOverlay;
						const reportTurnError = (error: unknown) => {
							logger.write("side_error", {
								turnIndex: thread?.requestSequence,
								error: errorDiagnostics(error),
								overlayClosed: overlay.isClosed,
							});
							if (!overlay.isClosed) overlay.setError(error instanceof Error ? error.message : String(error));
						};
						overlay = new BtwOverlay(tui, theme, question, done, (followUp) => {
							if (!thread) {
								reportTurnError(new CacheSafetyError("The frozen side thread is unavailable."));
								return;
							}
							requireDiagnosticLog(logger, "followup_submitted", {
								question: followUp,
								successfulHistoryMessages: thread.messages.length,
								parentCompleted: !!thread.capsule.completedAt,
								agentRunning,
							});
							sideTurnTask = runSideTurn(followUp, thread, overlay, logger).catch(reportTurnError);
						});
						overlayRef = overlay;
						activeOverlay = overlay;
						activeController = overlay.controller;
						logger.write("overlay_opened", { invokedWhileParentRunning });
						if (invokedWhileParentRunning && !initialCapsule?.readyAt) overlay.setWaiting();
						sideTurnTask = (async () => {
							const capsule = invokedWhileParentRunning
								? await waitForReadyCapsule(ctx, initialCapsule, overlay.signal, logger)
								: latestCapsule;
							if (!capsule || overlay.signal.aborted) return;
							const includeParentResponse = !invokedWhileParentRunning;
							const problem = capsuleProblem(ctx, capsule, includeParentResponse);
							if (problem) throw new CacheSafetyError(problem);
							capsule.runLogger = logger;
							if (invokedWhileParentRunning && agentRunning) parentRunLoggers.add(logger);
							thread = createSideThread(capsule, includeParentResponse);
							sideTransportSessionId = thread.transportSessionId;
							requireDiagnosticLog(logger, "capsule_selected", {
								mode: includeParentResponse ? "completed-continuation" : "parallel-prefix-fork",
								captureId: capsule.captureId,
								capturedAt: capsule.capturedAt,
								readyAt: capsule.readyAt,
								completedAt: capsule.completedAt,
								consumedAt: capsule.consumedAt,
								model: capsule.model,
								thinkingLevel: capsule.thinkingLevel,
								roughSharedTokens: capsule.roughSharedTokens,
								parentPromptTokens: capsule.parentPromptTokens,
								promptCacheKey: promptCacheKey(capsule.payload),
								transportSessionId: thread.transportSessionId,
								headerNames: Object.keys(capsule.auth.headers ?? {}),
								envNames: Object.keys(capsule.auth.env ?? {}),
								payloadDiagnostics: payloadDiagnostics(capsule.payload),
								parentPayload: capsule.payload,
								contextMessages: capsule.contextMessages,
								parentResponse: capsule.response,
								agentRunning,
							});
							overlay.enableFollowUps();
							overlay.setStreaming();
							await runSideTurn(question, thread, overlay, logger);
						})().catch(reportTurnError);
						return overlay;
					},
					{
						overlay: true,
						overlayOptions: { anchor: "top-center", width: "92%", maxHeight: "85%", margin: 1 },
					},
				);
				await sideTurnTask;
				logger.write("overlay_closed", { closedBy: overlayRef?.closedBy });
			} catch (error) {
				logger.write("command_error", { error: errorDiagnostics(error) });
				throw error;
			} finally {
				const ownController = overlayRef?.controller;
				ownController?.abort();
				await sideTurnTask;
				if (sideTransportSessionId) {
					try {
						cleanupSessionResources(sideTransportSessionId);
						logger.write("side_transport_cleaned", { transportSessionId: sideTransportSessionId });
					} catch (error) {
						logger.write("side_transport_cleanup_error", { error: errorDiagnostics(error) });
					}
				}
				if (activeController === ownController) activeController = undefined;
				if (activeOverlay === overlayRef) activeOverlay = undefined;
				logger.write("command_handler_finished", {
					closedBy: overlayRef?.closedBy,
					agentRunning,
				});
				if (logger.lastError) {
					try {
						ctx.ui.notify(`/btw diagnostics became incomplete: ${logger.lastError.message}`, "error");
					} catch { }
				}
				if (activeLogger === logger) activeLogger = undefined;
			}
		},
	};

	pi.registerCommand("btw", btwCommand);
	pi.registerCommand("status", {
		description: "Alias for /btw status",
		handler: (_args, ctx) => btwCommand.handler("status and eta?", ctx),
	});
}

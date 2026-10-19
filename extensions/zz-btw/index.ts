import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	cleanupSessionResources,
	streamSimple,
	type Api,
	type ApiStreamSimpleFunction,
	type AssistantMessage,
	type FetchFunction,
	type AssistantMessageEvent,
	type Model,
	type ModelThinkingLevel,
	type UserMessage,
} from "@earendil-works/pi-ai/compat";
import {
	convertToLlm,
	copyToClipboard,
	getMarkdownTheme,
	sessionEntryToContextMessages,
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
	CACHE_FRESHNESS_MS,
	CacheSafetyError,
	buildCacheForkPayload,
	cacheFreshness,
	cloneValue,
	confirmedCacheProblem,
	confirmedParentCacheCoverage,
	exactParentPromptProblem,
	formatUsage,
	isRecord,
	promptCacheKey,
	roughSharedTokenEstimate,
	type CacheUsage,
	type JsonRecord,
} from "./cache.ts";
import { BtwRunLogger, errorDiagnostics, payloadDiagnostics } from "./log.ts";
import { codexWireModelId } from "../lib/codex-long-context.js";

const SUPPORTED_API = "openai-codex-responses";
const LUNA_MODEL_ID = "gpt-6-luna";
const SIDE_TIMEOUT_MS = 3 * 60 * 1_000;
const MAX_VISIBLE_ANSWER_LINES = 26;
const MAX_DIRECT_OSC52_ENCODED_LENGTH = 100_000;

type BtwDependencies = {
	now?: () => number;
	streamSimple?: ApiStreamSimpleFunction;
	fetch?: FetchFunction;
};

export function sideAffinityFetch(
	underlyingFetch: FetchFunction,
	parentSessionId: string,
	sideThreadId: string,
): FetchFunction {
	return ((input: Parameters<FetchFunction>[0], init?: Parameters<FetchFunction>[1]) => {
		const requestHeaders = input instanceof Request ? input.headers : undefined;
		const headers = new Headers(init?.headers ?? requestHeaders);
		headers.set("session-id", parentSessionId);
		headers.set("thread-id", sideThreadId);
		headers.set("x-client-request-id", sideThreadId);
		return underlyingFetch(input, { ...init, headers });
	}) as FetchFunction;
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

const LUNA_SIDE_MODE_PROMPT = `<system-reminder>
This is an ephemeral /btw-luna side conversation running independently from the main agent.

- The main agent continues independently; do not describe yourself as interrupting it.
- Use only the inherited conversation snapshot and this side thread.
- You have no tool access: never call, request, simulate, or promise to use a tool.
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

export type SideThreadMode = "completed-continuation" | "parallel-prefix-fork";

export function sideThreadModeForStopReason(stopReason: AssistantMessage["stopReason"]): SideThreadMode {
	return stopReason === "toolUse" ? "parallel-prefix-fork" : "completed-continuation";
}

export function parentCompletionProblem(
	mode: SideThreadMode,
	response: Pick<AssistantMessage, "stopReason" | "responseId">,
): string | undefined {
	if (mode === "completed-continuation" && (response.stopReason !== "stop" || !response.responseId)) {
		return "The completed parent response has no clean stop and continuation id. Send a normal prompt first.";
	}
	if (mode === "parallel-prefix-fork" && response.stopReason !== "toolUse") {
		return "A prefix-only /btw fork requires a completed parent tool-use response while its tools run.";
	}
	return undefined;
}

type SideThread = {
	capsule: ParentCapsule;
	mode: SideThreadMode;
	baseMessages: AgentMessage[];
	messages: Array<UserMessage | AssistantMessage>;
	transportSessionId: string;
	requestSequence: number;
	freshnessRequestStartedAt: number;
};

type LunaThread = {
	model: Model<Api>;
	systemPrompt: string;
	baseMessages: AgentMessage[];
	messages: Array<UserMessage | AssistantMessage>;
	transportSessionId: string;
	thinkingLevel: ModelThinkingLevel;
	auth: SideAuth;
};

export function withoutIncompleteToolExchange(messages: AgentMessage[]): AgentMessage[] {
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		const toolCallIds = message.content
			.filter((part) => part.type === "toolCall")
			.map((part) => part.id);
		if (toolCallIds.length === 0) continue;
		const resultIds = new Set(
			messages.slice(index + 1)
				.filter((candidate) => candidate.role === "toolResult")
				.map((candidate) => candidate.toolCallId),
		);
		if (toolCallIds.some((id) => !resultIds.has(id))) return cloneValue(messages.slice(0, index));
	}
	return cloneValue(messages);
}

type SideTurn = {
	question: string;
	answer: string;
	state: "loading" | "done" | "error";
	phase: "waiting" | "streaming";
	waitingReason: string;
	error: string;
	usage?: CacheUsage;
	cacheMiss: boolean;
	cacheWarning?: string;
};

// Append-only snapshots in the parent session JSONL. Custom entries are durable
// but excluded from model context, and move-session copies them with the session.
export const BTW_TURN_ENTRY_TYPE = "btw-turn";

type BtwTurnStatus = "submitted" | "completed" | "cancelled" | "error";

export type BtwTurnEntryData = {
	version: 1;
	runId: string;
	turnId: string;
	turnIndex: number;
	mode: "btw" | "btw-luna";
	question: string;
	status: BtwTurnStatus;
	createdAt: number;
	updatedAt: number;
	answer?: string;
	error?: string;
	reason?: string;
};

type SideTurnEvent = {
	status: BtwTurnStatus;
	turnIndex: number;
	question: string;
	answer: string;
	error?: string;
	reason?: string;
};

type SessionPersistenceInternals = {
	flushed?: boolean;
	_rewriteFile?: () => void;
};

function materializeDeferredSession(ctx: ExtensionCommandContext) {
	const sessionManager = ctx.sessionManager as unknown as SessionPersistenceInternals & {
		getSessionFile(): string | undefined;
	};
	if (sessionManager.flushed !== false || !sessionManager.getSessionFile()) return;
	if (typeof sessionManager._rewriteFile !== "function") {
		throw new Error("Pi cannot materialize the session file for /btw history.");
	}
	// Pi defers a new session's first write until an assistant message exists.
	// /btw has no parent assistant message, so make this custom entry durable now
	// and keep SessionManager's state consistent for the next normal append.
	sessionManager._rewriteFile();
	sessionManager.flushed = true;
}

type RenderedSideTurn = {
	width: number;
	index: number;
	answer: string;
	state: SideTurn["state"];
	phase: SideTurn["phase"];
	waitingReason: string;
	error: string;
	usage?: CacheUsage;
	cacheMiss: boolean;
	cacheWarning?: string;
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
	private threadStoppedReason?: string;
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
		private readonly label = "/btw",
		private readonly onTurnEvent?: (event: SideTurnEvent) => void,
	) {
		this.turns = [{ question, answer: "", state: "loading", phase: "waiting", waitingReason: "Waiting for a cache-eligible parent request.", error: "", cacheMiss: false }];
		this.input.onSubmit = (value) => this.submitFollowUp(value);
		this.input.onEscape = () => this.close("input-cancel");
		this.emitTurnEvent("submitted", 0);
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

	webState() {
		return { label: this.label, turns: structuredClone(this.turns), canSend: this.canAcceptInput(), stoppedReason: this.threadStoppedReason };
	}

	webSend(text: string) {
		if (!this.canAcceptInput()) throw new Error("BTW is still responding or its cached thread has expired");
		this.submitFollowUp(text);
	}

	get isLoading() {
		return this.activeTurn().state === "loading";
	}

	enableFollowUps() {
		this.followUpsEnabled = true;
		this.input.focused = this._focused && this.canAcceptInput();
		this.tui.requestRender();
	}

	stopThread(reason: string) {
		this.followUpsEnabled = false;
		this.threadStoppedReason = reason;
		this.input.focused = false;
		this.tui.requestRender();
	}

	setWaiting(reason = "Waiting for a cache-eligible parent request.") {
		const turn = this.activeTurn();
		turn.phase = "waiting";
		turn.waitingReason = reason;
		this.tui.requestRender();
	}

	setStreaming() {
		const turn = this.activeTurn();
		turn.phase = "streaming";
		turn.waitingReason = "";
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

	setDone(usage: CacheUsage, cacheWarning?: string | boolean) {
		const turn = this.activeTurn();
		turn.state = "done";
		turn.usage = usage;
		turn.cacheMiss = !!cacheWarning;
		turn.cacheWarning = typeof cacheWarning === "string"
			? cacheWarning
			: cacheWarning ? "The provider reported poor parent cache coverage." : undefined;
		this.emitTurnEvent("completed", this.turns.length - 1);
		this.input.focused = this._focused && this.canAcceptInput();
		this.tui.requestRender();
	}

	setError(message: string) {
		const turn = this.activeTurn();
		turn.state = "error";
		turn.error = message;
		this.emitTurnEvent("error", this.turns.length - 1, message);
		this.input.focused = this._focused && this.canAcceptInput();
		this.tui.requestRender();
	}

	close(reason = "programmatic") {
		if (this.closed) return;
		if (this.activeTurn().state === "loading") {
			this.emitTurnEvent("cancelled", this.turns.length - 1, undefined, reason);
		}
		this.closed = true;
		this.closeReason = reason;
		this.input.focused = false;
		this.controller.abort();
		this.done();
	}

	private activeTurn() {
		return this.turns[this.turns.length - 1]!;
	}

	private emitTurnEvent(status: BtwTurnStatus, turnIndex: number, error?: string, reason?: string) {
		const turn = this.turns[turnIndex]!;
		this.onTurnEvent?.({
			status,
			turnIndex,
			question: turn.question,
			answer: turn.answer,
			error,
			reason,
		});
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
		this.copyNotice = { text: `Copying whole ${this.label} conversation…`, color: "dim" };
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
		this.turns.push({ question, answer: "", state: "loading", phase: "streaming", waitingReason: "", error: "", cacheMiss: false });
		this.emitTurnEvent("submitted", this.turns.length - 1);
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
			&& cached.waitingReason === turn.waitingReason
			&& cached.error === turn.error
			&& cached.usage === turn.usage
			&& cached.cacheMiss === turn.cacheMiss
			&& cached.cacheWarning === turn.cacheWarning) {
			return cached.lines;
		}
		const lines = [this.theme.fg("muted", truncateToWidth(`Q${index + 1}: ${cleanOneLine(turn.question)}`, innerWidth, "…"))];
		if (turn.state === "error") {
			lines.push(...new Markdown(turn.error || "Unknown /btw error.", 0, 0, getMarkdownTheme()).render(innerWidth));
		} else if (turn.answer) {
			lines.push(...new Markdown(turn.answer, 0, 0, getMarkdownTheme()).render(innerWidth));
		} else {
			const text = turn.state === "loading"
				? turn.phase === "waiting" ? turn.waitingReason : "Thinking…"
				: "(no text response)";
			lines.push(this.theme.fg("dim", text));
		}
		if (turn.state === "done" && turn.usage) {
			const telemetry = formatUsage(turn.usage);
			const cacheWarning = turn.cacheWarning && turn.usage.cacheRead > 0 ? ` · ${turn.cacheWarning}` : "";
			lines.push(turn.cacheMiss || turn.usage.cacheWrite > 0
				? this.theme.fg("warning", `⚠ ${telemetry}${cacheWarning} · cache reuse not guaranteed`)
				: this.theme.fg("dim", telemetry));
		}
		this.turnRenderCache.set(turn, {
			width: innerWidth,
			index,
			answer: turn.answer,
			state: turn.state,
			phase: turn.phase,
			waitingReason: turn.waitingReason,
			error: turn.error,
			usage: turn.usage,
			cacheMiss: turn.cacheMiss,
			cacheWarning: turn.cacheWarning,
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
		const title = ` ${this.label} `;
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
			const turn = this.activeTurn();
			const activity = turn.phase === "waiting" ? turn.waitingReason : "Streaming in parallel";
			const notice = this.copyNotice;
			lines.push(row(this.theme.fg(
				notice?.color ?? "dim",
				notice?.text ?? `${activity} · Ctrl+X copies all · Esc closes`,
			)));
		} else if (!this.followUpsEnabled) {
			const notice = this.copyNotice;
			lines.push(row(this.theme.fg(
				notice?.color ?? "error",
				notice?.text ?? `${this.threadStoppedReason ?? "Side thread unavailable"} · Ctrl+X copies all · Esc closes`,
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

type WaitableParent = { completedAt?: number };

type ParentEligibility =
	| { status: "ready" }
	| { status: "wait"; reason: string }
	| { status: "blocked"; reason: string };

type ParentWaitOptions<T extends WaitableParent> = {
	now?: () => number;
	delay?: (ms: number, signal: AbortSignal) => Promise<boolean>;
	evaluate?: (capsule: T | undefined) => ParentEligibility;
	blockingProblem?: (capsule: T | undefined) => string | undefined;
	onRetarget?: (previous: T | undefined, next: T) => void;
	onWaiting?: (reason: string, capsule: T | undefined) => void;
};

export async function waitForCompletedParent<T extends WaitableParent>(
	initialCapsule: T | undefined,
	getNewestCapsule: () => T | undefined,
	signal: AbortSignal,
	options: ParentWaitOptions<T> = {},
): Promise<T | undefined> {
	const now = options.now ?? Date.now;
	const delay = options.delay ?? abortableDelay;
	let capsule = initialCapsule;
	let lastWaitingReason: string | undefined;
	while (!signal.aborted) {
		const newest = getNewestCapsule();
		if (newest && newest !== capsule) {
			options.onRetarget?.(capsule, newest);
			capsule = newest;
		}
		const eligibility = options.evaluate?.(capsule);
		if (eligibility?.status === "ready") return capsule;
		if (eligibility?.status === "blocked") throw new CacheSafetyError(eligibility.reason);
		if (!eligibility && capsule?.completedAt !== undefined) return capsule;
		const problem = options.blockingProblem?.(capsule);
		if (problem) throw new CacheSafetyError(problem);
		const waitingReason = eligibility?.status === "wait" ? eligibility.reason : "Waiting for the parent response to complete.";
		if (waitingReason !== lastWaitingReason) {
			lastWaitingReason = waitingReason;
			options.onWaiting?.(waitingReason, capsule);
		}
		if (!await delay(20, signal)) return undefined;
	}
	return undefined;
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

export default function (pi: ExtensionAPI, dependencies: BtwDependencies = {}) {
	const now = dependencies.now ?? Date.now;
	const runStreamSimple = dependencies.streamSimple ?? streamSimple;
	const underlyingFetch = dependencies.fetch ?? globalThis.fetch;
	let agentRunning = false;
	let latestContextMessages: AgentMessage[] = [];
	let pendingCapsule: ParentCapsule | undefined;
	let latestCapsule: ParentCapsule | undefined;
	let recentCapsules: ParentCapsule[] = [];
	let pendingParentAuth: PendingParentAuth | undefined;
	let lastCaptureProblem = "No cache-ready parent request yet. Waiting for a normal parent request.";
	let currentProviderProblem = "Waiting for the parent provider request to start.";
	let currentProviderBlocked = false;
	let activeController: AbortController | undefined;
	let activeOverlay: BtwOverlay | undefined;
	let activeKind: "cache" | "luna-auth" | "luna" | undefined;
	let activeLogger: BtwRunLogger | undefined;
	let activePersistence: ReturnType<typeof createTurnPersistence> | undefined;
	const parentRunLoggers = new Set<BtwRunLogger>();
	let captureSequence = 0;
	let runtimeActive = false;
	let activeSessionId: string | undefined;
	let bindingGeneration = 0;

	function createTurnPersistence(
		ctx: ExtensionCommandContext,
		mode: BtwTurnEntryData["mode"],
		initialQuestion: string,
	) {
		const sessionId = ctx.sessionManager.getSessionId();
		if (!runtimeActive && activeSessionId === undefined) {
			// Commands only run after session_start in Pi. This fallback keeps the
			// extension usable in lightweight SDK and test harnesses.
			runtimeActive = true;
			activeSessionId = sessionId;
		}
		const generation = bindingGeneration;
		const runId = randomUUID();
		const turns = new Map<number, { turnId: string; question: string; createdAt: number; terminal: boolean }>();
		let persistenceErrorReported = false;

		const append = (data: BtwTurnEntryData) => {
			if (!runtimeActive
				|| generation !== bindingGeneration
				|| activeSessionId !== sessionId
				|| ctx.sessionManager.getSessionId() !== sessionId) return false;
			try {
				pi.appendEntry<BtwTurnEntryData>(BTW_TURN_ENTRY_TYPE, data);
				materializeDeferredSession(ctx);
				return true;
			} catch (error) {
				if (!persistenceErrorReported) {
					persistenceErrorReported = true;
					try {
						ctx.ui.notify(`Could not persist /${mode} history: ${error instanceof Error ? error.message : String(error)}`, "error");
					} catch {}
				}
				return false;
			}
		};

		const submitted = (turnIndex: number, question: string) => {
			if (turns.has(turnIndex)) return;
			const createdAt = now();
			const turn = { turnId: randomUUID(), question, createdAt, terminal: false };
			turns.set(turnIndex, turn);
			append({
				version: 1,
				runId,
				turnId: turn.turnId,
				turnIndex,
				mode,
				question,
				status: "submitted",
				createdAt,
				updatedAt: createdAt,
			});
		};

		const terminal = (event: SideTurnEvent) => {
			submitted(event.turnIndex, event.question);
			const turn = turns.get(event.turnIndex)!;
			if (turn.terminal) return;
			turn.terminal = true;
			append({
				version: 1,
				runId,
				turnId: turn.turnId,
				turnIndex: event.turnIndex,
				mode,
				question: turn.question,
				status: event.status,
				createdAt: turn.createdAt,
				updatedAt: now(),
				answer: event.answer,
				...(event.error ? { error: event.error } : {}),
				...(event.reason ? { reason: event.reason } : {}),
			});
		};

		const onTurnEvent = (event: SideTurnEvent) => {
			if (event.status === "submitted") submitted(event.turnIndex, event.question);
			else terminal(event);
		};

		submitted(0, initialQuestion);
		return {
			onTurnEvent,
			errorPending(error: string) {
				for (const [turnIndex, turn] of turns) {
					if (!turn.terminal) terminal({ status: "error", turnIndex, question: turn.question, answer: "", error });
				}
			},
			cancelPending(reason: string) {
				for (const [turnIndex, turn] of turns) {
					if (!turn.terminal) terminal({ status: "cancelled", turnIndex, question: turn.question, answer: "", reason });
				}
			},
		};
	}

	function resetCapture(message = "No cache-ready parent request yet. Waiting for a normal parent request.") {
		latestContextMessages = [];
		pendingCapsule = undefined;
		latestCapsule = undefined;
		recentCapsules = [];
		pendingParentAuth = undefined;
		lastCaptureProblem = message;
		currentProviderProblem = message;
		currentProviderBlocked = false;
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
		const controller = activeController;
		activeLogger?.write("lifecycle_abort", { reason });
		activeOverlay?.close(reason);
		activePersistence?.cancelPending(reason);
		controller?.abort();
		if (activeKind === "luna-auth" && activeController === controller) {
			activeController = undefined;
			activeKind = undefined;
		}
	}

	function associateAssistant(message: AgentMessage) {
		const capsule = capsuleForAssistant(message);
		if (!capsule || !assistantMatchesCapsule(message, capsule)) return undefined;
		if (message.responseId) capsule.responseId = message.responseId;
		if (capsule === pendingCapsule || !pendingCapsule) latestCapsule = capsule;
		return capsule;
	}

	function freshnessEligibility(requestStartedAt: number): ParentEligibility {
		const freshness = cacheFreshness(requestStartedAt, now());
		if (freshness.ok) return { status: "ready" };
		return "reason" in freshness && freshness.reason === "future"
			? { status: "blocked", reason: "The request timestamp is in the future; /btw refused the unsafe fork." }
			: {
				status: "wait",
				reason: `The request reached the ${CACHE_FRESHNESS_MS / 1_000}s limit for cache freshness measured from request start. Waiting for a new parent request.`,
			};
	}

	function capsuleEligibility(
		ctx: ExtensionContext,
		capsule: ParentCapsule | undefined,
		freshnessRequestStartedAt: number,
		firstUse: boolean,
	): ParentEligibility {
		if (!ctx.model) return { status: "blocked", reason: "No active model is selected." };
		if (ctx.model.api !== SUPPORTED_API) {
			return {
				status: "blocked",
				reason: `/btw cache for ${ctx.model.api} is not implemented; only ${SUPPORTED_API} is currently strict-tested.`,
			};
		}
		if (!capsule) {
			return currentProviderBlocked
				? { status: "blocked", reason: currentProviderProblem }
				: { status: "wait", reason: currentProviderProblem || lastCaptureProblem };
		}
		if (currentProviderBlocked && capsule !== pendingCapsule && capsule !== latestCapsule) {
			return { status: "blocked", reason: currentProviderProblem };
		}
		if (modelKey(ctx.model) !== modelKey(capsule.model)) {
			return { status: "blocked", reason: "The active model differs from the captured parent request." };
		}
		if (pi.getThinkingLevel() !== capsule.thinkingLevel) {
			return { status: "blocked", reason: "The active reasoning level differs from the captured parent request." };
		}
		if (ctx.sessionManager.getSessionId() !== capsule.sessionId) {
			return { status: "blocked", reason: "The active session differs from the captured parent request." };
		}
		const toolProblem = toolSafetyProblem(capsule.payload);
		if (toolProblem) return { status: "blocked", reason: toolProblem };
		if (typeof capsule.payload.instructions !== "string") {
			return { status: "blocked", reason: "The parent Codex request has no instructions string." };
		}
		const freshness = freshnessEligibility(freshnessRequestStartedAt);
		if (freshness.status !== "ready") return freshness;
		if (!firstUse) return { status: "ready" };
		if (capsule.completedAt === undefined || !capsule.response) {
			return { status: "wait", reason: currentProviderProblem || "Waiting for the parent response to complete." };
		}
		if (capsule.consumedAt) {
			return { status: "wait", reason: "That parent cache prefix was already used by /btw. Waiting for the next parent request." };
		}
		const parentPromptTokens = capsule.parentPromptTokens ?? 0;
		const exactTokenProblem = exactParentPromptProblem(parentPromptTokens);
		if (exactTokenProblem) return { status: "wait", reason: `${exactTokenProblem} Waiting for a larger parent request.` };
		const completionProblem = parentCompletionProblem(modeForCapsule(capsule), capsule.response);
		if (completionProblem) return { status: "wait", reason: `${completionProblem} Waiting for a clean parent completion.` };
		return { status: "ready" };
	}

	async function waitForReadyCapsule(
		ctx: ExtensionCommandContext,
		initialCapsule: ParentCapsule | undefined,
		signal: AbortSignal,
		logger: BtwRunLogger,
		overlay: BtwOverlay,
	) {
		requireDiagnosticLog(logger, "cache_wait_started", { initialCaptureId: initialCapsule?.captureId, agentRunning, idle: ctx.isIdle() });
		const capsule = await waitForCompletedParent(
			initialCapsule,
			() => pendingCapsule ?? latestCapsule,
			signal,
			{
				evaluate: (candidate) => capsuleEligibility(ctx, candidate, candidate?.capturedAt ?? Number.NaN, true),
				onRetarget(previous, next) {
					requireDiagnosticLog(logger, "cache_capsule_retargeted", {
						fromCaptureId: previous?.captureId,
						toCaptureId: next.captureId,
					});
				},
				onWaiting(reason, candidate) {
					requireDiagnosticLog(logger, "cache_wait_reason", { captureId: candidate?.captureId, reason });
					if (!overlay.signal.aborted) overlay.setWaiting(reason);
				},
			},
		);
		if (capsule) {
			requireDiagnosticLog(logger, "cache_ready", {
				captureId: capsule.captureId,
				capturedAt: capsule.capturedAt,
				completedAt: capsule.completedAt,
				requestDurationMs: (capsule.completedAt ?? capsule.capturedAt) - capsule.capturedAt,
				parentCompleted: true,
			});
		}
		return capsule;
	}

	function modeForCapsule(capsule: ParentCapsule): SideThreadMode {
		return sideThreadModeForStopReason(capsule.response?.stopReason ?? "error");
	}

	function createSideThread(capsule: ParentCapsule, mode: SideThreadMode): SideThread {
		if (mode === "completed-continuation" && !capsule.response?.responseId) {
			throw new CacheSafetyError("The parent response has no continuation id.");
		}
		const baseMessages = cloneValue(capsule.contextMessages);
		if (mode === "completed-continuation") baseMessages.push(cloneValue(capsule.response!));
		return {
			capsule,
			mode,
			baseMessages,
			messages: [],
			transportSessionId: `${capsule.sessionId}:btw:${randomUUID()}`,
			requestSequence: 0,
			freshnessRequestStartedAt: capsule.capturedAt,
		};
	}

	async function runSideTurn(
		question: string,
		thread: SideThread,
		overlay: BtwOverlay,
		logger: BtwRunLogger,
		ctx: ExtensionCommandContext,
		allowParentRetarget = false,
	): Promise<"completed" | "cancelled" | "retry-parent" | "stopped"> {
		const capsule = thread.capsule;
		const turnIndex = ++thread.requestSequence;
		const firstSuccessfulTurn = thread.messages.length === 0;
		const deferUnsentTurn = (reason: string): "retry-parent" | "stopped" => {
			if (allowParentRetarget) {
				requireDiagnosticLog(logger, "side_dispatch_deferred", { turnIndex, captureId: capsule.captureId, reason });
				overlay.setWaiting(reason);
				return "retry-parent";
			}
			const message = `Follow-up was not sent: ${reason} The frozen side conversation cannot be safely rebased onto a different parent; close it and submit a new /btw question.`;
			overlay.setError(message);
			overlay.stopThread("Side thread stopped without rebasing the follow-up.");
			return "stopped";
		};
		const admission = capsuleEligibility(ctx, capsule, thread.freshnessRequestStartedAt, firstSuccessfulTurn);
		if (admission.status === "wait") return deferUnsentTurn(admission.reason);
		if (admission.status === "blocked") {
			overlay.stopThread(`Side thread stopped: ${admission.reason}`);
			throw new CacheSafetyError(admission.reason);
		}
		const exactSidePrompt = firstSuccessfulTurn ? sidePrompt(question) : question;
		const agentMessages: AgentMessage[] = cloneValue([...thread.baseMessages, ...thread.messages]);
		const messages = convertToLlm(agentMessages);
		const sideMessage: UserMessage = {
			role: "user",
			content: [{ type: "text", text: exactSidePrompt }],
			timestamp: now(),
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
		let dispatchWaitReason: string | undefined;
		let toolCallAttempted = false;
		let timedOut = false;
		let firstEventAt: number | undefined;
		let firstTextAt: number | undefined;
		const markCapsuleConsumed = () => {
			if (capsule.consumedAt) return;
			const consumedAt = now();
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
		const requestStartedAt = now();

		try {
			const auth = capsule.auth;
			requireDiagnosticLog(logger, "side_request_starting", {
				turnIndex,
				parentCompleted: !!capsule.completedAt,
				agentRunning,
				transport: "sse",
				cacheRetention: "short",
				transportSessionId: thread.transportSessionId,
				promptCacheKey: promptCacheKey(capsule.payload),
				headerNames: Object.keys(auth.headers ?? {}),
				envNames: Object.keys(auth.env ?? {}),
			});

			const eventStream = runStreamSimple(
				capsule.model,
				{ systemPrompt: instructions, messages, tools: [] },
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					env: auth.env,
					fetch: sideAffinityFetch(underlyingFetch, capsule.sessionId, thread.transportSessionId),
					signal: requestController.signal,
					transport: "sse",
					cacheRetention: "short",
					sessionId: thread.transportSessionId,
					toolChoice: "none",
					reasoning: capsule.thinkingLevel === "off" ? undefined : capsule.thinkingLevel,
					...(serviceTier === "auto" || serviceTier === "default" || serviceTier === "flex" || serviceTier === "priority"
						? { serviceTier }
						: {}),
					timeoutMs: SIDE_TIMEOUT_MS,
					maxRetries: 0,
					onPayload(candidatePayload) {
						if (requestController.signal.aborted) throw new Error("Request was aborted");
						const newest = pendingCapsule ?? latestCapsule;
						if (allowParentRetarget && newest && newest !== capsule) {
							dispatchWaitReason = "A newer parent request is available. Waiting for its strict cache checks to pass.";
							throw new CacheSafetyError(dispatchWaitReason);
						}
						const dispatchAdmission = capsuleEligibility(ctx, capsule, thread.freshnessRequestStartedAt, firstSuccessfulTurn);
						if (dispatchAdmission.status === "wait") {
							dispatchWaitReason = dispatchAdmission.reason;
							throw new CacheSafetyError(dispatchAdmission.reason);
						}
						if (dispatchAdmission.status === "blocked") {
							overlay.stopThread(`Side thread stopped: ${dispatchAdmission.reason}`);
							throw new CacheSafetyError(`Side request blocked during dispatch: ${dispatchAdmission.reason}`);
						}
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
				const eventAt = now();
				firstEventAt ??= eventAt;
				try {
					if (!dispatchWaitReason) markCapsuleConsumed();
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
					firstTextAt ??= eventAt;
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
			if (dispatchWaitReason && !payloadVerified && !capsule.consumedAt) return deferUnsentTurn(dispatchWaitReason);
			if (requestController.signal.aborted) {
				if (toolCallAttempted) throw new Error("The side model attempted a tool call; no tool was executed.");
				if (timedOut) throw new Error("The /btw request timed out after 3 minutes.");
				logger.write("side_cancelled", { turnIndex, closedBy: overlay.closedBy });
				return "cancelled";
			}
			if (!payloadVerified) throw new CacheSafetyError("Side payload was not verified before sending.");
			if (result.stopReason === "error" || result.stopReason === "aborted") {
				throw new Error(result.errorMessage || `Side request ${result.stopReason}.`);
			}
			const parentPromptTokens = capsule.parentPromptTokens ?? 0;
			const cacheProblem = confirmedCacheProblem(parentPromptTokens, result.usage.cacheRead);
			const cacheCoverage = confirmedParentCacheCoverage(parentPromptTokens, result.usage.cacheRead);
			const cacheWarning = cacheProblem
				? result.usage.cacheRead === 0
					? "cache MISS"
					: `poor parent cache coverage: ${(cacheCoverage * 100).toFixed(2)}%`
				: undefined;
			requireDiagnosticLog(logger, "side_complete", {
				turnIndex,
				usage: result.usage,
				parentPromptTokens,
				cacheProblem,
				cacheWarning,
				cacheMiss: result.usage.cacheRead === 0,
				confirmedParentCacheCoverage: cacheCoverage,
				sideHistoryMessages: thread.messages.length + 2,
				parentCompleted: true,
				agentRunning,
				requestStartedAt,
			});
			overlay.setAnswer(resultText);
			overlay.setDone(result.usage, cacheWarning);
			thread.messages.push(cloneValue(sideMessage), cloneValue(result));
			thread.freshnessRequestStartedAt = requestStartedAt;
			const followUpFreshness = cacheFreshness(thread.freshnessRequestStartedAt, now());
			if (!followUpFreshness.ok) {
				overlay.stopThread(`Side thread stopped: the successful request is already ${CACHE_FRESHNESS_MS / 1_000}s old from request start.`);
				return "completed";
			}
			overlay.enableFollowUps();
			return "completed";
		} catch (error) {
			if (dispatchWaitReason && !payloadVerified && !capsule.consumedAt && !overlay.signal.aborted) {
				return deferUnsentTurn(dispatchWaitReason);
			}
			throw error;
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

	function lunaSnapshot(ctx: ExtensionCommandContext) {
		const messages = agentRunning && latestContextMessages.length > 0
			? latestContextMessages
			: ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages);
		return withoutIncompleteToolExchange(messages);
	}

	async function runLunaTurn(
		question: string,
		thread: LunaThread,
		overlay: BtwOverlay,
	): Promise<void> {
		const agentMessages: AgentMessage[] = cloneValue([...thread.baseMessages, ...thread.messages]);
		const messages = convertToLlm(agentMessages);
		const sideMessage: UserMessage = {
			role: "user",
			content: [{ type: "text", text: question }],
			timestamp: now(),
		};
		messages.push(sideMessage);

		let timedOut = false;
		let toolCallAttempted = false;
		const requestController = new AbortController();
		const abortRequest = () => requestController.abort();
		if (overlay.signal.aborted) requestController.abort();
		else overlay.signal.addEventListener("abort", abortRequest, { once: true });
		const timer = setTimeout(() => {
			timedOut = true;
			requestController.abort();
		}, SIDE_TIMEOUT_MS);

		try {
			const eventStream = runStreamSimple(
				thread.model,
				{ systemPrompt: thread.systemPrompt, messages, tools: [] },
				{
					apiKey: thread.auth.apiKey,
					headers: thread.auth.headers,
					env: thread.auth.env,
					signal: requestController.signal,
					transport: "auto",
					cacheRetention: "short",
					sessionId: thread.transportSessionId,
					reasoning: thread.thinkingLevel === "off" ? undefined : thread.thinkingLevel,
					timeoutMs: SIDE_TIMEOUT_MS,
					maxRetries: 0,
				},
			);

			let streamedText = "";
			for await (const event of eventStream) {
				if (requestController.signal.aborted) break;
				if (event.type === "text_delta") {
					streamedText += event.delta;
					overlay.appendText(event.delta);
				} else if (event.type === "toolcall_start" || event.type === "toolcall_delta" || event.type === "toolcall_end") {
					toolCallAttempted = true;
					requestController.abort();
					break;
				}
			}

			const result = await eventStream.result();
			if (requestController.signal.aborted) {
				if (toolCallAttempted) throw new Error("Luna attempted a tool call; no tool was executed.");
				if (timedOut) throw new Error("The /btw-luna request timed out after 3 minutes.");
				return;
			}
			if (result.stopReason === "error" || result.stopReason === "aborted") {
				throw new Error(result.errorMessage || `Luna side request ${result.stopReason}.`);
			}
			const resultText = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
			overlay.setAnswer(resultText || streamedText);
			overlay.setDone(result.usage);
			thread.messages.push(cloneValue(sideMessage), cloneValue(result));
			overlay.enableFollowUps();
		} finally {
			clearTimeout(timer);
			overlay.signal.removeEventListener("abort", abortRequest);
		}
	}

	pi.on("session_start", (_event, ctx) => {
		// Invalidate old async closures before touching the newly bound session.
		runtimeActive = false;
		activeSessionId = undefined;
		bindingGeneration++;
		abortActive("session_start");
		activePersistence = undefined;
		runtimeActive = true;
		activeSessionId = ctx.sessionManager.getSessionId();
		resetCapture();
	});
	pi.on("session_shutdown", (event) => {
		// appendEntry is still bound to the old session during this hook.
		abortActive(`session_shutdown:${event.reason}`);
		const loggers = new Set(parentRunLoggers);
		if (activeLogger) loggers.add(activeLogger);
		for (const logger of loggers) {
			logger.write("session_shutdown", { reason: event.reason, targetSessionFile: event.targetSessionFile });
		}
		parentRunLoggers.clear();
		runtimeActive = false;
		activeSessionId = undefined;
		bindingGeneration++;
		activeController = undefined;
		activeOverlay = undefined;
		activeKind = undefined;
		activeLogger = undefined;
		activePersistence = undefined;
		resetCapture();
	});
	pi.on("session_compact", () => {
		abortActive("session_compact");
		activePersistence = undefined;
		resetCapture("The session was compacted. Send a normal prompt to warm the new prefix.");
	});
	pi.on("session_before_tree", () => {
		// This is the last point where cancellation belongs to the old branch.
		abortActive("session_before_tree");
		bindingGeneration++;
		activePersistence = undefined;
	});
	pi.on("session_tree", (_event, ctx) => {
		// Also invalidate first for hosts that emit only the post-navigation event.
		bindingGeneration++;
		activePersistence = undefined;
		abortActive("session_tree");
		runtimeActive = true;
		activeSessionId = ctx.sessionManager.getSessionId();
		resetCapture("The session branch changed. Send a normal prompt to warm that branch.");
	});
	pi.on("model_select", () => {
		if (activeKind !== "luna") {
			abortActive("model_select");
			activePersistence = undefined;
		}
		resetCapture("The model changed. Send a normal prompt to warm its cache.");
	});
	pi.on("thinking_level_select", () => {
		if (activeKind !== "luna") {
			abortActive("thinking_level_select");
			activePersistence = undefined;
		}
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
		currentProviderBlocked = false;
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
				} catch {}
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
		if ("error" in auth) {
			currentProviderProblem = auth.error;
			lastCaptureProblem = currentProviderProblem;
			currentProviderBlocked = true;
			return;
		}
		if (!auth.apiKey) {
			currentProviderProblem = `No API key for ${model.provider}.`;
			lastCaptureProblem = currentProviderProblem;
			currentProviderBlocked = true;
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
			currentProviderBlocked = true;
			return;
		}
		if (!parentAuth || parentAuth.modelKey !== modelKey(ctx.model)) {
			currentProviderProblem = "Pi did not expose the parent request credentials for an exact account fork.";
			lastCaptureProblem = currentProviderProblem;
			currentProviderBlocked = true;
			return;
		}
		if (!isRecord(event.payload) || !Array.isArray(event.payload.input)) {
			currentProviderProblem = "The parent provider payload is not a cache-forkable Responses request.";
			lastCaptureProblem = currentProviderProblem;
			currentProviderBlocked = true;
			return;
		}
		if (!promptCacheKey(event.payload)) {
			currentProviderProblem = "The parent provider request has no prompt_cache_key.";
			lastCaptureProblem = currentProviderProblem;
			currentProviderBlocked = true;
			return;
		}
		if (latestContextMessages.length === 0) {
			currentProviderProblem = "Pi did not expose a parent context snapshot for this provider request.";
			lastCaptureProblem = currentProviderProblem;
			currentProviderBlocked = true;
			return;
		}

		const payload = cloneValue(event.payload);
		const capsule: ParentCapsule = {
			captureId: ++captureSequence,
			capturedAt: now(),
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
		currentProviderProblem = "Waiting for the current parent response to complete.";
		lastCaptureProblem = currentProviderProblem;
		currentProviderBlocked = false;
	});

	pi.on("message_start", (event) => { associateAssistant(event.message); });
	pi.on("message_end", (event) => {
		const message = event.message;
		const capsule = associateAssistant(message);
		if (!capsule || !assistantMatchesCapsule(message, capsule)) return;
		capsule.completedAt = now();
		capsule.parentPromptTokens = promptTokens(message);
		capsule.response = cloneValue(message);
		currentProviderProblem = "The latest parent response is complete.";
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
			const persistence = createTurnPersistence(ctx, "btw", question);
			activePersistence = persistence;
			const sessionId = ctx.sessionManager.getSessionId();
			let logger: BtwRunLogger;
			try {
				logger = new BtwRunLogger(sessionId);
			} catch (error) {
				const message = `Cannot create /btw diagnostic log: ${error instanceof Error ? error.message : String(error)}`;
				persistence.errorPending(message);
				ctx.ui.notify(message, "error");
				if (activePersistence === persistence) activePersistence = undefined;
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
				const message = `Cannot write /btw diagnostic log: ${logger.lastError?.message ?? "unknown error"}`;
				persistence.errorPending(message);
				ctx.ui.notify(message, "error");
				activeLogger = undefined;
				if (activePersistence === persistence) activePersistence = undefined;
				return;
			}

			let overlayRef: BtwOverlay | undefined;
			let sideTurnTask: Promise<unknown> | undefined;
			const sideTransportSessionIds = new Set<string>();
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
							sideTurnTask = runSideTurn(followUp, thread, overlay, logger, ctx).catch(reportTurnError);
						}, copyBtwConversation, "/btw", persistence.onTurnEvent);
						overlayRef = overlay;
						activeOverlay = overlay;
						activeController = overlay.controller;
						activeKind = "cache";
						logger.write("overlay_opened", { invokedWhileParentRunning });
						overlay.setWaiting();
						sideTurnTask = (async () => {
							let waitFrom = initialCapsule;
							while (!overlay.signal.aborted) {
								const capsule = await waitForReadyCapsule(ctx, waitFrom, overlay.signal, logger, overlay);
								if (!capsule || overlay.signal.aborted) return;
								const mode = modeForCapsule(capsule);
								capsule.runLogger = logger;
								if (agentRunning) parentRunLoggers.add(logger);
								thread = createSideThread(capsule, mode);
								sideTransportSessionIds.add(thread.transportSessionId);
								requireDiagnosticLog(logger, "capsule_selected", {
									mode,
									captureId: capsule.captureId,
									capturedAt: capsule.capturedAt,
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
								overlay.setStreaming();
								const result = await runSideTurn(question, thread, overlay, logger, ctx, true);
								if (result !== "retry-parent") return;
								thread = undefined;
								waitFrom = capsule;
							}
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
				persistence.errorPending(error instanceof Error ? error.message : String(error));
				throw error;
			} finally {
				const ownController = overlayRef?.controller;
				ownController?.abort();
				await sideTurnTask;
				for (const sideTransportSessionId of sideTransportSessionIds) {
					try {
						cleanupSessionResources(sideTransportSessionId);
						logger.write("side_transport_cleaned", { transportSessionId: sideTransportSessionId });
					} catch (error) {
						logger.write("side_transport_cleanup_error", { error: errorDiagnostics(error) });
					}
				}
				if (activeController === ownController) {
					activeController = undefined;
					activeKind = undefined;
				}
				if (activeOverlay === overlayRef) activeOverlay = undefined;
				logger.write("command_handler_finished", {
					closedBy: overlayRef?.closedBy,
					agentRunning,
				});
				if (logger.lastError) {
					try {
						ctx.ui.notify(`/btw diagnostics became incomplete: ${logger.lastError.message}`, "error");
					} catch {}
				}
				if (activeLogger === logger) activeLogger = undefined;
				persistence.cancelPending(overlayRef?.closedBy ?? "The /btw command ended before the turn completed.");
				if (activePersistence === persistence) activePersistence = undefined;
			}
		},
	};

	const btwLunaCommand = {
		description: "Open an immediate ephemeral side conversation with Luna",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/btw-luna currently requires Pi's TUI.", "warning");
				return;
			}
			const question = args.trim();
			if (!question) {
				ctx.ui.notify("Usage: /btw-luna <side question>", "warning");
				return;
			}
			if (activeController) {
				ctx.ui.notify("A side conversation is already open.", "warning");
				return;
			}
			const persistence = createTurnPersistence(ctx, "btw-luna", question);
			activePersistence = persistence;
			if (!ctx.model) {
				const message = "/btw-luna requires an active parent model.";
				persistence.errorPending(message);
				ctx.ui.notify(message, "error");
				if (activePersistence === persistence) activePersistence = undefined;
				return;
			}
			const parentModelId = ctx.model.id;
			const setupController = new AbortController();
			activeController = setupController;
			activeKind = "luna-auth";
			const parentModelKey = modelKey(ctx.model);
			const parentSessionId = ctx.sessionManager.getSessionId();
			const parentProvider = ctx.model.provider;
			const baseMessages = lunaSnapshot(ctx);
			const systemPrompt = `${ctx.getSystemPrompt()}\n\n${LUNA_SIDE_MODE_PROMPT}`;
			const thinkingLevel = pi.getThinkingLevel();
			let thread: LunaThread | undefined;
			let overlayRef: BtwOverlay | undefined;
			let sideTurnTask: Promise<void> | undefined;
			try {
				const lunaModelId = await codexWireModelId(parentModelId) !== parentModelId
					? `${LUNA_MODEL_ID}-long` : LUNA_MODEL_ID;
				if (setupController.signal.aborted || activeController !== setupController) return;
				const lunaModel = ctx.modelRegistry.find(parentProvider, lunaModelId) as Model<Api> | undefined;
				if (!lunaModel) {
					const message = `The active provider ${parentProvider} does not expose ${lunaModelId}.`;
					persistence.errorPending(message);
					ctx.ui.notify(message, "error");
					return;
				}
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(lunaModel).catch((error: unknown) => ({
					ok: false as const,
					error: error instanceof Error ? error.message : String(error),
				}));
				if (setupController.signal.aborted || activeController !== setupController) return;
				if (!ctx.model
					|| modelKey(ctx.model) !== parentModelKey
					|| ctx.sessionManager.getSessionId() !== parentSessionId
					|| pi.getThinkingLevel() !== thinkingLevel) {
					const message = "/btw-luna cancelled because the parent session or model changed while resolving authentication.";
					persistence.cancelPending(message);
					ctx.ui.notify(message, "warning");
					return;
				}
				if ("error" in auth) {
					const message = `Cannot authenticate ${parentProvider}/${lunaModelId}: ${auth.error}`;
					persistence.errorPending(message);
					ctx.ui.notify(message, "error");
					return;
				}
				if (!auth.apiKey) {
					const message = `No API key for ${parentProvider}/${lunaModelId}.`;
					persistence.errorPending(message);
					ctx.ui.notify(message, "error");
					return;
				}

				thread = {
					model: cloneValue(lunaModel),
					systemPrompt,
					baseMessages,
					messages: [],
					transportSessionId: randomUUID(),
					thinkingLevel,
					auth: {
						apiKey: auth.apiKey,
						headers: auth.headers ? { ...auth.headers } : undefined,
						env: auth.env ? { ...auth.env } : undefined,
					},
				};
				await ctx.ui.custom<void>(
					(tui, theme, _keybindings, done) => {
						let overlay: BtwOverlay;
						const reportTurnError = (error: unknown) => {
							if (overlay.isClosed) return;
							overlay.setError(error instanceof Error ? error.message : String(error));
							overlay.stopThread("Luna side thread unavailable.");
						};
						overlay = new BtwOverlay(
							tui,
							theme,
							question,
							done,
							(followUp) => {
								overlay.setStreaming();
								sideTurnTask = runLunaTurn(followUp, thread!, overlay).catch(reportTurnError);
							},
							copyBtwConversation,
							"/btw-luna",
							persistence.onTurnEvent,
						);
						overlayRef = overlay;
						activeOverlay = overlay;
						activeController = overlay.controller;
						activeKind = "luna";
						overlay.setStreaming();
						sideTurnTask = runLunaTurn(question, thread!, overlay).catch(reportTurnError);
						return overlay;
					},
					{
						overlay: true,
						overlayOptions: { anchor: "top-center", width: "92%", maxHeight: "85%", margin: 1 },
					},
				);
				await sideTurnTask;
			} catch (error) {
				persistence.errorPending(error instanceof Error ? error.message : String(error));
				throw error;
			} finally {
				const ownController = overlayRef?.controller;
				ownController?.abort();
				await sideTurnTask;
				try {
					if (thread) cleanupSessionResources(thread.transportSessionId);
				} finally {
					if (activeController === ownController || activeController === setupController) {
						activeController = undefined;
						activeKind = undefined;
					}
					if (activeOverlay === overlayRef) activeOverlay = undefined;
				}
				persistence.cancelPending(overlayRef?.closedBy ?? "The /btw-luna command ended before the turn completed.");
				if (activePersistence === persistence) activePersistence = undefined;
			}
		},
	};

	pi.events?.on?.("pi-web:btw", (request: any) => {
		if (!activeOverlay || activeOverlay.isClosed) return;
		if (request.action === "send") {
			if (typeof request.text !== "string" || !request.text.trim() || request.text.length > 200000) throw new Error("Invalid BTW prompt");
			activeOverlay.webSend(request.text);
		} else if (request.action === "close") activeOverlay.close("phone");
		request.result = activeOverlay?.isClosed ? undefined : activeOverlay?.webState();
	});

	pi.registerCommand("btw", btwCommand);
	pi.registerCommand("btw-luna", btwLunaCommand);
	pi.registerCommand("status", {
		description: "Alias for /btw status",
		handler: (_args, ctx) => btwCommand.handler("status and eta?", ctx),
	});
}

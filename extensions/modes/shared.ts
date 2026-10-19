import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const WIKI_DIR = join(homedir(), "wiki");
export const STATE_TYPE = "pi-custom-state";

export type Mode = "build" | "wiki";
export type BgJob = {
	id: number;
	command: string;
	startedAt: number;
	proc?: ChildProcessWithoutNullStreams;
	status: "running" | "suspended" | "done" | "stopped" | "error";
	exitCode?: number | null;
	stdout: string;
	stderr: string;
};

export const state: {
	mode: Mode;
	hasUsedWiki: boolean;
	busy: boolean;
	lastTool: string;
	bgJob?: BgJob;
	uiRender?: () => void;
	planUsage?: string;
	planUsageProvider?: string;
	planUsageUpdatedAt?: number;
	planUsageRefreshing?: boolean;
	thinkingLevel?: string;
	tpsEnabled?: boolean;
	tps?: number;
	tpsMessageStart?: number;
	tpsStreamStart?: number;
	tpsEstimatedTokens?: number;
	tpsTotalOutputTokens?: number;
	tpsTotalStreamMs?: number;
} = {
	mode: "build",
	hasUsedWiki: false,
	busy: false,
	lastTool: "",
};

export function stripAnsi(input: string) {
	return input.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");
}

export function fmtTokens(n: number) {
	if (!Number.isFinite(n) || n <= 0) return "0";
	if (n < 1000) return String(Math.round(n));
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}m`;
}

export function fmtElapsed(ms: number) {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${s % 60}s`;
	return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function headTail(text: string, maxChars = 48_000) {
	if (text.length <= maxChars) return text;
	const headChars = Math.floor(maxChars * 0.25);
	const tailChars = maxChars - headChars - 200;
	return `${text.slice(0, headChars)}\n\n… [middle truncated; showing head + latest tail] …\n\n${text.slice(-tailChars)}`;
}

export function textOfMessage(message: Message): string {
	if (typeof message.content === "string") return message.content;
	return (message.content ?? [])
		.map((p: any) => {
			if (p?.type === "text") return p.text;
			if (p?.type === "toolCall") return `[tool:${p.name}] ${JSON.stringify(p.arguments ?? {})}`;
			if (p?.type === "image") return "[image]";
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

export function persist(pi: ExtensionAPI) {
	pi.appendEntry(STATE_TYPE, { mode: state.mode, hasUsedWiki: state.hasUsedWiki });
}

export function restore(ctx: ExtensionContext) {
	state.mode = "build";
	state.hasUsedWiki = false;
	for (const e of ctx.sessionManager.getBranch()) {
		if (e.type === "custom" && e.customType === STATE_TYPE) {
			const data = e.data as any;
			if (data?.mode === "build" || data?.mode === "wiki") state.mode = data.mode;
			if (data?.mode === "wiki" || data?.hasUsedWiki === true) state.hasUsedWiki = true;
		}
	}
}

function decodeBase64Url(value: string) {
	const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
	const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
	return Buffer.from(padded, "base64").toString("utf8");
}

function accountIdFromJwt(token: string): string | undefined {
	try {
		const [, payload] = token.split(".");
		if (!payload) return undefined;
		const parsed = JSON.parse(decodeBase64Url(payload));
		const auth = parsed?.["https://api.openai.com/auth"];
		return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
	} catch {
		return undefined;
	}
}

function asRecord(value: unknown): Record<string, any> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

function leftPercent(window: any) {
	const used = typeof window?.used_percent === "number" ? window.used_percent : undefined;
	if (used === undefined || Number.isNaN(used)) return undefined;
	return Math.max(0, Math.min(100, Math.round(100 - used)));
}

const COMPACT_PLAN_USAGE = true;
const OPENAI_PLUS_CONFIG_PATH = join(homedir(), ".pi", "agent", "openai-plus.json");
const TPS_CONFIG_PATH = join(homedir(), ".pi", "agent", "tps.json");

function parsePlanUsage(data: any) {
	const bucket = asRecord(data?.rate_limit);
	const five = leftPercent(bucket?.primary_window);
	const seven = leftPercent(bucket?.secondary_window);
	if (five === undefined && seven === undefined) return undefined;
	return `5h:${five ?? "--"}% 7d:${seven ?? "--"}%`;
}

function formatPlanUsage(data: any) {
	if (!COMPACT_PLAN_USAGE) return parsePlanUsage(data);
	const bucket = asRecord(data?.rate_limit);
	const five = leftPercent(bucket?.primary_window);
	return five === undefined ? undefined : `u:${five}%`;
}

function isCodexProvider(provider?: string) {
	return provider === "openai-codex" || !!provider?.startsWith("codex-");
}

function isOpenAIProvider(provider?: string) {
	return provider === "openai" || provider === "openai-responses" || isCodexProvider(provider);
}

function isFastEnabledFor(ctx: ExtensionContext) {
	if (!isOpenAIProvider(ctx.model?.provider)) return false;
	try {
		if (!existsSync(OPENAI_PLUS_CONFIG_PATH)) return false;
		return JSON.parse(readFileSync(OPENAI_PLUS_CONFIG_PATH, "utf8"))?.fast === true;
	} catch {
		return false;
	}
}

export async function refreshPlanUsage(ctx: ExtensionContext, force = false) {
	const provider = ctx.model?.provider;
	if (!isCodexProvider(provider)) {
		state.planUsage = undefined;
		state.planUsageProvider = undefined;
		return;
	}
	const now = Date.now();
	if (!force && state.planUsageProvider === provider && state.planUsageUpdatedAt && now - state.planUsageUpdatedAt < 60_000) return;
	if (state.planUsageRefreshing) return;
	state.planUsageRefreshing = true;
	try {
		const token = await ctx.modelRegistry.getApiKeyForProvider(provider!);
		const accountId = token ? accountIdFromJwt(token) : undefined;
		if (!token || !accountId) return;
		const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
			headers: {
				accept: "*/*",
				authorization: `Bearer ${token}`,
				"chatgpt-account-id": accountId,
			},
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) return;
		const usage = formatPlanUsage(await response.json());
		if (usage) {
			state.planUsage = usage;
			state.planUsageProvider = provider;
			state.planUsageUpdatedAt = now;
			state.uiRender?.();
		}
	} catch {
		// Keep the previous cached value if usage refresh fails.
	} finally {
		state.planUsageRefreshing = false;
	}
}

function getUsage(ctx: ExtensionContext) {
	let input = 0, output = 0, total = 0;
	for (const e of ctx.sessionManager.getBranch()) {
		if (e.type === "message" && e.message.role === "assistant") {
			const m = e.message as AssistantMessage;
			input += m.usage?.input ?? 0;
			output += m.usage?.output ?? 0;
			total = Math.max(total, m.usage?.totalTokens ?? 0);
		}
	}
	const live = ctx.getContextUsage();
	return { input, output, total: live?.tokens ?? total };
}

export function restoreThinkingLevelFromSettings() {
	try {
		const path = join(homedir(), ".pi", "agent", "settings.json");
		if (existsSync(path)) {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			if (typeof parsed?.defaultThinkingLevel === "string") state.thinkingLevel = parsed.defaultThinkingLevel;
		}
	} catch {}
	try {
		state.tpsEnabled = existsSync(TPS_CONFIG_PATH) ? JSON.parse(readFileSync(TPS_CONFIG_PATH, "utf8"))?.enabled === true : false;
	} catch {
		state.tpsEnabled = false;
	}
}

export function setTpsEnabled(enabled: boolean) {
	state.tpsEnabled = enabled;
	if (!enabled) state.tps = undefined;
	try {
		mkdirSync(dirname(TPS_CONFIG_PATH), { recursive: true });
		writeFileSync(TPS_CONFIG_PATH, `${JSON.stringify({ enabled }, null, 2)}\n`, "utf8");
	} catch {}
	state.uiRender?.();
}

export function setThinkingLevel(level: string) {
	state.thinkingLevel = level;
	state.uiRender?.();
}

export function tpsAgentStart() {
	state.tps = undefined;
	state.tpsMessageStart = undefined;
	state.tpsStreamStart = undefined;
	state.tpsEstimatedTokens = 0;
	state.tpsTotalOutputTokens = 0;
	state.tpsTotalStreamMs = 0;
	state.uiRender?.();
}

export function tpsMessageStart(message: any) {
	if (!state.tpsEnabled || message?.role !== "assistant") return;
	state.tpsMessageStart = Date.now();
	state.tpsStreamStart = undefined;
	state.tpsEstimatedTokens = 0;
}

export function tpsMessageUpdate(event: any) {
	if (!state.tpsEnabled || event?.message?.role !== "assistant") return;
	const streamEvent = event.assistantMessageEvent;
	const delta = typeof streamEvent?.delta === "string" ? streamEvent.delta : "";
	if (!delta || !["text_delta", "thinking_delta", "toolcall_delta"].includes(streamEvent?.type)) return;
	const now = Date.now();
	state.tpsStreamStart ??= now;
	state.tpsEstimatedTokens = (state.tpsEstimatedTokens ?? 0) + Math.max(0, delta.length / 4);
	const elapsed = (now - state.tpsStreamStart) / 1000;
	const official = event.message?.usage?.output ?? 0;
	const current = official > 0 ? official : state.tpsEstimatedTokens ?? 0;
	if (elapsed > 0 && current > 0) {
		state.tps = Math.round(current / elapsed);
		state.uiRender?.();
	}
}

export function tpsMessageEnd(message: any) {
	if (!state.tpsEnabled || message?.role !== "assistant") return;
	const output = message?.usage?.output ?? 0;
	const startedAt = state.tpsStreamStart ?? state.tpsMessageStart;
	if (startedAt && output > 0) {
		state.tpsTotalOutputTokens = (state.tpsTotalOutputTokens ?? 0) + output;
		state.tpsTotalStreamMs = (state.tpsTotalStreamMs ?? 0) + Math.max(0, Date.now() - startedAt);
	}
	state.tpsMessageStart = undefined;
	state.tpsStreamStart = undefined;
	state.tpsEstimatedTokens = 0;
}

export function tpsAgentEnd() {
	if (!state.tpsEnabled) return;
	const seconds = (state.tpsTotalStreamMs ?? 0) / 1000;
	const tokens = state.tpsTotalOutputTokens ?? 0;
	if (seconds > 0 && tokens > 0) {
		state.tps = Math.round(tokens / seconds);
		state.uiRender?.();
	}
}

function thinkingLetter() {
	const level = state.thinkingLevel;
	if (level === "minimal") return "l";
	if (level === "low") return "l";
	if (level === "medium") return "m";
	if (level === "high") return "h";
	if (level === "xhigh") return "x";
	return "n";
}

export function statusText(ctx: ExtensionContext, theme: any, width: number) {
	const usage = getUsage(ctx);
	const model = ctx.model ? ctx.model.id : "no-model";
	const think = thinkingLetter();
	const fast = isFastEnabledFor(ctx) ? "f" : "";
	const plan = state.planUsage && (!state.planUsageProvider || state.planUsageProvider === ctx.model?.provider) ? ` ${state.planUsage}` : "";
	const tps = state.tpsEnabled && state.tps ? ` t:${state.tps}` : "";
	const bg = state.bgJob ? ` bg:${state.bgJob.status}${state.bgJob.status === "running" ? ` ${fmtElapsed(Date.now() - state.bgJob.startedAt)}` : state.bgJob.exitCode != null ? ` ${state.bgJob.exitCode}` : ""}` : "";
	const tool = state.lastTool ? ` ${state.lastTool}` : "";
	const contextLabel = COMPACT_PLAN_USAGE ? "c" : "ctx";
	const raw = COMPACT_PLAN_USAGE
		? `${model}${fast}${think} ${contextLabel}:${fmtTokens(usage.total)}${plan}${tps}${bg}${tool}`
		: `${model} ${fast}${think} ${contextLabel}:${fmtTokens(usage.total)}${plan}${tps}${bg}${tool}`;
	const line = truncateToWidth(raw, width, "...");
	return `${" ".repeat(Math.max(0, width - stripAnsi(line).length))}${line}`;
}

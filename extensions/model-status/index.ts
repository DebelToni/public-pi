import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const OPENAI_PLUS_CONFIG_PATH = join(getAgentDir(), "openai-plus.json");
const TPS_CONFIG_PATH = join(getAgentDir(), "tps.json");
const SETTINGS_PATH = join(getAgentDir(), "settings.json");

const state: {
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
} = {};

function stripAnsi(input: string) {
	return input.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");
}

function fmtTokens(n: number) {
	if (!Number.isFinite(n) || n <= 0) return "0";
	if (n < 1000) return String(Math.round(n));
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}m`;
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

function readDefaults() {
	try {
		if (existsSync(SETTINGS_PATH)) {
			const parsed = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
			if (typeof parsed?.defaultThinkingLevel === "string") state.thinkingLevel = parsed.defaultThinkingLevel;
		}
	} catch {}
	try {
		state.tpsEnabled = existsSync(TPS_CONFIG_PATH) ? JSON.parse(readFileSync(TPS_CONFIG_PATH, "utf8"))?.enabled === true : false;
	} catch {
		state.tpsEnabled = false;
	}
}

function setTpsEnabled(enabled: boolean) {
	state.tpsEnabled = enabled;
	if (!enabled) state.tps = undefined;
	try {
		mkdirSync(dirname(TPS_CONFIG_PATH), { recursive: true });
		writeFileSync(TPS_CONFIG_PATH, `${JSON.stringify({ enabled }, null, 2)}\n`, "utf8");
	} catch {}
	state.uiRender?.();
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

async function refreshPlanUsage(ctx: ExtensionContext, force = false) {
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
		const bucket = asRecord((await response.json())?.rate_limit);
		const five = leftPercent(bucket?.primary_window);
		if (five !== undefined) {
			state.planUsage = `u:${five}%`;
			state.planUsageProvider = provider;
			state.planUsageUpdatedAt = now;
			state.uiRender?.();
		}
	} catch {
		// Keep previous cached value.
	} finally {
		state.planUsageRefreshing = false;
	}
}

function statusText(ctx: ExtensionContext, width: number) {
	const usage = getUsage(ctx);
	const model = ctx.model ? ctx.model.id : "no-model";
	const fast = isFastEnabledFor(ctx) ? "f" : "";
	const think = thinkingLetter();
	const plan = state.planUsage && (!state.planUsageProvider || state.planUsageProvider === ctx.model?.provider) ? ` ${state.planUsage}` : "";
	const tps = state.tpsEnabled && state.tps ? ` t:${state.tps}` : "";
	const raw = `${model}${fast}${think} c:${fmtTokens(usage.total)}${plan}${tps}`;
	const line = truncateToWidth(raw, width, "...");
	return `${" ".repeat(Math.max(0, width - stripAnsi(line).length))}${line}`;
}

function tpsAgentStart() {
	state.tps = undefined;
	state.tpsMessageStart = undefined;
	state.tpsStreamStart = undefined;
	state.tpsEstimatedTokens = 0;
	state.tpsTotalOutputTokens = 0;
	state.tpsTotalStreamMs = 0;
	state.uiRender?.();
}

function tpsMessageStart(message: any) {
	if (!state.tpsEnabled || message?.role !== "assistant") return;
	state.tpsMessageStart = Date.now();
	state.tpsStreamStart = undefined;
	state.tpsEstimatedTokens = 0;
}

function tpsMessageUpdate(event: any) {
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

function tpsMessageEnd(message: any) {
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

function tpsAgentEnd() {
	if (!state.tpsEnabled) return;
	const seconds = (state.tpsTotalStreamMs ?? 0) / 1000;
	const tokens = state.tpsTotalOutputTokens ?? 0;
	if (seconds > 0 && tokens > 0) {
		state.tps = Math.round(tokens / seconds);
		state.uiRender?.();
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		readDefaults();
		void refreshPlanUsage(ctx, true);
		if (!ctx.hasUI) return;
		ctx.ui.setFooter((tui) => {
			state.uiRender = () => tui.requestRender();
			return { invalidate() {}, render(width: number): string[] { return [statusText(ctx, width)]; } };
		});
	});

	pi.on("model_select", async (_event, ctx) => { void refreshPlanUsage(ctx, true); });
	pi.on("turn_end", async (_event, ctx) => { void refreshPlanUsage(ctx); });
	pi.on("thinking_level_select", async (event) => { state.thinkingLevel = event.level; state.uiRender?.(); });

	pi.registerCommand("tps", {
		description: "Toggle TPS display in the model status line",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "status") {
				ctx.ui.notify(`TPS display: ${state.tpsEnabled ? "on" : "off"}${state.tps ? ` (${state.tps})` : ""}`, "info");
				return;
			}
			const next = arg === "on" ? true : arg === "off" ? false : !state.tpsEnabled;
			setTpsEnabled(next);
			ctx.ui.notify(`TPS display ${next ? "on" : "off"}`, "info");
		},
	});

	pi.on("agent_start", async () => tpsAgentStart());
	pi.on("message_start", async (event) => tpsMessageStart(event.message));
	pi.on("message_update", async (event) => tpsMessageUpdate(event));
	pi.on("message_end", async (event) => tpsMessageEnd(event.message));
	pi.on("agent_end", async () => tpsAgentEnd());
}

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { FAST_MODE_CHANGED_CHANNEL, resolveFastMode } from "../lib/fast-mode.js";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const OPENAI_PLUS_CONFIG_PATH = join(getAgentDir(), "openai-plus.json");
const TPS_CONFIG_PATH = join(getAgentDir(), "tps.json");
const USAGE_STATUS_CONFIG_PATH = join(getAgentDir(), "usage-status.json");
const SETTINGS_PATH = join(getAgentDir(), "settings.json");
const MODEL_PREFIX_CHANNEL = "model-status:prefix";
const PLAN_USAGE_REFRESH_MS = 30 * 60_000;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const modelPrefixes = new Map<string, { value: string; order: number }>();

const state: {
	uiRender?: () => void;
	activePlanProvider?: string;
	planUsageEnabled?: boolean;
	planResetEnabled?: boolean;
	modelPrefix?: string;
	promptTabs?: string;
	thinkingLevel?: string;
	tpsEnabled?: boolean;
	tps?: number;
	tpsMessageStart?: number;
	tpsStreamStart?: number;
	tpsEstimatedTokens?: number;
	tpsTotalOutputTokens?: number;
	tpsTotalStreamMs?: number;
} = {};

type PlanUsageSnapshot = { usage: string; resetAtMs?: number };
const planUsageByProvider = new Map<string, PlanUsageSnapshot>();
const planUsageAttemptedAt = new Map<string, number>();
const planUsageRefreshing = new Set<string>();

function updateModelPrefix(value: unknown) {
	if (typeof value === "string") {
		if (value) modelPrefixes.set("legacy", { value, order: 0 });
		else modelPrefixes.delete("legacy");
	} else if (value === undefined) {
		modelPrefixes.delete("legacy");
	} else if (value && typeof value === "object") {
		const contribution = value as { key?: unknown; value?: unknown; order?: unknown };
		if (typeof contribution.key !== "string" || !contribution.key) return;
		if (typeof contribution.value === "string" && contribution.value) {
			modelPrefixes.set(contribution.key, {
				value: contribution.value,
				order: typeof contribution.order === "number" ? contribution.order : 0,
			});
		} else {
			modelPrefixes.delete(contribution.key);
		}
	} else {
		return;
	}
	state.modelPrefix = [...modelPrefixes.entries()]
		.sort(([leftKey, left], [rightKey, right]) => left.order - right.order || leftKey.localeCompare(rightKey))
		.map(([, contribution]) => contribution.value)
		.join(" ") || undefined;
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

export function quotaResetAtMs(window: any, observedAtMs: number) {
	const absolute = typeof window?.reset_at === "number" && Number.isFinite(window.reset_at) ? window.reset_at : undefined;
	if (absolute !== undefined && absolute > 0) return absolute > 10_000_000_000 ? absolute : absolute * 1000;
	const remaining = typeof window?.reset_after_seconds === "number" && Number.isFinite(window.reset_after_seconds)
		? window.reset_after_seconds
		: undefined;
	return remaining !== undefined && remaining >= 0 ? observedAtMs + remaining * 1000 : undefined;
}

export function formatResetRemaining(resetAtMs: number, nowMs = Date.now()) {
	const remaining = Math.max(0, resetAtMs - nowMs);
	if (remaining < DAY_MS) return `r:${Math.floor(remaining / HOUR_MS)}h`;
	return `r:${Math.floor(remaining / DAY_MS)}d`;
}

function planStatusIsEnabled() {
	return state.planUsageEnabled !== false || state.planResetEnabled !== false;
}

function isCodexProvider(provider?: string) {
	return provider === "openai-codex" || !!provider?.startsWith("codex-");
}

function isOpenAIProvider(provider?: string) {
	return provider === "openai" || provider === "openai-responses" || isCodexProvider(provider);
}

function isFastEnabledFor(ctx: ExtensionContext) {
	if (!isOpenAIProvider(ctx.model?.provider)) return false;
	let globalDefault = false;
	try {
		if (existsSync(OPENAI_PLUS_CONFIG_PATH)) {
			globalDefault = JSON.parse(readFileSync(OPENAI_PLUS_CONFIG_PATH, "utf8"))?.fast === true;
		}
	} catch {}
	return resolveFastMode(ctx.sessionManager.getEntries(), globalDefault).effective;
}

function readDefaults(usageStatusConfigPath: string) {
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
	try {
		const saved = existsSync(usageStatusConfigPath)
			? JSON.parse(readFileSync(usageStatusConfigPath, "utf8"))
			: {};
		const legacy = typeof saved?.enabled === "boolean" ? saved.enabled : true;
		state.planUsageEnabled = typeof saved?.usage === "boolean" ? saved.usage : legacy;
		state.planResetEnabled = typeof saved?.reset === "boolean" ? saved.reset : legacy;
	} catch {
		state.planUsageEnabled = true;
		state.planResetEnabled = true;
	}
}

function setPlanDisplay(configPath: string, next: { usage?: boolean; reset?: boolean }) {
	const usage = next.usage ?? (state.planUsageEnabled !== false);
	const reset = next.reset ?? (state.planResetEnabled !== false);
	try {
		mkdirSync(dirname(configPath), { recursive: true });
		writeFileSync(configPath, `${JSON.stringify({ usage, reset }, null, 2)}\n`, "utf8");
	} catch {
		return false;
	}
	state.planUsageEnabled = usage;
	state.planResetEnabled = reset;
	state.uiRender?.();
	return true;
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
	if (level === "max") return "M";
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

async function refreshPlanUsage(ctx: ExtensionContext) {
	if (!planStatusIsEnabled()) return;
	const provider = ctx.model?.provider;
	if (!isCodexProvider(provider)) return;
	const now = Date.now();
	const attemptedAt = planUsageAttemptedAt.get(provider!);
	if (attemptedAt !== undefined && now - attemptedAt < PLAN_USAGE_REFRESH_MS) return;
	if (planUsageRefreshing.has(provider!)) return;
	planUsageAttemptedAt.set(provider!, now);
	planUsageRefreshing.add(provider!);
	try {
		const token = await ctx.modelRegistry.getApiKeyForProvider(provider!);
		const accountId = token ? accountIdFromJwt(token) : undefined;
		if (!planStatusIsEnabled()) {
			planUsageAttemptedAt.delete(provider!);
			return;
		}
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
		const window = asRecord(bucket?.primary_window);
		const remaining = leftPercent(window);
		if (remaining !== undefined) {
			const receivedAt = Date.now();
			planUsageByProvider.set(provider!, {
				usage: `u:${remaining}%`,
				resetAtMs: quotaResetAtMs(window, receivedAt),
			});
			if (state.activePlanProvider === provider) state.uiRender?.();
		}
	} catch {
		// Keep previous cached value.
	} finally {
		planUsageRefreshing.delete(provider!);
	}
}

function statusText(ctx: ExtensionContext, width: number) {
	const usage = getUsage(ctx);
	const model = ctx.model ? ctx.model.id : "no-model";
	const fast = isFastEnabledFor(ctx) ? "f" : "";
	const think = thinkingLetter();
	const planSnapshot = !ctx.model?.provider ? undefined : planUsageByProvider.get(ctx.model.provider);
	const planParts: string[] = [];
	if (state.planUsageEnabled !== false && planSnapshot) planParts.push(planSnapshot.usage);
	if (state.planResetEnabled !== false && planSnapshot?.resetAtMs !== undefined) {
		planParts.push(formatResetRemaining(planSnapshot.resetAtMs));
	}
	const plan = planParts.length ? ` ${planParts.join(" ")}` : "";
	const tps = state.tpsEnabled && state.tps ? ` t:${state.tps}` : "";
	const prefix = state.modelPrefix ? `${state.modelPrefix} ` : "";
	const raw = `${prefix}${model}${fast}${think} c:${fmtTokens(usage.total)}${plan}${tps}`;
	const right = truncateToWidth(raw, width, "...");
	const rightWidth = visibleWidth(right);
	const maxLeftWidth = width - rightWidth - 1;
	if (!state.promptTabs || maxLeftWidth < 8) {
		return `${" ".repeat(Math.max(0, width - rightWidth))}${right}`;
	}
	const left = truncateToWidth(state.promptTabs, maxLeftWidth, "…");
	const gap = " ".repeat(Math.max(1, width - visibleWidth(left) - rightWidth));
	return `${ctx.ui.theme.fg("dim", left)}${gap}${right}`;
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

export default function (pi: ExtensionAPI, options: { usageStatusConfigPath?: string } = {}) {
	const usageStatusConfigPath = options.usageStatusConfigPath ?? USAGE_STATUS_CONFIG_PATH;
	let resetCountdownTimer: NodeJS.Timeout | undefined;
	let unsubscribeModelPrefix: (() => void) | undefined;
	let unsubscribeFastMode: (() => void) | undefined;
	let unsubscribePromptTabs: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		readDefaults(usageStatusConfigPath);
		modelPrefixes.clear();
		state.modelPrefix = undefined;
		state.promptTabs = undefined;
		unsubscribeModelPrefix?.();
		unsubscribeModelPrefix = pi.events.on(MODEL_PREFIX_CHANNEL, (value) => {
			updateModelPrefix(value);
			state.uiRender?.();
		});
		unsubscribeFastMode?.();
		unsubscribeFastMode = pi.events.on(FAST_MODE_CHANGED_CHANNEL, () => state.uiRender?.());
		unsubscribePromptTabs?.();
		unsubscribePromptTabs = pi.events.on("prompt-tabs:footer", (value) => {
			state.promptTabs = typeof value === "string" && value ? value : undefined;
		});
		state.activePlanProvider = isCodexProvider(ctx.model?.provider) ? ctx.model?.provider : undefined;
		void refreshPlanUsage(ctx);
		if (!ctx.hasUI) return;
		ctx.ui.setFooter((tui) => {
			state.uiRender = () => tui.requestRender();
			return { invalidate() {}, render(width: number): string[] { return [statusText(ctx, width)]; } };
		});
		if (resetCountdownTimer) clearInterval(resetCountdownTimer);
		resetCountdownTimer = setInterval(() => {
			if (state.planResetEnabled !== false) state.uiRender?.();
		}, 60_000);
		resetCountdownTimer.unref();
	});

	pi.on("session_shutdown", () => {
		if (resetCountdownTimer) clearInterval(resetCountdownTimer);
		resetCountdownTimer = undefined;
		unsubscribeModelPrefix?.();
		unsubscribeModelPrefix = undefined;
		unsubscribeFastMode?.();
		unsubscribeFastMode = undefined;
		unsubscribePromptTabs?.();
		unsubscribePromptTabs = undefined;
		modelPrefixes.clear();
		state.modelPrefix = undefined;
		state.promptTabs = undefined;
		state.activePlanProvider = undefined;
		state.uiRender = undefined;
	});

	pi.on("model_select", (_event, ctx) => {
		state.activePlanProvider = isCodexProvider(ctx.model?.provider) ? ctx.model?.provider : undefined;
		void refreshPlanUsage(ctx);
	});
	pi.on("turn_end", (_event, ctx) => { void refreshPlanUsage(ctx); });
	pi.on("thinking_level_select", async (event) => { state.thinkingLevel = event.level; state.uiRender?.(); });

	const registerPlanToggle = (name: "usage" | "reset", label: string) => {
		pi.registerCommand(name, {
			description: `Toggle Codex ${label.toLowerCase()} display in the model status line`,
			handler: async (args, ctx) => {
				const arg = args.trim().toLowerCase();
				const enabled = name === "usage" ? state.planUsageEnabled !== false : state.planResetEnabled !== false;
				if (arg === "status") {
					ctx.ui.notify(`${label} display: ${enabled ? "on" : "off"}`, "info");
					return;
				}
				if (arg && arg !== "on" && arg !== "off") {
					ctx.ui.notify(`Usage: /${name} [on|off|status]`, "warning");
					return;
				}
				const next = arg === "on" ? true : arg === "off" ? false : !enabled;
				const update = name === "usage" ? { usage: next } : { reset: next };
				if (!setPlanDisplay(usageStatusConfigPath, update)) {
					ctx.ui.notify(`Could not save the ${label.toLowerCase()} display setting.`, "error");
					return;
				}
				if (next) void refreshPlanUsage(ctx);
				ctx.ui.notify(`${label} display ${next ? "on" : "off"}`, "info");
			},
		});
	};
	registerPlanToggle("usage", "Usage");
	registerPlanToggle("reset", "Reset");

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

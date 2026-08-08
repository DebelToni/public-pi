import { uuidv7 } from "@earendil-works/pi-ai";
import { streamSimple, type ThinkingLevel } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	CODEX_USAGE_LIMIT_SIGNAL_CHANNEL,
	getCodexUsageLimitCandidate,
} from "../codex-accounts/auto-recovery.js";
import { recordInternalUsage } from "../lib/internal-usage.js";
import { buildCompactionPrompt } from "./prompt.ts";

type CustomSettings = {
	compactionProvider?: string;
	compactionModel?: string | { provider?: string; model?: string };
	compactionThinkingLevel?: ThinkingLevel;
};

function readJson(path: string): any {
	try {
		if (!existsSync(path)) return undefined;
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function getCustomSettings(cwd: string): CustomSettings {
	const globalSettings = readJson(join(homedir(), ".pi", "agent", "settings.json"));
	const projectSettings = readJson(join(cwd, ".pi", "settings.json"));
	return { ...(globalSettings?.piCustom ?? {}), ...(projectSettings?.piCustom ?? {}) };
}

export function resolveCompactionModelConfig(
	settings: CustomSettings,
	currentModel?: { provider: string; id: string },
) {
	const raw = settings.compactionModel ?? "gpt-5.6-sol";
	let provider = settings.compactionProvider ?? "current";
	let model = "gpt-5.6-sol";
	if (typeof raw === "object" && raw) {
		provider = raw.provider ?? provider;
		model = raw.model ?? model;
	} else if (typeof raw === "string" && raw.includes("/")) {
		const [rawProvider, ...rest] = raw.split("/");
		provider = rawProvider || provider;
		model = rest.join("/") || model;
	} else if (typeof raw === "string") {
		model = raw;
	}
	if (provider === "current") provider = currentModel?.provider ?? "openai-codex";
	return { provider, model, reasoning: settings.compactionThinkingLevel ?? "high" };
}

function getCompactionModelConfig(ctx: ExtensionContext) {
	return resolveCompactionModelConfig(getCustomSettings(ctx.cwd), ctx.model);
}

export function reportCompactionUsageLimit(
	pi: Pick<ExtensionAPI, "events">,
	ctx: ExtensionContext,
	message: Parameters<typeof getCodexUsageLimitCandidate>[0],
) {
	const candidate = getCodexUsageLimitCandidate(message);
	if (!candidate) return false;
	pi.events.emit(CODEX_USAGE_LIMIT_SIGNAL_CHANNEL, { ...candidate, context: ctx });
	return true;
}

function setCompactionProgress(ctx: ExtensionContext, modelName: string, text: string, started: boolean) {
	if (!started) {
		ctx.ui.setWorkingMessage(`Compacting with ${modelName}: waiting for first token...`);
		return;
	}
	const tokens = Math.ceil(text.length / 4);
	ctx.ui.setWorkingMessage(`Compacting with ${modelName}: ~${tokens} tok / ${text.length} chars`);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, signal, customInstructions } = event;
		const compactModel = getCompactionModelConfig(ctx);
		const model = ctx.modelRegistry.find(compactModel.provider, compactModel.model);
		if (!model) {
			ctx.ui.notify(`Compaction cancelled: ${compactModel.provider}/${compactModel.model} is unavailable.`, "error");
			return { cancel: true };
		}
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) {
			ctx.ui.notify(`Compaction cancelled: no usable auth for ${model.provider}/${model.id}.`, "error");
			return { cancel: true };
		}
		const conversationText = serializeConversation(convertToLlm([...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]));
		const prompt = buildCompactionPrompt(conversationText, preparation.previousSummary, customInstructions);
		try {
			const modelName = `${model.provider}/${model.id} @ ${compactModel.reasoning}`;
			let text = "";
			let sawText = false;
			let lastUpdate = 0;
			setCompactionProgress(ctx, modelName, text, false);
			const responseStream = streamSimple(
				model,
				{ messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					env: auth.env,
					reasoning: compactModel.reasoning,
					signal,
					cacheRetention: "none",
					sessionId: uuidv7(),
				},
			);
			for await (const event of responseStream) {
				if (event.type !== "text_delta") continue;
				text += event.delta;
				if (!sawText) {
					sawText = true;
					ctx.ui.setWorkingIndicator({ frames: [] });
				}
				const now = Date.now();
				if (now - lastUpdate > 500) {
					setCompactionProgress(ctx, modelName, text, true);
					lastUpdate = now;
				}
			}
			const response = await responseStream.result();
			if (response.stopReason === "error" || response.stopReason === "aborted") {
				if (response.stopReason === "error") reportCompactionUsageLimit(pi, ctx, response);
				if (!signal.aborted) ctx.ui.notify(`Compaction failed: ${response.errorMessage ?? response.stopReason}.`, "error");
				return { cancel: true };
			}
			recordInternalUsage(pi, "compaction", model, response);
			const summary = response.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n").trim();
			if (!summary) {
				ctx.ui.notify("Compaction returned an empty summary; compaction was cancelled.", "error");
				return { cancel: true };
			}
			setCompactionProgress(ctx, modelName, summary, true);
			return { compaction: { summary, firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore } };
		} catch (error) {
			if (!signal.aborted) {
				ctx.ui.notify(`Compaction failed; compaction was cancelled: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
			return { cancel: true };
		} finally {
			ctx.ui.setWorkingIndicator();
			ctx.ui.setWorkingMessage();
		}
	});
}

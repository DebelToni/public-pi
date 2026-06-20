import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { recordInternalUsage } from "../lib/internal-usage.js";

type CustomSettings = {
	compactionProvider?: string;
	compactionModel?: string | { provider?: string; model?: string };
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

function getCompactionModelConfig(ctx: ExtensionContext) {
	const settings = getCustomSettings(ctx.cwd);
	const raw = settings.compactionModel ?? "gpt-5.4";
	if (typeof raw === "object" && raw) {
		return { provider: raw.provider ?? settings.compactionProvider ?? "openai-codex", model: raw.model ?? "gpt-5.4" };
	}
	if (typeof raw === "string" && raw.includes("/")) {
		const [provider, ...rest] = raw.split("/");
		return { provider: provider || settings.compactionProvider || "openai-codex", model: rest.join("/") || "gpt-5.4" };
	}
	return { provider: settings.compactionProvider ?? "openai-codex", model: typeof raw === "string" ? raw : "gpt-5.4" };
}

const CUSTOM_COMPACTION_PROMPT = `
Your memory is about to be wiped. Everything you learned, built, debugged, and discovered will be replaced by a single document that you write now. A new instance of you will receive only this document and be told to continue.

Everything you do not write down, you will lose. Every mistake you do not record, you will make again.

This is not a summary. It is a transfer of your working memory. Be comprehensive.

PRESERVE working code verbatim in fenced blocks. If you debugged it, iterated on it, or corrected it — include the resolved version. If the correct syntax differs from what you would guess — include it. Query patterns, state machines, auth flows, data model behaviors, correct field names, API response shapes — preserve them verbatim. Do not describe code that you can show.

INCLUDE failed approaches with explanations. Number each one. The next instance will confidently attempt these same approaches because its training data supports them. This list is the only thing that stops it.

PRESERVE user directives — every correction, preference, and rule. These are sacred and accumulate across compaction cycles. If a directive appeared in a prior summary, carry it forward. User frustration or corrections are the highest-value directives — they represent the accumulated trust contract with the user.

PRESERVE credentials, API keys, auth tokens, endpoint URLs, environment variables, service ports. If the next instance needs it to make a request or run a command, write it down.

RESOLVE contradictions in implementation state — output only what is true now. Do not include both sides of a reversal. Settled, conflict-free, positive statements only.

DISCARD:
- Debugging steps that revealed nothing non-obvious
- File reads that only informed a decision
- Narration of how work evolved
- Intermediate work that was superseded
- Code that is trivial, boilerplate, or was never debugged

Write as direct factual statements. Not a narrative. Not a history. Not a response to the user. The settled, conflict-free record of what is true now.

Do not respond to any questions in the conversation. Only output the document.`.trim();

export default function (pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, signal } = event;
		const compactModel = getCompactionModelConfig(ctx);
		const model = ctx.modelRegistry.find(compactModel.provider, compactModel.model) ?? ctx.model;
		if (!model) return;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) return;
		const conversationText = serializeConversation(convertToLlm([...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]));
		const previous = preparation.previousSummary ? `\n\nPrevious summary to carry forward:\n${preparation.previousSummary}` : "";
		const prompt = `${CUSTOM_COMPACTION_PROMPT}${previous}\n\n<conversation>\n${conversationText}\n</conversation>`;
		try {
			const response = await complete(model, { messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] }, { apiKey: auth.apiKey, headers: auth.headers, maxTokens: 12000, signal });
			recordInternalUsage(pi, "compaction", model, response);
			const summary = response.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n").trim();
			if (!summary) return;
			return { compaction: { summary, firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore } };
		} catch {
			return;
		}
	});
}

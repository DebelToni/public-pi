import { complete } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { textOfMessage } from "../modes/shared.js";
import { recordInternalUsage } from "../lib/internal-usage.js";

const STATE_TYPE = "pi-goal-state";
const GOAL_PROVIDER = "openai-codex";
const GOAL_MODEL = "gpt-5.4-mini";

type GoalState = {
	active: boolean;
	goal: string;
	lastAssistantEntryId?: string;
};

const state: GoalState = { active: false, goal: "" };
let evaluating = false;

function persist(pi: ExtensionAPI) {
	pi.appendEntry(STATE_TYPE, { ...state });
}

function restore(ctx: ExtensionContext) {
	for (const e of ctx.sessionManager.getBranch()) {
		if (e.type !== "custom" || e.customType !== STATE_TYPE) continue;
		const data = e.data as any;
		state.active = !!data?.active;
		state.goal = typeof data?.goal === "string" ? data.goal : "";
		state.lastAssistantEntryId = typeof data?.lastAssistantEntryId === "string" ? data.lastAssistantEntryId : undefined;
	}
}

function latestAssistantSegment(ctx: ExtensionContext) {
	const branch = ctx.sessionManager.getBranch();
	let assistantIndex = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i];
		if (e.type === "message" && e.message.role === "assistant") {
			assistantIndex = i;
			break;
		}
	}
	if (assistantIndex < 0) return undefined;
	const assistantEntry = branch[assistantIndex];
	if (assistantEntry.type !== "message") return undefined;
	let userIndex = -1;
	for (let i = assistantIndex - 1; i >= 0; i--) {
		const e = branch[i];
		if (e.type === "message" && e.message.role === "user") {
			userIndex = i;
			break;
		}
	}
	if (userIndex < 0) return undefined;
	return {
		assistantEntryId: assistantEntry.id,
		messages: branch.slice(userIndex, assistantIndex + 1).filter((e) => e.type === "message").map((e: any) => e.message as Message),
	};
}

function formatSegment(messages: Message[]) {
	return messages.map((m) => `## ${m.role}\n${textOfMessage(m)}`).join("\n\n");
}

function parseDecision(text: string) {
	const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
	try {
		const json = JSON.parse(cleaned);
		return { complete: !!json.complete, reason: String(json.reason ?? "") };
	} catch {}
	const yes = /\bYES\b/i.test(cleaned) && !/\bNO\b/i.test(cleaned);
	return { complete: yes, reason: cleaned.slice(0, 1000) };
}

function stopGoal(pi: ExtensionAPI) {
	state.active = false;
	state.goal = "";
	state.lastAssistantEntryId = undefined;
	persist(pi);
}

async function evaluateGoal(pi: ExtensionAPI, ctx: ExtensionContext) {
	const segment = latestAssistantSegment(ctx);
	if (!segment || segment.assistantEntryId === state.lastAssistantEntryId) return undefined;
	const model = ctx.modelRegistry.find(GOAL_PROVIDER, GOAL_MODEL);
	if (!model) throw new Error(`Goal evaluator model not found: ${GOAL_PROVIDER}/${GOAL_MODEL}`);
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) throw new Error(`No auth for goal evaluator model: ${GOAL_PROVIDER}/${GOAL_MODEL}`);
	const prompt = `You are a strict goal-completion judge for a coding agent loop.\n\nGoal:\n${state.goal}\n\nRead only the transcript segment below, from the last user message through the final assistant response. Decide whether the goal is now fully complete.\n\nReturn only JSON with this shape:\n{"complete": boolean, "reason": "short explanation"}\n\nTranscript segment:\n${formatSegment(segment.messages)}`;
	const response = await complete(model, { messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] }, { apiKey: auth.apiKey, headers: auth.headers, maxTokens: 1200 });
	recordInternalUsage(pi, "goal", model, response);
	const text = response.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n");
	return { ...parseDecision(text), assistantEntryId: segment.assistantEntryId };
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => restore(ctx));

	pi.registerCommand("goal", {
		description: "Set an auto-continuing goal. Usage: /goal reach 100% test coverage; /goal status",
		handler: async (args, ctx) => {
			const goal = args.trim();
			if (!goal || goal === "status") {
				ctx.ui.notify(state.active ? `Goal active: ${state.goal}` : "No active goal", "info");
				return;
			}
			if (["off", "stop", "clear", "done"].includes(goal.toLowerCase())) {
				stopGoal(pi);
				ctx.ui.notify("Goal stopped", "info");
				return;
			}
			state.active = true;
			state.goal = goal;
			state.lastAssistantEntryId = undefined;
			persist(pi);
			ctx.ui.notify(`Goal armed: ${goal}`, "info");
			pi.sendUserMessage(`Work toward this goal until it is fully complete:\n\n${goal}`);
		},
	});

	pi.registerCommand("goal-stop", {
		description: "Stop the active auto-continuing goal",
		handler: async (_args, ctx) => {
			if (!state.active && !state.goal) {
				ctx.ui.notify("No active goal", "info");
				return;
			}
			stopGoal(pi);
			ctx.ui.notify("Goal stopped", "info");
		},
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!state.active || evaluating) return;
		evaluating = true;
		try {
			const decision = await evaluateGoal(pi, ctx);
			if (!decision) return;
			state.lastAssistantEntryId = decision.assistantEntryId;
			persist(pi);
			if (decision.complete) {
				state.active = false;
				persist(pi);
				pi.sendMessage({ customType: "goal", content: `✅ Goal complete: ${state.goal}\n\n${decision.reason}`, display: true });
			} else {
				pi.sendUserMessage(`Continue working toward this goal until it is fully complete:\n\n${state.goal}\n\nGoal-check result: not complete yet. ${decision.reason}`, { deliverAs: "followUp" });
			}
		} catch (error) {
			pi.sendMessage({ customType: "goal", content: `Goal evaluator error: ${error instanceof Error ? error.message : String(error)}`, display: true });
		} finally {
			evaluating = false;
		}
	});
}

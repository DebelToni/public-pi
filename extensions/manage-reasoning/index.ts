import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, StringEnum, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export const TOOL_DESCRIPTION = "Sets your reasoning level to low for simple tasks and faster responses, high for serious coding, or max for the highest possible rigor and perfection rather than speed. Does not automatically lower reasoning afterward.";

function modelKey(model: { provider: string; id: string } | undefined) {
	return model ? `${model.provider}\0${model.id}` : undefined;
}

export function nextInteractiveThinkingLevel(
	modelId: string,
	current: ModelThinkingLevel,
	supported: ModelThinkingLevel[],
): ModelThinkingLevel {
	if (modelId === "gpt-6.1-sol" || modelId === "gpt-6-luna") return "high";
	if (modelId === "gpt-6-astra") return current === "high" ? "max" : "high";
	if (supported.length === 0) return current;
	const index = supported.indexOf(current);
	return supported[(index + 1) % supported.length] ?? supported[0];
}

export function installReasoningManagement(pi: ExtensionAPI) {
	let selectedModel: string | undefined;
	let sessionThinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]> | undefined;

	pi.on("session_start", (_event, ctx) => {
		selectedModel = modelKey(ctx.model);
		sessionThinkingLevel = pi.getThinkingLevel();
	});

	pi.on("thinking_level_select", (event, ctx) => {
		// Pi changes the model before applying its configured default. Ignore that
		// intermediate reset; model_select below restores the session's level.
		if (modelKey(ctx.model) === selectedModel) sessionThinkingLevel = event.level;
	});

	pi.on("model_select", (event, ctx) => {
		selectedModel = modelKey(event.model);
		if (event.source === "restore") {
			sessionThinkingLevel = pi.getThinkingLevel();
			return;
		}
		const scopedTarget = ctx.scopedModels.find(({ model }) => modelKey(model) === selectedModel);
		if (event.source === "cycle" && scopedTarget?.thinkingLevel !== undefined) {
			sessionThinkingLevel = pi.getThinkingLevel();
			return;
		}
		if (sessionThinkingLevel === undefined) {
			sessionThinkingLevel = pi.getThinkingLevel();
			return;
		}
		pi.setThinkingLevel(sessionThinkingLevel);
		sessionThinkingLevel = pi.getThinkingLevel();
	});

	pi.registerShortcut("shift+tab", {
		description: "Cycle the interactive model's curated reasoning levels",
		handler: (ctx) => {
			if (!ctx.model) return;
			const next = nextInteractiveThinkingLevel(
				ctx.model.id,
				pi.getThinkingLevel(),
				getSupportedThinkingLevels(ctx.model),
			);
			pi.setThinkingLevel(next);
		},
	});

	pi.registerTool({
		name: "set_reasoning",
		label: "Set Reasoning",
		description: TOOL_DESCRIPTION,
		parameters: Type.Object({
			level: StringEnum(["low", "high", "max"] as const),
		}),
		async execute(_toolCallId, params) {
			pi.setThinkingLevel(params.level);
			const level = pi.getThinkingLevel();
			return {
				content: [{
					type: "text" as const,
					text: level === params.level
						? `Reasoning level switched to ${level}.`
						: `The active model limited reasoning to ${level}.`,
				}],
				details: { thinkingLevel: level },
			};
		},
	});
}

export default function manageReasoning(pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT === "1") return;
	installReasoningManagement(pi);
}

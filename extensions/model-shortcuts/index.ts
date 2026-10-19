import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type ShortcutModelId = "gpt-5.3-codex-spark" | "gpt-6-luna" | "gpt-6.1-sol" | "gpt-6-astra";
type ShortcutThinkingLevel = "low" | "medium" | "high";

async function selectCurrentCodexAccountModel(
	pi: ExtensionAPI,
	context: ExtensionContext,
	modelId: ShortcutModelId,
	thinkingLevel: ShortcutThinkingLevel,
) {
	const provider = context.model?.provider;
	if (!provider?.startsWith("codex-")) {
		context.ui.notify("This shortcut requires a current Codex account.", "warning");
		return;
	}
	const target = context.modelRegistry.find(provider, modelId);
	if (!target) {
		context.ui.notify(`${provider}/${modelId} is unavailable.`, "warning");
		return;
	}
	if (context.model?.id !== modelId && !(await pi.setModel(target))) {
		context.ui.notify(`Could not switch to ${provider}/${modelId}.`, "error");
		return;
	}
	pi.setThinkingLevel(thinkingLevel);
	context.ui.notify(`Using ${provider}/${modelId} with ${thinkingLevel} reasoning.`, "info");
}

export default function modelShortcuts(pi: ExtensionAPI) {
	pi.registerCommand("luna", {
		description: "Use Luna on the current Codex account",
		handler: async (_args, context) => selectCurrentCodexAccountModel(pi, context, "gpt-6-luna", "high"),
	});
	pi.registerCommand("sol", {
		description: "Use Sol on the current Codex account",
		handler: async (_args, context) => selectCurrentCodexAccountModel(pi, context, "gpt-6.1-sol", "high"),
	});
	pi.registerCommand("spark", {
		description: "Use Spark on the current Codex account",
		handler: async (_args, context) => selectCurrentCodexAccountModel(pi, context, "gpt-5.3-codex-spark", "medium"),
	});
	pi.registerCommand("astra", {
		description: "Use Astra on the current Codex account",
		handler: async (_args, context) => selectCurrentCodexAccountModel(pi, context, "gpt-6-astra", "max"),
	});
	pi.registerShortcut("alt+l", {
		description: "Use Luna on the current Codex account",
		handler: async (context) => selectCurrentCodexAccountModel(pi, context, "gpt-6-luna", "high"),
	});
	pi.registerShortcut("alt+s", {
		description: "Use Sol on the current Codex account",
		handler: async (context) => selectCurrentCodexAccountModel(pi, context, "gpt-6.1-sol", "high"),
	});
}

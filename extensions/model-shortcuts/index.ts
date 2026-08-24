import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

type ShortcutModelId = "gpt-5.3-codex-spark" | "gpt-5.6-luna" | "gpt-5.6-sol";

async function selectCurrentCodexAccountModel(
	pi: ExtensionAPI,
	context: ExtensionCommandContext,
	modelId: ShortcutModelId,
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
	if (context.model?.id === modelId) {
		context.ui.notify(`Already using ${provider}/${modelId}.`, "info");
		return;
	}
	if (!(await pi.setModel(target))) {
		context.ui.notify(`Could not switch to ${provider}/${modelId}.`, "error");
		return;
	}
	context.ui.notify(`Switched to ${provider}/${modelId}.`, "info");
}

export default function modelShortcuts(pi: ExtensionAPI) {
	pi.registerCommand("luna", {
		description: "Use Luna on the current Codex account",
		handler: async (_args, context) => selectCurrentCodexAccountModel(pi, context, "gpt-5.6-luna"),
	});
	pi.registerCommand("sol", {
		description: "Use Sol on the current Codex account",
		handler: async (_args, context) => selectCurrentCodexAccountModel(pi, context, "gpt-5.6-sol"),
	});
	pi.registerCommand("spark", {
		description: "Use Spark on the current Codex account",
		handler: async (_args, context) => selectCurrentCodexAccountModel(pi, context, "gpt-5.3-codex-spark"),
	});
}

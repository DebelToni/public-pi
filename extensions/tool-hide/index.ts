import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PATCH_KEY = Symbol.for("anton.pi.tool-hide.state");
const ASSISTANT_PATCH_KEY = Symbol.for("anton.pi.tool-hide.assistant-render");

type ToolHideState = {
	hidden: boolean;
	originalRender: (this: unknown, width: number) => string[];
};

type ToolExecutionModule = {
	ToolExecutionComponent: {
		prototype: {
			render: (width: number) => string[];
			[PATCH_KEY]?: ToolHideState;
		};
	};
};

type AssistantMessage = {
	stopReason?: string;
	content?: Array<{ type?: string; text?: string }>;
};

type AssistantMessageComponent = {
	lastMessage?: AssistantMessage;
};

type AssistantMessageModule = {
	AssistantMessageComponent: {
		prototype: {
			render: (width: number) => string[];
			[ASSISTANT_PATCH_KEY]?: true;
		};
	};
};

function resolvePiDistEntry() {
	try {
		return fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	} catch {}

	try {
		const cliPath = process.argv[1] ? realpathSync(process.argv[1]) : "";
		if (cliPath.endsWith("/dist/cli.js")) return join(dirname(cliPath), "index.js");
	} catch {}

	throw new Error("Could not locate the installed Pi coding-agent package.");
}

async function patchRenderers(): Promise<ToolHideState> {
	const packageEntry = resolvePiDistEntry();
	const componentsDir = join(dirname(packageEntry), "modes/interactive/components");
	const toolExecutionPath = join(componentsDir, "tool-execution.js");
	const assistantMessagePath = join(componentsDir, "assistant-message.js");
	const [{ ToolExecutionComponent }, { AssistantMessageComponent }] = await Promise.all([
		import(pathToFileURL(toolExecutionPath).href) as Promise<ToolExecutionModule>,
		import(pathToFileURL(assistantMessagePath).href) as Promise<AssistantMessageModule>,
	]);
	const proto = ToolExecutionComponent.prototype;

	let state = proto[PATCH_KEY];
	if (!state) {
		state = {
			hidden: false,
			originalRender: proto.render,
		};
		proto[PATCH_KEY] = state;
		proto.render = function (this: unknown, width: number) {
			if (state!.hidden) return [];
			return state!.originalRender.call(this, width);
		};
	}

	const assistantProto = AssistantMessageComponent.prototype;
	if (!assistantProto[ASSISTANT_PATCH_KEY]) {
		const originalRender = assistantProto.render;
		assistantProto.render = function (this: AssistantMessageComponent, width: number) {
			const lines = originalRender.call(this, width);
			const message = this.lastMessage;
			const isFinalAnswer = message?.stopReason === "stop"
				&& message.content?.some((part) => part.type === "text" && part.text?.trim());
			if (!state!.hidden || !isFinalAnswer || lines.length === 0) return lines;
			return ["-".repeat(Math.min(3, Math.max(0, width))), ...lines];
		};
		assistantProto[ASSISTANT_PATCH_KEY] = true;
	}

	return state;
}

function applyUiState(ctx: ExtensionContext, hidden: boolean) {
	ctx.ui.setStatus(
		"tool-hide",
		hidden ? ctx.ui.theme.fg("warning", "tools hidden") : undefined,
	);
	ctx.ui.setHiddenThinkingLabel(hidden ? "" : undefined);
}

function toggleToolVisibility(ctx: ExtensionContext, state: ToolHideState) {
	state.hidden = !state.hidden;
	applyUiState(ctx, state.hidden);
	ctx.ui.notify(`Tool calls ${state.hidden ? "hidden" : "visible"}`, "info");
}

export default async function (pi: ExtensionAPI) {
	const state = await patchRenderers();

	pi.on("session_start", async (_event, ctx) => {
		applyUiState(ctx, state.hidden);
	});

	pi.registerShortcut("ctrl+shift+o", {
		description: "Toggle tool call visibility",
		handler: async (ctx) => toggleToolVisibility(ctx, state),
	});

	pi.registerShortcut("ctrl+alt+o", {
		description: "Toggle tool call visibility",
		handler: async (ctx) => toggleToolVisibility(ctx, state),
	});

	pi.registerCommand("hide-tools", {
		description: "Toggle tool call visibility",
		handler: async (_args, ctx) => toggleToolVisibility(ctx, state),
	});
}

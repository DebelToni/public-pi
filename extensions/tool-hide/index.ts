import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const PATCH_KEY = Symbol.for("anton.pi.tool-hide.state");

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

function resolvePiDistEntry() {
	const require = createRequire(import.meta.url);
	try {
		return require.resolve("@earendil-works/pi-coding-agent");
	} catch {}

	try {
		const cliPath = process.argv[1] ? realpathSync(process.argv[1]) : "";
		if (cliPath.endsWith("/dist/cli.js")) return join(dirname(cliPath), "index.js");
	} catch {}

	return "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
}

async function patchToolExecutionRenderer(): Promise<ToolHideState> {
	const packageEntry = resolvePiDistEntry();
	const toolExecutionPath = join(dirname(packageEntry), "modes/interactive/components/tool-execution.js");
	const { ToolExecutionComponent } = (await import(pathToFileURL(toolExecutionPath).href)) as ToolExecutionModule;
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
	const state = await patchToolExecutionRenderer();

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

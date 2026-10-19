import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

export const CUSTOM_ENTRY_TYPE = "pi-max-context";
const MODEL_PREFIX_CHANNEL = "model-status:prefix";
const USAGE = "Usage: /set-max-context <positive integer tokens>; no argument restores this model's registered default.";

export function parseMaxContext(args: string): number | null {
	const text = args.trim();
	if (!text) return null;
	const value = Number(text);
	if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(value)) throw new Error(USAGE);
	return value;
}

export function restoreMaxContext(entries: readonly SessionEntry[], sessionId: string): number | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== CUSTOM_ENTRY_TYPE) continue;
		const data = entry.data as { version?: unknown; sessionId?: unknown; value?: unknown } | null;
		if (!data || data.version !== 1 || data.sessionId !== sessionId) continue;
		if (data.value === null) return undefined;
		if (typeof data.value === "number" && Number.isSafeInteger(data.value) && data.value > 0) return data.value;
	}
	return undefined;
}

export function maxContextMarker(ctx: Pick<ExtensionContext, "model" | "modelRegistry">): string {
	const model = ctx.model;
	const registered = model && ctx.modelRegistry.find(model.provider, model.id);
	if (!model || !registered || model.contextWindow === registered.contextWindow) return "";
	const value = model.contextWindow;
	// Keep arbitrary integer overrides exact rather than rounding two limits to the same label.
	const label = value % 1_000_000 === 0 ? `${value / 1_000_000}m`
		: value % 1_000 === 0 ? `${value / 1_000}k` : value.toLocaleString("en-US");
	return `max:${label}`;
}

export default function maxContext(pi: ExtensionAPI) {
	let overrideValue: number | undefined;
	let applying = false;

	function publish(ctx: ExtensionContext) {
		// Ultra owns the footer. Its keyed contribution channel also requests a render.
		pi.events.emit(MODEL_PREFIX_CHANNEL, { key: "max-context", value: maxContextMarker(ctx), order: 90 });
	}

	async function apply(ctx: ExtensionContext, value: number | null) {
		const model = ctx.model;
		if (!model) throw new Error("No active model.");
		const registered = ctx.modelRegistry.find(model.provider, model.id);
		if (!registered) throw new Error("The active model has no registered default.");
		const target = value === null ? registered : { ...model, contextWindow: value };
		if (value === null ? model === registered : model.contextWindow === value) return;
		const thinking = pi.getThinkingLevel();
		applying = true;
		try {
			if (!await pi.setModel(target)) throw new Error("Model authentication is not configured.");
		} finally {
			try {
				if (pi.getThinkingLevel() !== thinking) pi.setThinkingLevel(thinking);
			} finally {
				applying = false;
			}
		}
	}

	async function reconcile(ctx: ExtensionContext) {
		if (applying) return false;
		try {
			if (overrideValue !== undefined) await apply(ctx, overrideValue);
			publish(ctx);
			return true;
		} catch {
			publish(ctx);
			ctx.ui.notify("Could not restore the session context window. Check the selected model and its authentication, then retry /set-max-context.", "error");
			return false;
		}
	}

	function restore(ctx: ExtensionContext) {
		// All entries: the physically latest setting wins across /tree branches.
		// Session IDs prevent copied parent entries from activating in forks/subagents.
		overrideValue = restoreMaxContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getSessionId());
	}

	pi.on("session_start", async (_event, ctx) => {
		overrideValue = undefined;
		applying = false;
		restore(ctx);
		await reconcile(ctx);
	});
	pi.on("model_select", async (_event, ctx) => { await reconcile(ctx); });
	pi.on("session_tree", async (_event, ctx) => {
		restore(ctx);
		await reconcile(ctx);
	});
	pi.on("input", async (_event, ctx) => {
		// Same-ID selection/registry replacement emits no model_select. Repair before
		// Pi's pre-prompt compaction check, which precedes before_agent_start.
		if (ctx.isIdle() && !await reconcile(ctx)) return { action: "handled" };
	});
	pi.on("before_agent_start", async (_event, ctx) => { await reconcile(ctx); });
	pi.on("session_shutdown", () => {
		overrideValue = undefined;
		pi.events.emit(MODEL_PREFIX_CHANNEL, { key: "max-context", value: "", order: 90 });
	});

	pi.registerCommand("set-max-context", {
		description: "Set this session's context window in tokens; no argument resets to the registered default. Does not increase backend capacity; small limits may trigger compaction.",
		handler: async (args, ctx) => {
			let value: number | null;
			try {
				value = parseMaxContext(args);
			} catch {
				ctx.ui.notify(USAGE, "warning");
				return;
			}
			await ctx.waitForIdle();
			if (applying) {
				ctx.ui.notify("A context-window update is already in progress. Retry once it finishes.", "warning");
				return;
			}
			const model = ctx.model;
			const registered = model && ctx.modelRegistry.find(model.provider, model.id);
			if (!model || !registered) {
				ctx.ui.notify(model ? "The active model has no registered default." : "No active model.", "error");
				return;
			}
			try {
				await apply(ctx, value);
			} catch {
				ctx.ui.notify("Could not update the context window. Check the selected model and its authentication.", "error");
				return;
			}
			overrideValue = value ?? undefined;
			pi.appendEntry(CUSTOM_ENTRY_TYPE, {
				version: 1,
				sessionId: ctx.sessionManager.getSessionId(),
				value,
			});
			publish(ctx);
			const defaultText = registered.contextWindow.toLocaleString("en-US");
			ctx.ui.notify(value === null
				? `Context window restored to ${defaultText} for ${model.provider}/${model.id}.`
				: `Context window set to ${value.toLocaleString("en-US")} for this session (default: ${defaultText}).`, "info");
		},
	});
}

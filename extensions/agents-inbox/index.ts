import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { cachedClassification, classifyMissing, fingerprintItem } from "./classifier.js";
import { discoverTmuxAgents, type AgentInboxItem } from "./snapshot.js";
import { provisionalClassification, readPaneContext } from "./transcript.js";
import { AgentsInboxComponent } from "./ui.js";

function errorText(error: unknown) {
	if (error && typeof error === "object" && "stderr" in error) {
		const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
		if (stderr) return stderr;
	}
	return error instanceof Error ? error.message : String(error);
}

export function jumpToPane(item: AgentInboxItem, run = (args: string[]) => {
	const result = spawnSync("tmux", args, { encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "pipe"] });
	if (result.status !== 0) throw new Error(result.stderr.trim() || `tmux ${args[0]} failed`);
}) {
	run(["select-window", "-t", `${item.tmuxSessionId}:${item.windowId}`]);
	run(["select-pane", "-t", item.paneId]);
	run(["switch-client", "-t", item.tmuxSessionId]);
}

function createItems(ctx: ExtensionCommandContext): AgentInboxItem[] {
	return discoverTmuxAgents().map((pane) => {
		const context = readPaneContext(pane);
		const provisional = provisionalClassification(pane, context);
		const withoutFingerprint = {
			...pane,
			context,
			category: provisional.category,
			status: provisional.status,
			pending: true,
		};
		const fingerprint = fingerprintItem(withoutFingerprint as Omit<AgentInboxItem, "fingerprint">, ctx.model?.provider);
		const canClassify = Boolean(pane.sessionFile && !context.contextUnavailable);
		const cached = canClassify ? cachedClassification(fingerprint) : undefined;
		return {
			...withoutFingerprint,
			...(cached ?? {}),
			pending: canClassify && !cached,
			fingerprint,
		};
	});
}

async function showAgents(ctx: ExtensionCommandContext) {
	if (ctx.mode !== "tui" || !process.env.TMUX) {
		ctx.ui.notify("/agents requires Pi's interactive TUI inside tmux.", "error");
		return;
	}
	let items: AgentInboxItem[];
	try {
		items = createItems(ctx);
	} catch (error) {
		ctx.ui.notify(`Could not inspect tmux agents: ${errorText(error)}`, "error");
		return;
	}
	if (!items.length) {
		ctx.ui.notify("No live Pi agents were found in tmux.", "info");
		return;
	}
	let component: AgentsInboxComponent | undefined;
	const selected = await ctx.ui.custom<AgentInboxItem | undefined>((tui, theme, _keybindings, done) => {
		component = new AgentsInboxComponent(tui, theme, items, done);
		void classifyMissing(ctx, items, (item, result) => component?.update(item, result))
			.catch((error) => ctx.ui.notify(`Agent classification failed: ${errorText(error)}`, "warning"));
		return component;
	}, {
		overlay: true,
		overlayOptions: {
			width: "100%",
			maxHeight: "100%",
			anchor: "top-left",
			row: 0,
			col: 0,
			margin: 0,
		},
	});
	if (!selected) return;
	try {
		jumpToPane(selected);
	} catch (error) {
		ctx.ui.notify(`Could not switch tmux pane: ${errorText(error)}`, "error");
	}
}

export default function agentsInbox(pi: ExtensionAPI) {
	pi.registerCommand("agents", {
		description: "Show every live tmux Pi agent by working, ready, or needs-attention state",
		handler: async (_args, ctx) => showAgents(ctx),
	});
}

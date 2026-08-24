import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

type DeleteResult =
	| { kind: "none"; message: string }
	| { kind: "session"; sessionFile: string; message: string }
	| { kind: "branch"; sessionFile: string; deletedEntries: number; message: string };

function currentTmuxWindow(): string | undefined {
	if (!process.env.TMUX) return undefined;
	const pane = process.env.TMUX_PANE;
	try {
		return execFileSync("tmux", ["display-message", ...(pane ? ["-t", pane] : []), "-p", "#{window_id}"], { encoding: "utf8" }).trim() || undefined;
	} catch {
		return undefined;
	}
}

function rewriteSessionFile(sessionFile: string, entries: any[]) {
	writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

function currentBranchRoot(ctx: ExtensionContext, entries: any[]) {
	const manager = ctx.sessionManager as any;
	const leafId = manager.getLeafId?.();
	if (!leafId) return undefined;

	const sessionEntries = entries.filter((entry) => entry?.type !== "session" && entry?.id);
	const byId = new Map(sessionEntries.map((entry) => [entry.id, entry]));
	const children = new Map<string, any[]>();
	for (const entry of sessionEntries) {
		const parentKey = entry.parentId ?? "";
		const list = children.get(parentKey) ?? [];
		list.push(entry);
		children.set(parentKey, list);
	}

	const path: any[] = [];
	let current = byId.get(leafId);
	while (current) {
		path.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	path.reverse();

	for (let i = path.length - 1; i >= 0; i--) {
		const entry = path[i];
		const siblings = children.get(entry.parentId ?? "") ?? [];
		if (siblings.length > 1) return entry;
	}
	return undefined;
}

function deleteCurrentBranch(ctx: ExtensionContext, sessionFile: string, entries: any[], branchRoot: any): DeleteResult {
	const sessionEntries = entries.filter((entry) => entry?.type !== "session" && entry?.id);
	const children = new Map<string, any[]>();
	for (const entry of sessionEntries) {
		const list = children.get(entry.parentId) ?? [];
		list.push(entry);
		children.set(entry.parentId, list);
	}

	const deletedIds = new Set<string>();
	const stack = [branchRoot];
	while (stack.length) {
		const entry = stack.pop();
		if (!entry?.id || deletedIds.has(entry.id)) continue;
		deletedIds.add(entry.id);
		stack.push(...(children.get(entry.id) ?? []));
	}

	if (deletedIds.size === 0) return { kind: "none", message: "No current branch to delete." };

	const kept = entries.filter((entry) => entry?.type === "session" || !deletedIds.has(entry.id));
	const keptContentCount = kept.filter((entry) => entry?.type !== "session").length;
	if (keptContentCount === 0) {
		unlinkSync(sessionFile);
		return { kind: "session", sessionFile, message: "Deleted current session." };
	}

	rewriteSessionFile(sessionFile, kept);
	const manager = ctx.sessionManager as any;
	if (Array.isArray(manager.fileEntries)) manager.fileEntries = kept;
	manager._buildIndex?.();
	return { kind: "branch", sessionFile, deletedEntries: deletedIds.size, message: `Deleted current branch (${deletedIds.size} entries).` };
}

function deleteCurrent(ctx: ExtensionContext): DeleteResult {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile || !existsSync(sessionFile)) return { kind: "none", message: "No session file to delete." };

	const manager = ctx.sessionManager as any;
	const entries = Array.isArray(manager.fileEntries) ? manager.fileEntries : undefined;
	const branchRoot = entries ? currentBranchRoot(ctx, entries) : undefined;
	if (entries && branchRoot) return deleteCurrentBranch(ctx, sessionFile, entries, branchRoot);

	unlinkSync(sessionFile);
	return { kind: "session", sessionFile, message: "Deleted current session." };
}

async function deleteAndExit(ctx: ExtensionContext, closeTmuxWindow: boolean) {
	const result = deleteCurrent(ctx);
	if (closeTmuxWindow) {
		const window = currentTmuxWindow();
		if (window) {
			execFileSync("tmux", ["kill-window", "-t", window], { stdio: "ignore" });
			return;
		}
	}
	ctx.ui.notify(result.message, "info");
	ctx.shutdown();
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("delete", {
		description: "Delete the current Pi session or current in-file branch, then exit Pi",
		handler: async (_args, ctx) => deleteAndExit(ctx, false),
	});

	pi.registerCommand("dlt", {
		description: "Delete the current Pi session or branch, then close the tmux window",
		handler: async (_args, ctx) => deleteAndExit(ctx, true),
	});

	pi.registerCommand("deleted", {
		description: "Alias for /dlt: delete current session or branch, then close tmux window",
		handler: async (_args, ctx) => deleteAndExit(ctx, true),
	});
}

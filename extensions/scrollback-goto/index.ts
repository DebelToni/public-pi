import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, getKeybindings, Input, SelectList, Text, type SelectItem } from "@earendil-works/pi-tui";

const MAX_CAPTURE_BYTES = 512 * 1024 * 1024;
const MAX_LABEL_WIDTH = 140;
const MATERIALIZED_MARKER_ENTRY_TYPE = "scrollback-goto-marker";
const MIN_ANCHOR_CHARS = 3;
const RENDER_TIMEOUT_MS = 120_000;

type GotoTarget = {
	id: string;
	label: string;
	scrollPosition: number;
	anchor: string;
};

export type MaterializedBranch = {
	entries: readonly any[];
	entryCount: number;
	userMessageCount: number;
	endMarker: string;
};

type NativeTranscriptUI = {
	appendSessionEntriesToTranscript(
		entries: readonly any[],
		options?: { expanded?: boolean; showThinking?: boolean },
	): void;
};

function clean(text: string) {
	return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, max = MAX_LABEL_WIDTH) {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function sanitizeTerminalText(text: string) {
	return text.replace(/\r/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}

function textOfContent(content: unknown) {
	if (typeof content === "string") return sanitizeTerminalText(content);
	if (!Array.isArray(content)) return "";
	return content
		.map((part: any) => {
			if (typeof part === "string") return sanitizeTerminalText(part);
			if (part?.type === "text") return sanitizeTerminalText(part.text ?? "");
			if (part?.type === "image") return `[image: ${part.mimeType ?? part.mediaType ?? "unknown"}]`;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function markerEntry(token: string, suffix: string, text: string) {
	return {
		type: "custom",
		id: `goto-${token}-${suffix}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		customType: MATERIALIZED_MARKER_ENTRY_TYPE,
		data: { text },
	};
}

export function materializeBranch(entries: readonly any[], token = randomUUID().slice(0, 8)): MaterializedBranch {
	const materializedEntries = [markerEntry(token, "start", `GOTOSTART:${token}`)];
	let userEntryIndex = 0;
	let userMessageCount = 0;

	for (const entry of entries) {
		if (
			entry?.type === "custom" &&
			(entry.customType === MATERIALIZED_MARKER_ENTRY_TYPE || entry.customType === "scrollback-goto-full-branch")
		) {
			continue;
		}
		if (entry?.type === "message" && entry.message?.role === "user") {
			userEntryIndex++;
			const text = textOfContent(entry.message.content);
			if (clean(text)) {
				userMessageCount++;
				materializedEntries.push(
					markerEntry(token, `user-${userEntryIndex}`, `USER #${userEntryIndex} · ${entry.id}`),
				);
			}
		}
		materializedEntries.push(entry);
	}

	const endMarker = `GOTOEND:${token}`;
	materializedEntries.push(markerEntry(token, "end", endMarker));
	return {
		entries: materializedEntries,
		entryCount: entries.length,
		userMessageCount,
		endMarker,
	};
}

function candidateAnchors(text: string) {
	const anchors = [];
	for (const rawLine of text.split(/\r?\n/)) {
		const line = clean(rawLine);
		if (line.length >= MIN_ANCHOR_CHARS) anchors.push(line.slice(0, 90));
		if (anchors.length >= 4) break;
	}
	const full = clean(text);
	if (!anchors.length && full.length >= MIN_ANCHOR_CHARS) anchors.push(full.slice(0, 90));
	return anchors;
}

function tmuxTarget() {
	return process.env.TMUX_PANE;
}

function tmuxOutput(args: string[]) {
	return execFileSync("tmux", args, { encoding: "utf8", maxBuffer: MAX_CAPTURE_BYTES });
}

function capturePane(pane: string) {
	return tmuxOutput(["capture-pane", "-t", pane, "-p", "-S", "-", "-E", "-"]).split(/\r?\n/);
}

function paneNumber(pane: string, format: string, fallback: number) {
	const raw = tmuxOutput(["display-message", "-t", pane, "-p", format]).trim();
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function paneHeight(pane: string) {
	return paneNumber(pane, "#{pane_height}", 30);
}

function paneHistoryLimit(pane: string) {
	return paneNumber(pane, "#{history_limit}", 20_000);
}

async function waitForMarker(pane: string, marker: string) {
	const deadline = Date.now() + RENDER_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const tail = tmuxOutput(["capture-pane", "-t", pane, "-p", "-S", "-100", "-E", "-"]);
		if (tail.includes(marker)) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`Full-branch rendering did not finish within ${RENDER_TIMEOUT_MS / 1000}s.`);
}

function findAnchorLine(lines: string[], anchors: string[], beforeLine: number) {
	for (let i = Math.min(beforeLine, lines.length - 1); i >= 0; i--) {
		const line = clean(lines[i] ?? "");
		if (!line) continue;
		if (anchors.some((anchor) => line.includes(anchor) || anchor.includes(line))) return i;
	}
	return undefined;
}

function userMessages(ctx: ExtensionContext) {
	return ctx.sessionManager.getBranch()
		.filter((entry: any) => entry?.type === "message" && entry.message?.role === "user")
		.map((entry: any, index: number) => ({
			id: entry.id as string,
			index: index + 1,
			text: textOfContent(entry.message?.content),
		}));
}

function buildTargets(ctx: ExtensionContext) {
	const pane = tmuxTarget();
	if (!process.env.TMUX || !pane) throw new Error("/goto only works inside tmux.");

	const messages = userMessages(ctx).filter((message) => clean(message.text));
	const lines = capturePane(pane);
	const height = paneHeight(pane);
	const targets: GotoTarget[] = [];
	let beforeLine = lines.length - 1;

	for (const message of [...messages].reverse()) {
		const anchors = candidateAnchors(message.text);
		if (!anchors.length) continue;
		const materializedAnchor = `USER #${message.index} · ${message.id}`;
		const materializedLine = findAnchorLine(lines, [materializedAnchor], beforeLine);
		const lineIndex = materializedLine ?? findAnchorLine(lines, anchors, beforeLine);
		if (lineIndex === undefined) continue;
		beforeLine = lineIndex - 1;
		const scrollPosition = Math.max(0, lines.length - 1 - lineIndex - Math.floor(height / 3));
		const label = `#${message.index}  ${truncate(clean(message.text))}`;
		targets.push({
			id: String(message.index),
			label,
			scrollPosition,
			anchor: materializedLine === undefined ? anchors[0]! : materializedAnchor,
		});
	}

	return targets.reverse();
}

function scrollTmuxTo(target: GotoTarget) {
	const pane = tmuxTarget();
	if (!pane) return;
	execFileSync("tmux", ["copy-mode", "-t", pane], { stdio: "ignore" });
	execFileSync("tmux", ["send-keys", "-t", pane, "-X", "goto-line", String(target.scrollPosition)], { stdio: "ignore" });
	try {
		execFileSync("tmux", ["send-keys", "-t", pane, "-X", "search-backward", "--", target.anchor], { stdio: "ignore" });
	} catch {}
}

async function pickTarget(ctx: ExtensionContext, targets: GotoTarget[]) {
	return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		const searchInput = new Input();
		const kb = getKeybindings();
		const listTheme = {
			selectedPrefix: (text: string) => theme.fg("accent", text),
			selectedText: (text: string) => theme.fg("accent", text),
			description: (text: string) => theme.fg("muted", text),
			scrollInfo: (text: string) => theme.fg("dim", text),
			noMatch: (text: string) => theme.fg("warning", text),
		};
		const toItem = (target: GotoTarget): SelectItem => ({ value: target.id, label: target.label });
		const visibleTargets = () => {
			const query = searchInput.getValue().trim();
			return query ? fuzzyFilter(targets, query, (target) => `${target.label} ${target.anchor}`) : targets;
		};
		const makeList = () => {
			const currentTargets = visibleTargets();
			const maxVisible = Math.max(5, Math.min(currentTargets.length || 1, tui.terminal.rows - 8));
			const next = new SelectList(currentTargets.map(toItem), maxVisible, listTheme, { minPrimaryColumnWidth: MAX_LABEL_WIDTH, maxPrimaryColumnWidth: MAX_LABEL_WIDTH });
			next.setSelectedIndex(searchInput.getValue().trim() ? 0 : currentTargets.length - 1);
			next.onSelect = (item) => done(item.value);
			next.onCancel = () => done(undefined);
			return next;
		};
		let list = makeList();
		return {
			render(width: number) {
				const inputLines = searchInput.render(Math.max(10, width - 10));
				return [
					theme.fg("accent", theme.bold("Scrollback goto: user prompts")),
					...inputLines.map((line) => `${theme.fg("muted", "Search: ")}${line}`),
					...list.render(width),
					theme.fg("dim", "type fuzzy search · ↑/↓ choose · Enter jump · Esc cancel"),
				];
			},
			invalidate() {
				list.invalidate();
			},
			handleInput(data: string) {
				if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down") || kb.matches(data, "tui.select.confirm") || kb.matches(data, "tui.select.cancel")) {
					list.handleInput(data);
					tui.requestRender();
					return;
				}
				const before = searchInput.getValue();
				searchInput.handleInput(data);
				if (searchInput.getValue() !== before) list = makeList();
				tui.requestRender();
			},
		};
	});
}

async function showGotoMenu(ctx: ExtensionContext) {
	let targets: GotoTarget[];
	try {
		targets = buildTargets(ctx);
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
		return;
	}
	if (!targets.length) {
		ctx.ui.notify("No current-branch user prompts found in tmux scrollback.", "warning");
		return;
	}

	const picked = await pickTarget(ctx, targets);
	if (!picked) return;
	const target = targets.find((candidate) => candidate.id === picked);
	if (!target) return;
	scrollTmuxTo(target);
}

async function materializeAndShowGoto(ctx: ExtensionCommandContext) {
	const pane = tmuxTarget();
	if (ctx.mode !== "tui" || !process.env.TMUX || !pane) {
		ctx.ui.notify("/goto-all only works in Pi's interactive TUI inside tmux.", "warning");
		return;
	}

	await ctx.waitForIdle();
	ctx.ui.setStatus("scrollback-goto", "materializing full active branch into tmux…");
	try {
		const token = randomUUID().slice(0, 8);
		const snapshot = materializeBranch(ctx.sessionManager.getBranch(), token);
		const transcriptUI = ctx.ui as unknown as Partial<NativeTranscriptUI>;
		if (typeof transcriptUI.appendSessionEntriesToTranscript !== "function") {
			throw new Error("Restart Pi once to enable native /goto-all transcript rendering.");
		}
		transcriptUI.appendSessionEntriesToTranscript(snapshot.entries, {
			expanded: true,
			showThinking: true,
		});
		await waitForMarker(pane, snapshot.endMarker);

		const targets = buildTargets(ctx);
		if (targets.length < snapshot.userMessageCount) {
			ctx.ui.notify(
				`tmux retained ${targets.length}/${snapshot.userMessageCount} user prompts; this pane's fixed history limit is ${paneHistoryLimit(pane).toLocaleString()}. Create a new pane/window after reloading the 1,000,000-line tmux setting, then run /goto-all again.`,
				"warning",
			);
		}
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
		return;
	} finally {
		ctx.ui.setStatus("scrollback-goto", undefined);
	}

	await showGotoMenu(ctx);
}

export default function (pi: ExtensionAPI) {
	pi.registerEntryRenderer(MATERIALIZED_MARKER_ENTRY_TYPE, (entry, _options, theme) => {
		const text = (entry.data as { text?: string } | undefined)?.text;
		if (!text) return undefined;
		return new Text(theme.fg("dim", text), 1, 0);
	});

	pi.registerCommand("goto", {
		description: "Open a menu of user prompts and jump tmux scrollback to the selected one",
		handler: async (_args, ctx) => showGotoMenu(ctx),
	});

	pi.registerCommand("goto-all", {
		description: "Render the full active branch natively into tmux scrollback, then open goto",
		handler: async (_args, ctx) => materializeAndShowGoto(ctx),
	});

	pi.registerShortcut("alt+g", {
		description: "Open scrollback goto menu",
		handler: async (ctx) => showGotoMenu(ctx),
	});
}

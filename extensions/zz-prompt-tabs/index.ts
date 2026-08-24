import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	ONE_SHOT_MEDIUM_FAST_CHANNEL,
	supportsOneShotMediumFast,
	type OneShotMediumFastRequest,
} from "../lib/one-shot-medium-fast.js";
import { DurablePromptTabsStore } from "./durable-state.ts";
import { QueuedDraftTracker } from "./queue-tracker.ts";
import { TabbedEditor, type DraftTabsSnapshot } from "./tabbed-editor.ts";

const FOOTER_CHANNEL = "prompt-tabs:footer";
const RELOAD_SNAPSHOTS = Symbol.for("pi.prompt-tabs.reload-snapshots");
type ReloadSnapshotRecord = { sessionFile: string; snapshot: DraftTabsSnapshot };
type ReloadSnapshotValue = DraftTabsSnapshot | ReloadSnapshotRecord;
const globalState = globalThis as typeof globalThis & { [key: symbol]: unknown };
const reloadSnapshots = globalState[RELOAD_SNAPSHOTS] instanceof Map
	? globalState[RELOAD_SNAPSHOTS] as Map<string, ReloadSnapshotValue>
	: new Map<string, ReloadSnapshotValue>();
globalState[RELOAD_SNAPSHOTS] = reloadSnapshots;

function compatibleEditor(value: unknown): value is CustomEditor {
	if (!value || typeof value !== "object") return false;
	const editor = value as Partial<CustomEditor>;
	return editor.actionHandlers instanceof Map
		&& typeof editor.getExpandedText === "function"
		&& typeof editor.getLines === "function"
		&& typeof editor.getCursor === "function"
		&& typeof editor.setPaddingX === "function"
		&& typeof editor.setAutocompleteMaxVisible === "function"
		&& typeof editor.isShowingAutocomplete === "function";
}

function userText(message: AgentMessage) {
	if (message.role !== "user") return undefined;
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function hasMeaningfulDraftState(snapshot: DraftTabsSnapshot) {
	return snapshot.texts.some((text) => text.trim() !== "");
}

function hasMessages(ctx: { sessionManager: { getEntries: () => Array<{ type: string }> } }) {
	return ctx.sessionManager.getEntries().some((entry) => entry.type === "message");
}

function discardEmptySession(
	ctx: { sessionManager: { getSessionFile: () => string | undefined; getEntries: () => Array<{ type: string }> } },
	store: DurablePromptTabsStore | undefined,
	snapshot: DraftTabsSnapshot | undefined,
) {
	if (hasMessages(ctx) || (snapshot && hasMeaningfulDraftState(snapshot))) return;
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (sessionFile && existsSync(sessionFile)) unlinkSync(sessionFile);
	store?.discard();
}

function reloadSnapshotFor(value: ReloadSnapshotValue | undefined, sessionFile: string | undefined) {
	if (!value || !("snapshot" in value)) return value;
	if (!sessionFile || resolve(value.sessionFile) !== resolve(sessionFile)) return undefined;
	return value.snapshot;
}

export default function (pi: ExtensionAPI) {
	const queuedDrafts = new QueuedDraftTracker();
	let editor: TabbedEditor | undefined;
	let persistCurrent: ((snapshot: DraftTabsSnapshot) => void) | undefined;
	let store: DurablePromptTabsStore | undefined;
	let sessionFile: string | undefined;
	let sessionId: string | undefined;

	pi.on("session_start", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		queuedDrafts.reset();
		pi.events.emit(FOOTER_CHANNEL, undefined);
		sessionId = ctx.sessionManager.getSessionId();
		sessionFile = ctx.sessionManager.getSessionFile();
		store = sessionFile ? new DurablePromptTabsStore(sessionId, sessionFile) : undefined;
		const reportedIssues = new Set<string>();
		let sessionMaterialized = sessionFile ? existsSync(sessionFile) : false;
		let durableSnapshot: DraftTabsSnapshot | undefined;

		const reportOnce = (message: string, level: "warning" | "error") => {
			if (reportedIssues.has(message)) return;
			reportedIssues.add(message);
			ctx.ui.notify(message, level);
		};
		if (store) {
			try {
				const loaded = store.load();
				durableSnapshot = loaded.snapshot;
				for (const diagnostic of loaded.diagnostics) reportOnce(diagnostic, "warning");
			} catch (error) {
				reportOnce(`Could not load prompt-tab state: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		}

		const persist = (snapshot: DraftTabsSnapshot) => {
			if (!store) return;
			if (sessionFile && !sessionMaterialized && hasMeaningfulDraftState(snapshot)) {
				const manager = ctx.sessionManager as typeof ctx.sessionManager & { flushPendingEntries?: () => void };
				try {
					if (!manager.flushPendingEntries) throw new Error("this Pi runtime lacks flushPendingEntries()");
					manager.flushPendingEntries();
					sessionMaterialized = existsSync(sessionFile);
				} catch (error) {
					reportOnce(`Could not materialize the session for prompt-tab recovery: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
			}
			try {
				store.save(snapshot);
			} catch (error) {
				reportOnce(`Could not persist prompt tabs: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		};
		persistCurrent = persist;

		const reloadSnapshot = event.reason === "reload"
			? reloadSnapshotFor(reloadSnapshots.get(sessionId), sessionFile)
			: undefined;
		const snapshot = reloadSnapshot ?? durableSnapshot;
		reloadSnapshots.delete(sessionId);
		const previousEditor = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
			editor = new TabbedEditor(tui, editorTheme, keybindings, {
				createEditor: () => {
					const previous = previousEditor?.(tui, editorTheme, keybindings);
					return compatibleEditor(previous) ? previous : new CustomEditor(tui, editorTheme, keybindings);
				},
				isIdle: () => ctx.isIdle(),
				recall: (actualQueuedText) => queuedDrafts.recall(actualQueuedText),
				onFooterChange: (text) => pi.events.emit(FOOTER_CHANNEL, text),
				onStateChange: persist,
				onSubmitError: (error) => {
					pi.events.emit(ONE_SHOT_MEDIUM_FAST_CHANNEL, { action: "cancel" } satisfies OneShotMediumFastRequest);
					ctx.ui.notify(`Prompt submission failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				},
			});
			if (snapshot) editor.restoreSnapshot(snapshot);
			persist(editor.getSnapshot());
			return editor;
		});
	});

	pi.on("session_shutdown", (event, ctx) => {
		const finalSnapshot = editor?.getSnapshot();
		if (finalSnapshot) persistCurrent?.(finalSnapshot);
		try {
			discardEmptySession(ctx, store, finalSnapshot);
		} catch (error) {
			ctx.ui.notify(`Could not discard empty session: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
		if (sessionId) {
			if (event.reason === "reload" && editor && sessionFile && finalSnapshot && hasMeaningfulDraftState(finalSnapshot)) {
				reloadSnapshots.set(sessionId, { sessionFile, snapshot: finalSnapshot });
			} else reloadSnapshots.delete(sessionId);
		}
		pi.events.emit(FOOTER_CHANNEL, undefined);
		editor = undefined;
		persistCurrent = undefined;
		store = undefined;
		sessionFile = undefined;
		sessionId = undefined;
		queuedDrafts.reset();
	});

	// zz-prompt-tabs loads after the other user extensions, so this records the
	// final chained input text only when Pi actually accepts it for queueing.
	pi.on("input", (event) => {
		if (event.source === "interactive" && event.streamingBehavior) {
			queuedDrafts.track(event.text, event.streamingBehavior);
		}
	});

	pi.on("message_start", (event) => {
		const text = userText(event.message);
		if (text !== undefined) queuedDrafts.consume(text);
	});

	pi.registerShortcut("alt+t", {
		description: "Create a new prompt tab",
		handler: () => editor?.newDraft(),
	});

	pi.registerShortcut("alt+w", {
		description: "Close the current prompt tab",
		handler: () => editor?.closeCurrentDraft(),
	});

	pi.registerShortcut("ctrl+f", {
		description: "Submit once with medium reasoning and fast mode",
		handler: (ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Ctrl+F is available only while the agent is idle.", "warning");
				return;
			}
			const text = editor?.getExpandedText().trim();
			if (!text) return;
			if (!supportsOneShotMediumFast(ctx.model)) {
				ctx.ui.notify("Ctrl+F requires a reasoning-capable OpenAI/Codex Responses model.", "warning");
				return;
			}
			if (text.startsWith("!")) {
				ctx.ui.notify("Ctrl+F sends prompts, not shell commands.", "warning");
				return;
			}
			if (text.startsWith("/")) {
				const commandName = text.slice(1).split(/\s/, 1)[0];
				const command = pi.getCommands().find((candidate) => candidate.name === commandName);
				if (!command || command.source === "extension") {
					ctx.ui.notify("Ctrl+F sends prompts, prompt templates, and skills—not application commands.", "warning");
					return;
				}
			}
			const request: OneShotMediumFastRequest = { action: "arm" };
			pi.events.emit(ONE_SHOT_MEDIUM_FAST_CHANNEL, request);
			if (!request.accepted) {
				ctx.ui.notify("The one-shot medium/fast request handler is unavailable.", "error");
				return;
			}
			try {
				if (!editor?.submitCurrentDraft()) {
					pi.events.emit(ONE_SHOT_MEDIUM_FAST_CHANNEL, { action: "cancel" } satisfies OneShotMediumFastRequest);
				}
			} catch (error) {
				pi.events.emit(ONE_SHOT_MEDIUM_FAST_CHANNEL, { action: "cancel" } satisfies OneShotMediumFastRequest);
				throw error;
			}
		},
	});

	pi.registerShortcut("alt+[", {
		description: "Switch to the previous prompt tab",
		handler: () => editor?.previousDraft(),
	});

	pi.registerShortcut("alt+]", {
		description: "Switch to the next prompt tab",
		handler: () => editor?.nextDraft(),
	});
}

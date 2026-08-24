import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import type { ExtensionAPI, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import promptTabsExtension from "./index.ts";
import { TabbedEditor } from "./tabbed-editor.ts";

type Handler = (event: any, context: any) => unknown;

function extensionHarness() {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on(name: string, handler: Handler) {
			const current = handlers.get(name) ?? [];
			current.push(handler);
			handlers.set(name, current);
		},
		events: { emit() {} },
		registerShortcut() {},
		getCommands() { return []; },
	} as unknown as ExtensionAPI;
	promptTabsExtension(pi);
	return {
		emit(name: string, event: unknown, context: unknown) {
			for (const handler of handlers.get(name) ?? []) handler(event, context);
		},
	};
}

function context(sessionId: string, sessionFile: string, materialize: () => void, entries: Array<{ type: string }> = []) {
	let editor: TabbedEditor | undefined;
	const notifications: string[] = [];
	const tui = {
		terminal: { rows: 40 },
		requestRender() {},
	} as unknown as TUI;
	const identity = (text: string) => text;
	const theme: EditorTheme = {
		borderColor: identity,
		selectList: {
			selectedPrefix: identity,
			selectedText: identity,
			description: identity,
			scrollInfo: identity,
			noMatch: identity,
		},
	};
	const keybindings = {
		matches() { return false; },
		getKeys() { return []; },
	} as unknown as KeybindingsManager;
	const ctx = {
		mode: "tui",
		isIdle: () => true,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => sessionFile,
			getEntries: () => entries,
			flushPendingEntries: materialize,
		},
		ui: {
			getEditorComponent: () => undefined,
			setEditorComponent(factory: (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => TabbedEditor) {
				editor = factory(tui, theme, keybindings);
				// Pi transfers the prior core-editor value after constructing a custom editor.
				editor.setText("");
			},
			notify(message: string) { notifications.push(message); },
		},
	};
	return {
		ctx,
		notifications,
		get editor() {
			assert.ok(editor);
			return editor;
		},
	};
}

test("clean shutdown discards a session with no messages and no drafted prompt", (t) => {
	const agentDir = mkdtempSync("/tmp/pi-prompt-tabs-empty-");
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	});
	const sessionFile = join(agentDir, "sessions", "empty.jsonl");
	mkdirSync(dirname(sessionFile), { recursive: true });
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "empty-session", timestamp: new Date(0).toISOString(), cwd: "/tmp" })}\n${JSON.stringify({ type: "model_change", id: "model", timestamp: new Date(0).toISOString(), provider: "codex-pi1", modelId: "gpt-5.6-sol" })}\n`);
	const extension = extensionHarness();
	const current = context("empty-session", sessionFile, () => {}, [{ type: "session" }, { type: "model_change" }]);
	extension.emit("session_start", { type: "session_start", reason: "startup" }, current.ctx);
	extension.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, current.ctx);
	assert.equal(existsSync(sessionFile), false);
});

test("a non-empty drafted prompt keeps a message-free session", (t) => {
	const agentDir = mkdtempSync("/tmp/pi-prompt-tabs-draft-");
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	});
	const sessionFile = join(agentDir, "sessions", "draft.jsonl");
	mkdirSync(dirname(sessionFile), { recursive: true });
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "draft-session", timestamp: new Date(0).toISOString(), cwd: "/tmp" })}\n`);
	const extension = extensionHarness();
	const current = context("draft-session", sessionFile, () => {});
	extension.emit("session_start", { type: "session_start", reason: "startup" }, current.ctx);
	current.editor.setText("keep this draft");
	extension.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, current.ctx);
	assert.equal(existsSync(sessionFile), true);
});

test("/reload preserves all tabs through the in-process handoff", (t) => {
	const agentDir = mkdtempSync("/tmp/pi-prompt-tabs-reload-");
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	});

	const sessionId = "reload-session";
	const sessionFile = join(agentDir, "sessions", "reload.jsonl");
	mkdirSync(dirname(sessionFile), { recursive: true });
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date(0).toISOString(), cwd: "/tmp" })}\n`);
	const firstExtension = extensionHarness();
	const first = context(sessionId, sessionFile, () => {});
	firstExtension.emit("session_start", { type: "session_start", reason: "startup" }, first.ctx);
	first.editor.setText("one");
	first.editor.newDraft("two");
	first.editor.newDraft();
	firstExtension.emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, first.ctx);
	// Prove restoration comes from the reload handoff rather than the sidecar.
	rmSync(join(agentDir, "prompt-tabs"), { recursive: true, force: true });

	const reloadedExtension = extensionHarness();
	const reloaded = context(sessionId, sessionFile, () => {});
	reloadedExtension.emit("session_start", { type: "session_start", reason: "reload" }, reloaded.ctx);
	assert.deepEqual(reloaded.editor.getSnapshot(), { texts: ["one", "two", ""], activeIndex: 2 });
});

test("a deferred first-session draft materializes and restores after abrupt teardown", (t) => {
	const agentDir = mkdtempSync("/tmp/pi-prompt-tabs-index-");
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	});

	const sessionId = "deferred-session";
	const sessionFile = join(agentDir, "sessions", "deferred.jsonl");
	let materializations = 0;
	const materialize = () => {
		materializations++;
		mkdirSync(dirname(sessionFile), { recursive: true });
		writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date(0).toISOString(), cwd: "/tmp" })}\n`);
	};

	const firstExtension = extensionHarness();
	const first = context(sessionId, sessionFile, materialize);
	firstExtension.emit("session_start", { type: "session_start", reason: "startup" }, first.ctx);
	first.editor.setText("survive SIGKILL");
	first.editor.newDraft();
	assert.equal(materializations, 1);
	assert.deepEqual(first.editor.getSnapshot(), { texts: ["survive SIGKILL", ""], activeIndex: 1 });

	// No session_shutdown event: construct a fresh extension as a replacement process.
	const restartedExtension = extensionHarness();
	const restarted = context(sessionId, sessionFile, materialize);
	restartedExtension.emit("session_start", { type: "session_start", reason: "startup" }, restarted.ctx);
	assert.deepEqual(restarted.editor.getSnapshot(), { texts: ["survive SIGKILL", ""], activeIndex: 1 });
	assert.deepEqual(restarted.notifications, []);
});

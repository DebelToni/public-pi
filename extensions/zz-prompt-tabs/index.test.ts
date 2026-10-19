import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { DurablePromptTabsStore } from "./durable-state.ts";
import type { ExtensionAPI, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import promptTabsExtension from "./index.ts";
import { TabbedEditor } from "./tabbed-editor.ts";

type Handler = (event: any, context: any) => unknown;

function extensionHarness() {
	const handlers = new Map<string, Handler[]>();
	const channels = new Map<string, Array<(request: any) => void>>();
	const shortcuts = new Map<string, { handler: (context: any) => unknown }>();
	const pi = {
		on(name: string, handler: Handler) {
			const current = handlers.get(name) ?? [];
			current.push(handler);
			handlers.set(name, current);
		},
		events: {
			on(name: string, handler: (request: any) => void) {
				channels.set(name, [...(channels.get(name) ?? []), handler]);
				return () => {};
			},
			emit(name: string, request: any) { for (const handler of channels.get(name) ?? []) handler(request); },
		},
		registerShortcut(key: string, shortcut: { handler: (context: any) => unknown }) {
			shortcuts.set(key, shortcut);
		},
		getCommands() { return []; },
	} as unknown as ExtensionAPI;
	promptTabsExtension(pi);
	return {
		channel(name: string, request: any) { pi.events.emit(name, request); return request; },
		emit(name: string, event: unknown, context: unknown) {
			for (const handler of handlers.get(name) ?? []) handler(event, context);
		},
		invokeShortcut(key: string, context: unknown) {
			const shortcut = shortcuts.get(key);
			assert.ok(shortcut, `shortcut ${key} was not registered`);
			return shortcut.handler(context);
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
		matches(data: string, action: string) { return data === "CLEAR" && action === "app.clear" || data === "DEQUEUE" && action === "app.message.dequeue"; },
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
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "empty-session", timestamp: new Date(0).toISOString(), cwd: "/tmp" })}\n${JSON.stringify({ type: "model_change", id: "model", timestamp: new Date(0).toISOString(), provider: "codex-pi1", modelId: "gpt-6-sol" })}\n`);
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

test("a Ctrl+C-preserved prompt restores after Pi quits", (t) => {
	const agentDir = mkdtempSync("/tmp/pi-prompt-tabs-ctrl-c-");
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	});

	const sessionId = "ctrl-c-session";
	const sessionFile = join(agentDir, "sessions", "ctrl-c.jsonl");
	mkdirSync(dirname(sessionFile), { recursive: true });
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date(0).toISOString(), cwd: "/tmp" })}\n`);
	const firstExtension = extensionHarness();
	const first = context(sessionId, sessionFile, () => {});
	firstExtension.emit("session_start", { type: "session_start", reason: "startup" }, first.ctx);
	first.editor.onAction("app.clear", () => first.editor.setText(""));
	first.editor.setText("restore this after reopening Pi");
	first.editor.handleInput("CLEAR");
	assert.equal(first.editor.getText(), "restore this after reopening Pi");
	firstExtension.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, first.ctx);

	const restartedExtension = extensionHarness();
	const restarted = context(sessionId, sessionFile, () => {});
	restartedExtension.emit("session_start", { type: "session_start", reason: "startup" }, restarted.ctx);
	assert.deepEqual(restarted.editor.getSnapshot(), {
		texts: ["restore this after reopening Pi"],
		activeIndex: 0,
	});
});

test("Alt+Shift+T restores a closed tab after restarting a session with messages", (t) => {
	const agentDir = mkdtempSync("/tmp/pi-prompt-tabs-closed-");
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	});

	const sessionId = "closed-tab-session";
	const sessionFile = join(agentDir, "sessions", "closed-tab.jsonl");
	mkdirSync(dirname(sessionFile), { recursive: true });
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date(0).toISOString(), cwd: "/tmp" })}\n`);
	const firstExtension = extensionHarness();
	const first = context(sessionId, sessionFile, () => {}, [{ type: "message" }]);
	firstExtension.emit("session_start", { type: "session_start", reason: "startup" }, first.ctx);
	first.editor.setText("restore this exact\nmultiline prompt");
	firstExtension.invokeShortcut("alt+w", first.ctx);
	assert.deepEqual(first.editor.getSnapshot(), { texts: [""], activeIndex: 0 });
	assert.deepEqual(first.editor.getClosedTabs().map((tab) => tab.text), ["restore this exact\nmultiline prompt"]);
	firstExtension.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, first.ctx);
	assert.equal(existsSync(sessionFile), true);

	const restartedExtension = extensionHarness();
	const restarted = context(sessionId, sessionFile, () => {});
	restartedExtension.emit("session_start", { type: "session_start", reason: "startup" }, restarted.ctx);
	assert.deepEqual(restarted.editor.getClosedTabs().map((tab) => tab.text), ["restore this exact\nmultiline prompt"]);
	restartedExtension.invokeShortcut("alt+shift+t", restarted.ctx);
	assert.deepEqual(restarted.editor.getSnapshot(), {
		texts: ["restore this exact\nmultiline prompt"],
		activeIndex: 0,
	});
	assert.deepEqual(restarted.editor.getClosedTabs(), []);
});

for (const method of ["close", "backspace", "mixed", "reload", "remaining-draft"] as const) {
	test(`empty message-free session cleanup: ${method}`, (t) => {
		const agentDir = mkdtempSync(join(homedir(), "tmp/pi-tabs-cleanup-"));
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		t.after(() => {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			rmSync(agentDir, { recursive: true, force: true });
		});
		const sessionId = `cleanup-${method}`;
		const sessionFile = join(agentDir, "session.jsonl");
		const extension = extensionHarness();
		const current = context(sessionId, sessionFile, () => writeFileSync(sessionFile, "{}\n"));
		extension.emit("session_start", { reason: "startup" }, current.ctx);
		current.editor.setText("one");
		current.editor.newDraft("two");
		assert.equal(existsSync(sessionFile), true);
		if (method === "backspace") {
			for (let i = 0; i < 3; i++) current.editor.handleInput("\x7f");
			assert.equal(current.editor.getText(), "");
			extension.invokeShortcut("alt+w", current.ctx);
			for (let i = 0; i < 3; i++) current.editor.handleInput("\x7f");
		} else {
			extension.invokeShortcut("alt+w", current.ctx);
			if (method === "mixed") {
				for (let i = 0; i < 3; i++) current.editor.handleInput("\x7f");
			} else if (method !== "remaining-draft") extension.invokeShortcut("alt+w", current.ctx);
		}
		const keep = method === "reload" || method === "remaining-draft";
		if (method !== "remaining-draft") assert.ok(current.editor.getSnapshot().texts.every((text) => text === ""));
		extension.emit("session_shutdown", { reason: method === "reload" ? "reload" : "quit" }, current.ctx);
		assert.equal(existsSync(sessionFile), keep);
		const recovered = new DurablePromptTabsStore(sessionId, sessionFile).load();
		assert.equal(recovered.snapshot !== undefined, keep);
		assert.equal(recovered.closedTabs.length > 0, keep);
		if (method === "reload") {
			const next = extensionHarness();
			const reloaded = context(sessionId, sessionFile, () => {});
			next.emit("session_start", { reason: "reload" }, reloaded.ctx);
			next.invokeShortcut("alt+shift+t", reloaded.ctx);
			assert.equal(reloaded.editor.getText(), "one");
		}
	});
}

test("Alt+W refuses to hide a non-empty tab when its deferred session cannot materialize", (t) => {
	const agentDir = mkdtempSync("/tmp/pi-prompt-tabs-close-failure-");
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	});

	const sessionFile = join(agentDir, "sessions", "deferred-close.jsonl");
	const extension = extensionHarness();
	const current = context("deferred-close-session", sessionFile, () => { throw new Error("disk unavailable"); });
	extension.emit("session_start", { type: "session_start", reason: "startup" }, current.ctx);
	current.editor.setText("must remain visible");
	extension.invokeShortcut("alt+w", current.ctx);
	assert.deepEqual(current.editor.getSnapshot(), { texts: ["must remain visible"], activeIndex: 0 });
	assert.deepEqual(current.editor.getClosedTabs(), []);
	assert.equal(existsSync(sessionFile), false);
	assert.equal(current.notifications.some((message) => message.includes("Could not materialize the session")), true);
});

test("a submitted tab stays selected and empty after Pi restarts", (t) => {
	const agentDir = mkdtempSync("/tmp/pi-prompt-tabs-submit-");
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	});

	const sessionId = "submitted-tab-session";
	const sessionFile = join(agentDir, "sessions", "submitted-tab.jsonl");
	mkdirSync(dirname(sessionFile), { recursive: true });
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date(0).toISOString(), cwd: "/tmp" })}\n`);
	const firstExtension = extensionHarness();
	const first = context(sessionId, sessionFile, () => {});
	firstExtension.emit("session_start", { type: "session_start", reason: "startup" }, first.ctx);
	first.editor.onSubmit = () => {};
	first.editor.setText("keep on tab one");
	first.editor.newDraft("submit tab two");
	first.editor.handleInput("\r");
	assert.deepEqual(first.editor.getSnapshot(), { texts: ["keep on tab one", ""], activeIndex: 1 });
	firstExtension.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, first.ctx);

	const restartedExtension = extensionHarness();
	const restarted = context(sessionId, sessionFile, () => {});
	restartedExtension.emit("session_start", { type: "session_start", reason: "startup" }, restarted.ctx);
	assert.deepEqual(restarted.editor.getSnapshot(), { texts: ["keep on tab one", ""], activeIndex: 1 });
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

function recallFixture(t: any, materializeFails = false) {
	const agentDir = mkdtempSync(join(homedir(), "tmp/pi-tabs-recall-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	});
	const sessionId = "selected-recall", sessionFile = join(agentDir, "sessions/recall.jsonl");
	const materialize = () => {
		if (materializeFails) throw new Error("materialize refused");
		mkdirSync(dirname(sessionFile), { recursive: true });
		writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date(0).toISOString(), cwd: agentDir })}\n`);
	};
	if (!materializeFails) materialize();
	const extension = extensionHarness(), current = context(sessionId, sessionFile, materialize);
	extension.emit("session_start", { type: "session_start", reason: "startup" }, current.ctx);
	return { extension, current, sessionId, sessionFile };
}

test("selected recall persists a new tab before live mutation, keeping other drafts and closed undo", t => {
	const { extension, current, sessionId, sessionFile } = recallFixture(t);
	current.editor.setText("main"); current.editor.newDraft("other");
	current.editor.newDraft("closed"); current.editor.closeCurrentDraft();
	const before = current.editor.getSnapshot(), closed = current.editor.getClosedTabs();
	const save = DurablePromptTabsStore.prototype.save;
	let checked = false;
	DurablePromptTabsStore.prototype.save = function (snapshot, closedTabs) {
		if (!checked && snapshot.texts.length === before.texts.length + 1) {
			checked = true; assert.deepEqual(current.editor.getSnapshot(), before);
		}
		return save.call(this, snapshot, closedTabs);
	};
	t.after(() => { DurablePromptTabsStore.prototype.save = save; });
	const request = extension.channel("pi-web:tabs", { action: "recall", text: "selected", expected: JSON.stringify(before) });
	assert.equal(request.recalled, true); assert.equal(checked, true);
	assert.equal(request.result.recallSupported, true);
	const expected = { texts: ["main", "other", "selected"], activeIndex: 2 };
	assert.deepEqual(current.editor.getSnapshot(), expected);
	assert.deepEqual(current.editor.getClosedTabs(), closed);
	const persisted = new DurablePromptTabsStore(sessionId, sessionFile).load();
	assert.deepEqual(persisted.snapshot, expected); assert.deepEqual(persisted.closedTabs, closed);
	assert.equal(extension.channel("pi-web:tabs", { action: "recall", text: "stale", expected: JSON.stringify(before) }).recalled, undefined);
	assert.deepEqual(current.editor.getSnapshot(), expected);
});

test("failed critical persistence leaves the live drafts and durable state untouched", t => {
	const { extension, current, sessionId, sessionFile } = recallFixture(t);
	current.editor.setText("keep this");
	const before = current.editor.getSnapshot(), save = DurablePromptTabsStore.prototype.save;
	DurablePromptTabsStore.prototype.save = () => { throw new Error("disk unavailable"); };
	try {
		const request = extension.channel("pi-web:tabs", { action: "recall", text: "protected", expected: JSON.stringify(before) });
		assert.match(request.error, /remains queued/); assert.equal(request.recalled, undefined);
		assert.deepEqual(current.editor.getSnapshot(), before);
	} finally { DurablePromptTabsStore.prototype.save = save; }
	assert.deepEqual(new DurablePromptTabsStore(sessionId, sessionFile).load().snapshot, before);
});

test("failed session materialization refuses selected recall before creating a live tab", t => {
	const { extension, current } = recallFixture(t, true);
	const before = current.editor.getSnapshot();
	const request = extension.channel("pi-web:tabs", { action: "recall", text: "protected", expected: JSON.stringify(before) });
	assert.match(request.error, /remains queued/); assert.equal(request.recalled, undefined);
	assert.deepEqual(current.editor.getSnapshot(), before);
});

test("cancellation reconciliation prevents phantom skill recall and keeps remaining native prompts separate", t => {
	const { extension, current } = recallFixture(t);
	current.editor.setText("main");
	extension.emit("input", { source: "interactive", text: "/skill:cancelled", streamingBehavior: "followUp" }, current.ctx);
	extension.emit("input", { source: "extension", text: "/template:remaining", streamingBehavior: "followUp" }, current.ctx);
	extension.channel("pi-web:queue-recalled", [{ text: "expanded remaining", mode: "followUp" }, { text: "last", mode: "followUp" }]);
	current.editor.onAction("app.message.dequeue", () => current.editor.setText(`expanded remaining\n\nlast\n\n${current.editor.getText()}`));
	current.editor.handleInput("DEQUEUE");
	assert.deepEqual(current.editor.getSnapshot().texts, ["main", "expanded remaining", "last"]);
});

test("phone inputs participate in separate native bulk-recall draft tracking", t => {
	const { extension, current } = recallFixture(t);
	current.editor.setText("main");
	for (const text of ["phone one", "phone two"]) extension.emit("input", { source: "extension", text, streamingBehavior: "followUp" }, current.ctx);
	current.editor.onAction("app.message.dequeue", () => current.editor.setText(`phone one\n\nphone two\n\n${current.editor.getText()}`));
	current.editor.handleInput("DEQUEUE");
	assert.deepEqual(current.editor.getSnapshot().texts, ["main", "phone one", "phone two"]);
});

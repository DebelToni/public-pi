import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installPiPromptEditor } from "./index.ts";

function tick() {
	return new Promise<void>((resolve) => setImmediate(resolve));
}

function harness() {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-editor-test-"));
	const runtimeRoot = join(root, "runtime");
	const configPath = join(root, "config", "config.json");
	let shortcut: { handler(context: ExtensionContext): void | Promise<void> } | undefined;
	let command: { handler(args: string, context: ExtensionContext): Promise<void> } | undefined;
	const events = new Map<string, (...args: any[]) => unknown>();
	const tmuxCalls: string[][] = [];
	let paneAlive = true;
	let watchCallback: (() => void) | undefined;
	let intervalCallback: (() => void) | undefined;
	let watcherClosed = false;
	let intervalCleared = false;
	let editorText = "original prompt";
	const applied: string[] = [];
	const notifications: Array<[string, string]> = [];

	const pi = {
		registerShortcut(key: string, options: any) {
			assert.equal(key, "ctrl+g");
			shortcut = options;
		},
		registerCommand(name: string, options: any) {
			assert.equal(name, "prompt-editor");
			command = options;
		},
		on(name: string, handler: (...args: any[]) => unknown) {
			events.set(name, handler);
		},
	} as unknown as ExtensionAPI;

	const context = {
		mode: "tui",
		cwd: "/tmp/project",
		sessionManager: { getSessionId: () => "session-1" },
		ui: {
			getEditorText: () => editorText,
			setEditorText: (text: string) => { editorText = text; applied.push(text); },
			notify: (message: string, level: string) => notifications.push([message, level]),
		},
	} as unknown as ExtensionContext;

	const controller = installPiPromptEditor(pi, {
		runtimeRoot,
		configPath,
		tmuxPane: () => "%100",
		runTmux: async (args) => {
			tmuxCalls.push(args);
			if (args[0] === "split-window") return "%200";
			if (args[0] === "display-message") {
				if (!paneAlive) throw new Error("pane missing");
				return args[4] === "#{pane_id}" ? args[3]! : "%200";
			}
			return "";
		},
		watchDirectory: (_path, callback) => {
			watchCallback = callback;
			return { close: () => { watcherClosed = true; } };
		},
		setInterval: (callback) => {
			intervalCallback = callback;
			return {} as NodeJS.Timeout;
		},
		clearInterval: () => { intervalCleared = true; },
	});

	return {
		root,
		runtimeRoot,
		configPath,
		context,
		controller,
		get shortcut() { assert.ok(shortcut); return shortcut; },
		get command() { assert.ok(command); return command; },
		get watchCallback() { assert.ok(watchCallback); return watchCallback; },
		get intervalCallback() { assert.ok(intervalCallback); return intervalCallback; },
		get editorText() { return editorText; },
		set editorText(value: string) { editorText = value; },
		applied,
		notifications,
		tmuxCalls,
		setPaneAlive(value: boolean) { paneAlive = value; },
		get watcherClosed() { return watcherClosed; },
		get intervalCleared() { return intervalCleared; },
		async open() { shortcut?.handler(context); await tick(); await tick(); },
		start() { events.get("session_start")?.({}, context); },
		shutdown() { events.get("session_shutdown")?.({}, context); },
	};
}

function promptFile(runtimeRoot: string) {
	const directories = readdirSync(runtimeRoot);
	assert.equal(directories.length, 1);
	return join(runtimeRoot, directories[0]!, "prompt.md");
}

test("Ctrl+G returns immediately, opens a right pane, and preserves the Pi prompt", async () => {
	const h = harness();
	assert.equal(h.shortcut.handler(h.context), undefined);
	assert.equal(h.editorText, "original prompt");
	await tick();
	await tick();
	assert.equal(h.editorText, "original prompt");
	assert.deepEqual(h.applied, []);
	assert.equal(readFileSync(promptFile(h.runtimeRoot), "utf8"), "original prompt");
	const split = h.tmuxCalls.find((args) => args[0] === "split-window");
	assert.deepEqual(split?.slice(0, 10), [
		"split-window", "-h", "-p", "50", "-t", "%100", "-c", "/tmp/project", "-P", "-F",
	]);
	assert.match(split?.at(-1) ?? "", /^exec env PI_PROMPT_EDITOR=1 nvim -- '/);
	assert.ok(h.tmuxCalls.some((args) => args.join(" ") === "set-option -p -t %200 remain-on-exit off"));
});

test("a save overwrites the Pi prompt while the editor remains active", async () => {
	const h = harness();
	await h.open();
	writeFileSync(promptFile(h.runtimeRoot), "edited in nvim\n");
	h.watchCallback();
	await tick();
	assert.equal(h.editorText, "edited in nvim");
	assert.equal(h.controller.isActive(), true);
	assert.equal(h.watcherClosed, false);
});

test("pane exit performs a final save sync and cleans runtime state", async () => {
	const h = harness();
	await h.open();
	writeFileSync(promptFile(h.runtimeRoot), "saved by wq\n");
	h.setPaneAlive(false);
	h.intervalCallback();
	await tick();
	await tick();
	assert.equal(h.editorText, "saved by wq");
	assert.equal(h.controller.isActive(), false);
	assert.equal(h.watcherClosed, true);
	assert.equal(h.intervalCleared, true);
	assert.equal(readdirSync(h.runtimeRoot).length, 0);
});

test("killing an unsaved editor leaves the Pi prompt unchanged", async () => {
	const h = harness();
	await h.open();
	h.setPaneAlive(false);
	h.intervalCallback();
	await tick();
	await tick();
	assert.equal(h.editorText, "original prompt");
	assert.deepEqual(h.applied, []);
});

test("repeated Ctrl+G focuses the existing pane without overwriting its file", async () => {
	const h = harness();
	await h.open();
	h.editorText = "new local prompt";
	await h.open();
	assert.equal(readFileSync(promptFile(h.runtimeRoot), "utf8"), "original prompt");
	assert.ok(h.tmuxCalls.some((args) => args.join(" ") === "select-pane -t %200"));
	assert.equal(h.tmuxCalls.filter((args) => args[0] === "split-window").length, 1);
});

test("session shutdown detaches without killing Neovim or deleting its state", async () => {
	const h = harness();
	await h.open();
	const file = promptFile(h.runtimeRoot);
	h.shutdown();
	assert.equal(h.controller.isActive(), false);
	assert.equal(h.watcherClosed, true);
	assert.equal(h.intervalCleared, true);
	assert.equal(statSync(file).isFile(), true);
	assert.equal(h.tmuxCalls.some((args) => args[0] === "kill-pane"), false);
});

test("a save during reload is applied even if Neovim exits before adoption", async () => {
	const h = harness();
	await h.open();
	const file = promptFile(h.runtimeRoot);
	h.shutdown();
	writeFileSync(file, "saved during reload\n");
	h.setPaneAlive(false);
	const generation = h.controller.beginSession();
	await h.controller.adopt(h.context, generation);
	assert.equal(h.editorText, "saved during reload");
	assert.equal(readdirSync(h.runtimeRoot).length, 0);
});

test("shutdown cancels delayed adoption of an existing pane", async () => {
	const h = harness();
	await h.open();
	h.shutdown();
	h.start();
	h.shutdown();
	await tick();
	assert.equal(h.controller.isActive(), false);
});

test("the persistent switch defaults on and can be disabled", async () => {
	const h = harness();
	await h.command.handler("off", h.context);
	assert.equal(JSON.parse(readFileSync(h.configPath, "utf8")).enabled, false);
	await h.open();
	assert.equal(h.tmuxCalls.some((args) => args[0] === "split-window"), false);
	assert.match(h.notifications.at(-1)?.[0] ?? "", /prompt editor is off/i);
	await h.command.handler("on", h.context);
	assert.equal(JSON.parse(readFileSync(h.configPath, "utf8")).enabled, true);
	assert.equal(statSync(h.configPath).mode & 0o777, 0o600);
});

import assert from "node:assert/strict";
import test from "node:test";
import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { TabbedEditor } from "./tabbed-editor.ts";

function createEditor(
	makeChild?: (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => CustomEditor,
) {
	let idle = true;
	let renders = 0;
	const footerUpdates: Array<string | undefined> = [];
	const stateUpdates: Array<{ texts: string[]; activeIndex: number }> = [];
	const criticalUpdates: Array<{
		snapshot: { texts: string[]; activeIndex: number };
		closedTabs: Array<{ text: string; closedAt: number; index: number; wasOnlyTab: boolean }>;
	}> = [];
	const submissionErrors: unknown[] = [];
	let criticalStateAccepted = true;
	const tui = {
		terminal: { rows: 40 },
		requestRender: () => { renders++; },
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
		matches(data: string, action: string) {
			return (data === "FOLLOW" && action === "app.message.followUp")
				|| (data === "DEQUEUE" && action === "app.message.dequeue")
				|| (data === "ESC" && action === "app.interrupt")
				|| (data === "EXIT" && action === "app.exit")
				|| (data === "CLEAR" && action === "app.clear");
		},
		getKeys() { return []; },
	} as unknown as KeybindingsManager;
	const editor = new TabbedEditor(tui, theme, keybindings, {
		createEditor: () => makeChild?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings),
		isIdle: () => idle,
		recall: (text) => text.split("\n\n"),
		onFooterChange: (text) => footerUpdates.push(text),
		onStateChange: (snapshot) => stateUpdates.push(structuredClone(snapshot)),
		commitCriticalState: (snapshot, closedTabs) => {
			if (!criticalStateAccepted) return false;
			criticalUpdates.push({ snapshot: structuredClone(snapshot), closedTabs: structuredClone(closedTabs) });
			return true;
		},
		onSubmitError: (error) => submissionErrors.push(error),
	});
	return {
		editor,
		setIdle(value: boolean) { idle = value; },
		get renders() { return renders; },
		footerUpdates,
		stateUpdates,
		criticalUpdates,
		setCriticalStateAccepted(value: boolean) { criticalStateAccepted = value; },
		submissionErrors,
	};
}

test("external text updates repaint the terminal and publish durable draft state without another keypress", () => {
	const harness = createEditor();
	const before = harness.renders;
	harness.editor.setText("Phone draft appears immediately");
	assert.ok(harness.renders > before);
	assert.deepEqual(harness.stateUpdates.at(-1), { texts: ["Phone draft appears immediately"], activeIndex: 0 });
});

test("direct phone tab selection preserves the first subsequent text edit", () => {
	const { editor } = createEditor();
	editor.setText("first");
	editor.newDraft("second");
	editor.selectDraft(0);
	editor.setText("edited first");
	editor.selectDraft(1);
	editor.setText("edited second");
	assert.deepEqual(editor.getSnapshot(), { texts: ["edited first", "edited second"], activeIndex: 1 });
});

test("draft tabs preserve a previously configured CustomEditor", () => {
	class StyledEditor extends CustomEditor {
		override render(width: number) {
			return [...super.render(width), "CUSTOM".slice(0, width)];
		}
	}
	const { editor } = createEditor((tui, theme, keybindings) => new StyledEditor(tui, theme, keybindings));
	assert.equal(editor.render(40).at(-1), "CUSTOM");
	editor.newDraft("second");
	assert.equal(editor.render(40).at(-1), "CUSTOM");
});

test("one draft has no tab UI and editor borders are always removed", () => {
	const harness = createEditor();
	const oneDraftLines = harness.editor.render(40);
	assert.equal(oneDraftLines.some((line) => line.includes("prompts ")), false);
	assert.equal(oneDraftLines.some((line) => /^─+$/.test(line.trim())), false);
	assert.equal(harness.footerUpdates.at(-1), undefined);

	harness.editor.newDraft();
	const twoDraftLines = harness.editor.render(40);
	assert.equal(twoDraftLines.length, oneDraftLines.length);
	assert.equal(twoDraftLines.some((line) => line.includes("prompts ")), false);
	assert.match(harness.footerUpdates.at(-1) ?? "", /^prompts 2\/2  ○ 1:new prompt │ ● 2:new prompt$/);
});

test("prompt text made entirely of border characters remains visible", () => {
	const { editor } = createEditor();
	editor.setText("─".repeat(19));
	const rendered = editor.render(20).join("");
	assert.match(rendered.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""), /─{19}/);
});

test("closing the second draft clears the footer tab indicator", () => {
	const harness = createEditor();
	harness.editor.setText("keep");
	harness.editor.newDraft("close");
	harness.editor.closeCurrentDraft();
	assert.equal(harness.footerUpdates.at(-1), undefined);
});

test("drafts can be created and cycled", () => {
	const harness = createEditor();
	const { editor } = harness;
	editor.setText("first");
	editor.newDraft("second");
	editor.newDraft("third");
	assert.deepEqual(editor.getDraftTexts(), ["first", "second", "third"]);
	assert.equal(editor.getActiveIndex(), 2);
	editor.previousDraft();
	assert.equal(editor.getText(), "second");
	editor.nextDraft();
	assert.equal(editor.getText(), "third");
	assert.ok(harness.renders > 0);
});

test("legacy Option+[ and Option+] sequences switch drafts", () => {
	const { editor } = createEditor();
	editor.setText("first");
	editor.newDraft("second");
	editor.newDraft("third");
	editor.handleInput("\x1b[");
	assert.equal(editor.getText(), "second");
	editor.handleInput("\x1b]");
	assert.equal(editor.getText(), "third");
});

test("closing removes the active draft and activates its neighbor", () => {
	const harness = createEditor();
	const { editor } = harness;
	editor.setText("first");
	editor.newDraft("second");
	editor.newDraft("third");
	editor.previousDraft();
	editor.closeCurrentDraft();
	assert.deepEqual(editor.getDraftTexts(), ["first", "third"]);
	assert.equal(editor.getText(), "third");
	assert.match(harness.footerUpdates.at(-1) ?? "", /^prompts 2\/2/);
});

test("closing the sole draft archives it and keeps one empty editor tab", () => {
	const harness = createEditor();
	harness.editor.setText("discard me");
	assert.equal(harness.editor.closeCurrentDraft(), true);
	assert.deepEqual(harness.editor.getDraftTexts(), [""]);
	assert.equal(harness.editor.getClosedTabs()[0]?.text, "discard me");
	assert.equal(harness.footerUpdates.at(-1), undefined);
});

test("restoring a closed middle tab returns it to its original position and selects it", () => {
	const harness = createEditor();
	const { editor } = harness;
	editor.setText("first");
	editor.newDraft("second");
	editor.newDraft("third");
	editor.previousDraft();
	editor.closeCurrentDraft();
	assert.deepEqual(editor.getSnapshot(), { texts: ["first", "third"], activeIndex: 1 });
	assert.equal(editor.restoreClosedDraft(), true);
	assert.deepEqual(editor.getSnapshot(), { texts: ["first", "second", "third"], activeIndex: 1 });
	assert.deepEqual(editor.getClosedTabs(), []);
});

test("closed tabs restore newest first without losing older archived tabs", () => {
	const { editor } = createEditor();
	editor.setText("first");
	editor.newDraft("second");
	editor.closeCurrentDraft();
	editor.closeCurrentDraft();
	assert.deepEqual(editor.getClosedTabs().map((tab) => tab.text), ["second", "first"]);
	editor.restoreClosedDraft();
	assert.equal(editor.getText(), "first");
	assert.deepEqual(editor.getClosedTabs().map((tab) => tab.text), ["second"]);
	editor.restoreClosedDraft();
	assert.deepEqual(editor.getDraftTexts(), ["first", "second"]);
	assert.deepEqual(editor.getClosedTabs(), []);
});

test("legacy Option+Shift+T restores the newest closed tab", () => {
	const { editor } = createEditor();
	editor.setText("recover through tmux");
	editor.closeCurrentDraft();
	editor.handleInput("\x1bT");
	assert.deepEqual(editor.getSnapshot(), { texts: ["recover through tmux"], activeIndex: 0 });
	assert.deepEqual(editor.getClosedTabs(), []);
});

test("closing an empty tab does not archive it", () => {
	const { editor } = createEditor();
	editor.newDraft();
	editor.closeCurrentDraft();
	assert.deepEqual(editor.getClosedTabs(), []);
	assert.equal(editor.restoreClosedDraft(), false);
});

test("a failed archive write refuses to close the non-empty tab", () => {
	const harness = createEditor();
	harness.editor.setText("must survive");
	harness.setCriticalStateAccepted(false);
	assert.equal(harness.editor.closeCurrentDraft(), false);
	assert.deepEqual(harness.editor.getSnapshot(), { texts: ["must survive"], activeIndex: 0 });
	assert.deepEqual(harness.editor.getClosedTabs(), []);
});

test("a failed restoration write leaves the archive and open tabs unchanged", () => {
	const harness = createEditor();
	harness.editor.setText("closed prompt");
	harness.editor.closeCurrentDraft();
	harness.editor.setText("current prompt");
	harness.setCriticalStateAccepted(false);
	assert.equal(harness.editor.restoreClosedDraft(), false);
	assert.deepEqual(harness.editor.getSnapshot(), { texts: ["current prompt"], activeIndex: 0 });
	assert.deepEqual(harness.editor.getClosedTabs().map((tab) => tab.text), ["closed prompt"]);
});

test("one-shot submission keeps its selected tab and clears only that draft", () => {
	const { editor } = createEditor();
	const submitted: string[] = [];
	editor.onSubmit = (text) => submitted.push(text);
	editor.setText("keep");
	editor.newDraft("  send once  ");
	assert.equal(editor.submitCurrentDraft(), true);
	assert.deepEqual(submitted, ["send once"]);
	assert.deepEqual(editor.getDraftTexts(), ["keep", ""]);
	assert.equal(editor.getActiveIndex(), 1);
	assert.equal(editor.getText(), "");
});

test("submission persists the selected empty tab", () => {
	const harness = createEditor();
	const { editor } = harness;
	editor.onSubmit = () => {};
	editor.setText("keep");
	editor.newDraft("send");
	harness.stateUpdates.length = 0;
	editor.handleInput("\r");
	assert.deepEqual(harness.stateUpdates, [{ texts: ["keep", ""], activeIndex: 1 }]);
});

test("a synchronously failed submission restores and retains the draft", () => {
	const harness = createEditor();
	const { editor } = harness;
	editor.setText("unsent");
	harness.stateUpdates.length = 0;
	editor.onSubmit = () => { throw new Error("rejected"); };
	assert.throws(() => editor.handleInput("\r"), /rejected/);
	assert.deepEqual(editor.getSnapshot(), { texts: ["unsent"], activeIndex: 0 });
	assert.deepEqual(harness.stateUpdates, []);
});

test("an asynchronously rejected submission restores its draft without erasing later tab edits", async () => {
	const harness = createEditor();
	const { editor } = harness;
	let reject!: (error: Error) => void;
	editor.onSubmit = () => new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; });
	editor.setText("submit me");
	editor.newDraft("keep");
	editor.previousDraft();
	editor.handleInput("\r");
	assert.deepEqual(editor.getDraftTexts(), ["", "keep"]);
	editor.setText("edited while pending");
	reject(new Error("async rejection"));
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(editor.getSnapshot(), {
		texts: ["submit me", "edited while pending", "keep"],
		activeIndex: 0,
	});
	assert.match(String(harness.submissionErrors[0]), /async rejection/);
});

test("submitting a middle tab keeps its position, selection, and neighboring drafts", () => {
	const { editor } = createEditor();
	const submitted: string[] = [];
	editor.onSubmit = (text) => submitted.push(text);
	editor.setText("first");
	editor.newDraft("second");
	editor.newDraft("third");
	editor.previousDraft();
	editor.handleInput("\r");
	assert.deepEqual(submitted, ["second"]);
	assert.deepEqual(editor.getSnapshot(), { texts: ["first", "", "third"], activeIndex: 1 });
});

test("submitting tab one keeps an empty selected tab one", () => {
	const { editor } = createEditor();
	const submitted: string[] = [];
	editor.onSubmit = (text) => submitted.push(text);
	editor.setText("first");
	editor.newDraft("second");
	editor.previousDraft();
	editor.handleInput("\r");
	assert.deepEqual(submitted, ["first"]);
	assert.deepEqual(editor.getDraftTexts(), ["", "second"]);
	assert.equal(editor.getActiveIndex(), 0);
	assert.equal(editor.getText(), "");
});

test("late async editor clears stay bound to the submitted draft", async () => {
	const { editor } = createEditor();
	let release!: () => void;
	editor.onSubmit = async () => {
		await new Promise<void>((resolve) => { release = resolve; });
		editor.setText("");
	};
	editor.setText("first");
	editor.newDraft("second");
	editor.newDraft("third");
	editor.nextDraft();
	editor.handleInput("\r");
	assert.deepEqual(editor.getDraftTexts(), ["", "second", "third"]);
	editor.nextDraft();
	editor.nextDraft();
	assert.equal(editor.getText(), "third");
	release();
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(editor.getDraftTexts(), ["", "second", "third"]);
	assert.equal(editor.getText(), "third");
});

test("late async clears cannot erase a replacement sole-tab draft", async () => {
	const { editor } = createEditor();
	let release!: () => void;
	editor.onSubmit = async () => {
		await new Promise<void>((resolve) => { release = resolve; });
		editor.setText("");
	};
	editor.setText("submitted");
	editor.handleInput("\r");
	editor.setText("new prompt");
	release();
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(editor.getText(), "new prompt");
});

test("follow-up key keeps an empty selected tab while idle", () => {
	const { editor } = createEditor();
	const submitted: string[] = [];
	editor.onSubmit = (text) => submitted.push(text);
	editor.setText("keep");
	editor.newDraft("send now");
	editor.handleInput("FOLLOW");
	assert.deepEqual(submitted, ["send now"]);
	assert.deepEqual(editor.getDraftTexts(), ["keep", ""]);
	assert.equal(editor.getActiveIndex(), 1);
});

test("queued follow-up keeps an empty selected tab while busy", () => {
	const harness = createEditor();
	const { editor } = harness;
	harness.setIdle(false);
	const queued: string[] = [];
	editor.onAction("app.message.followUp", () => {
		queued.push(editor.getExpandedText());
		editor.setText("");
	});
	editor.setText("keep");
	editor.newDraft("follow up");
	editor.handleInput("FOLLOW");
	assert.deepEqual(queued, ["follow up"]);
	assert.deepEqual(editor.getDraftTexts(), ["keep", ""]);
	assert.equal(editor.getActiveIndex(), 1);
	assert.equal(editor.getText(), "");
});

test("Ctrl+C arms and then exits without clearing the active draft", () => {
	const harness = createEditor();
	const { editor } = harness;
	let clearInvocations = 0;
	let exits = 0;
	editor.onAction("app.clear", () => {
		clearInvocations++;
		if (clearInvocations === 1) editor.setText("");
		else exits++;
	});
	editor.setText("preserve this prompt");
	harness.stateUpdates.length = 0;

	editor.handleInput("CLEAR");
	assert.equal(editor.getText(), "preserve this prompt");
	assert.equal(clearInvocations, 1);
	assert.deepEqual(harness.stateUpdates, []);

	editor.handleInput("CLEAR");
	assert.equal(editor.getText(), "preserve this prompt");
	assert.equal(clearInvocations, 2);
	assert.equal(exits, 1);
	assert.deepEqual(editor.getSnapshot(), { texts: ["preserve this prompt"], activeIndex: 0 });
});

test("Ctrl+D moves to a non-empty draft instead of exiting", () => {
	const { editor } = createEditor();
	let exits = 0;
	editor.onCtrlD = () => { exits++; };
	editor.setText("unsent prompt");
	editor.newDraft();
	editor.handleInput("EXIT");
	assert.equal(exits, 0);
	assert.equal(editor.getText(), "unsent prompt");
});

test("Escape restores queued messages as tabs while aborting", () => {
	const harness = createEditor();
	const { editor } = harness;
	harness.setIdle(false);
	editor.setText("current draft");
	editor.onEscape = () => editor.setText("queued one\n\nqueued two\n\ncurrent draft");
	editor.handleInput("ESC");
	assert.deepEqual(editor.getDraftTexts(), ["current draft", "queued one", "queued two"]);
});

test("dequeue restores messages as tabs without changing the current draft", () => {
	const { editor } = createEditor();
	editor.setText("current draft");
	editor.onAction("app.message.dequeue", () => {
		editor.setText("queued one\n\nqueued two\n\ncurrent draft");
	});
	editor.handleInput("DEQUEUE");
	assert.deepEqual(editor.getDraftTexts(), ["current draft", "queued one", "queued two"]);
	assert.equal(editor.getText(), "queued two");
});

test("all drafts and the active tab survive editor reload", () => {
	const first = createEditor().editor;
	first.setText("draft one");
	first.newDraft("draft two");
	first.newDraft("draft three");
	first.previousDraft();
	const snapshot = first.getSnapshot();

	const restored = createEditor().editor;
	restored.restoreSnapshot(snapshot);
	// Pi transfers a temporary editor value after creating the replacement.
	restored.setText("");
	assert.deepEqual(restored.getDraftTexts(), ["draft one", "draft two", "draft three"]);
	assert.equal(restored.getActiveIndex(), 1);
	assert.equal(restored.getText(), "draft two");
});

test("a selected empty third tab survives editor reload without collapsing", () => {
	const first = createEditor().editor;
	first.setText("draft one");
	first.newDraft("draft two");
	first.newDraft();
	const snapshot = first.getSnapshot();

	const restored = createEditor().editor;
	restored.restoreSnapshot(snapshot);
	restored.setText("");
	assert.deepEqual(restored.getSnapshot(), {
		texts: ["draft one", "draft two", ""],
		activeIndex: 2,
	});
});

test("clearing the active buffer preserves other tabs in the persisted state", () => {
	const harness = createEditor();
	const { editor } = harness;
	editor.setText("draft one");
	editor.newDraft("draft two");
	editor.newDraft("clear me");
	harness.stateUpdates.length = 0;
	editor.setText("");
	assert.deepEqual(harness.stateUpdates.at(-1), {
		texts: ["draft one", "draft two", ""],
		activeIndex: 2,
	});
});

test("editor lines never exceed the render width", () => {
	const { editor } = createEditor();
	editor.setText("a very long first prompt that should be shortened");
	editor.newDraft("another long prompt that should be shortened too");
	for (const width of [8, 20, 60]) {
		for (const line of editor.render(width)) assert.ok(visibleWidth(line) <= width);
	}
});

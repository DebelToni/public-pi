import assert from "node:assert/strict";
import test from "node:test";
import askUserExtension from "./index.ts";
import type { QuestionnairePanel } from "./ui.ts";
import { ASK_USER_STATE_ENTRY, commitAnswer, markCompleted, markWaiting, mergeQuestionnaire } from "./state.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function theme() {
	return {
		fg(_color: string, text: string) { return text; },
		bg(_color: string, text: string) { return text; },
		bold(text: string) { return text; },
	} as any;
}

function harness(existingEntries: any[] = [], options: { delayCustom?: boolean } = {}) {
	let tool: any;
	let component: QuestionnairePanel | undefined;
	let focused = false;
	let hidden = false;
	let overlayOptions: any;
	let started = false;
	let shortcut: any;
	const entries = [...existingEntries];
	let branch = entries;
	const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
	const statuses: Array<string | undefined> = [];
	const notifications: string[] = [];
	let customCalls = 0;
	let customPending = 0;
	let releaseCustom: (() => void) | undefined;
	const tui: any = {
		terminal: { rows: 28 },
		requestRender() {},
		showOverlay(next: QuestionnairePanel, options: any) {
			component = next;
			hidden = false;
			overlayOptions = options;
			const handle = {
				hide() { hidden = true; focused = false; next.focused = false; },
				setHidden() {},
				isHidden() { return hidden; },
				focus() { focused = true; next.focused = true; },
				unfocus() { focused = false; next.focused = false; },
				isFocused() { return focused; },
				getBounds() { return undefined; },
			};
			return handle;
		},
	};
	const pi: any = {
		registerTool(definition: any) { tool = definition; },
		registerCommand() {},
		registerShortcut(_key: string, definition: any) { shortcut = definition; },
		on(name: string, handler: any) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		appendEntry(customType: string, data: unknown) {
			const entry = { type: "custom", customType, data };
			entries.push(entry);
			if (branch !== entries) branch.push(entry);
		},
	};
	askUserExtension(pi);
	const ctx: any = {
		mode: "tui",
		hasUI: true,
		ui: {
			async custom(factory: any) {
				customCalls++;
				customPending++;
				return new Promise((resolve) => {
					const done = (value: unknown) => {
						customPending--;
						releaseCustom = undefined;
						resolve(value);
					};
					factory(tui, theme(), {}, options.delayCustom
						? (value: unknown) => { releaseCustom = () => done(value); }
						: done);
				});
			},
			setStatus(_key: string, value: string | undefined) { statuses.push(value); },
			notify(message: string) { notifications.push(message); },
		},
		sessionManager: {
			getSessionId() { return "session"; },
			getBranch() { return branch; },
		},
	};
	return {
		tool: () => tool,
		ctx,
		entries,
		statuses,
		notifications,
		component: () => component!,
		componentMaybe: () => component,
		focused: () => focused,
		hidden: () => hidden,
		overlayOptions: () => overlayOptions,
		customCalls: () => customCalls,
		customPending: () => customPending,
		releaseCustom: () => releaseCustom?.(),
		shortcut: () => shortcut,
		started: () => started,
		setBranch(next: any[]) { branch = next; },
		branch: () => branch,
		emit: async (name: string, event: any = {}) => {
			if (name === "session_start") started = true;
			if (name === "session_shutdown") started = false;
			for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
		},
	};
}

async function startCall(h: ReturnType<typeof harness>, params: any, signal = new AbortController().signal) {
	if (!h.started()) await h.emit("session_start", { reason: "startup" });
	const promise = h.tool().execute("call", params, signal, undefined, h.ctx);
	await tick();
	return { promise };
}

const enter = "\r";

test("Questionnaire mounts as a non-capturing full-viewport overlay", async () => {
	const h = harness();
	const controller = new AbortController();
	const { promise } = await startCall(h, {
		questions: [{ id: "q", prompt: "Choose", options: [{ value: "a", label: "A" }] }],
	}, controller.signal);
	assert.deepEqual(h.overlayOptions(), {
		width: "100%",
		maxHeight: "100%",
		row: 0,
		col: 0,
		margin: 0,
		nonCapturing: true,
	});
	controller.abort();
	await promise;
});

test("mocked model rounds keep one panel visible while the main agent researches", async () => {
	const h = harness();
	await h.emit("session_start", { reason: "startup" });
	const { promise: first } = await startCall(h, {
		questions: [{
			id: "choice",
			prompt: "Choose",
			kind: "single",
			options: [{ value: "a", label: "A" }, { value: "b", label: "B" }, { value: "c", label: "C" }],
		}],
	});
	const firstPanel = h.component();
	assert.equal(h.focused(), true);
	firstPanel.handleInput(enter);
	firstPanel.handleInput(enter);
	const firstResult = await first;
	assert.equal(firstResult.details.status, "needs_more_questions");
	assert.match(firstResult.content[0].text, /choice: "a" \(A\)/, "model-visible text includes stable values and labels");
	assert.equal(h.hidden(), false);
	assert.equal(h.focused(), false, "focus returns to normal Pi UI while the model runs");
	assert.equal(h.customCalls(), 1, "ctx.ui.custom is used only to capture the supported TUI handle");
	assert.equal(h.customPending(), 0, "no blocking custom prompt survives the tool result");

	await h.emit("agent_start");
	await h.emit("turn_start");
	await h.emit("tool_execution_start", { toolName: "read" });
	await h.emit("tool_execution_end", { toolName: "read" });
	assert.equal(h.component(), firstPanel);
	assert.equal(h.hidden(), false, "normal main-agent rounds do not remove the questionnaire");

	const { promise: second } = await startCall(h, {
		questionnaire_id: firstResult.details.questionnaireId,
		message: "I checked the project before asking the follow-up.",
		questions: [{
			id: "detail",
			prompt: "Describe A",
			kind: "text",
			show_if: [{ question_id: "choice", value: "a" }],
		}],
		final: true,
	});
	assert.equal(h.component(), firstPanel, "updates reuse the persistent component");
	assert.equal(h.focused(), true);
	firstPanel.handleInput(enter);
	for (const char of "details") firstPanel.handleInput(char);
	firstPanel.handleInput(enter);
	firstPanel.handleInput(enter);
	const secondResult = await second;
	assert.equal(secondResult.details.status, "completed");
	assert.equal(secondResult.details.answers.length, 2);
	assert.equal(h.hidden(), true);
});

test("a clarification on the written-answer row returns to the model without advancing or completing", async () => {
	const h = harness();
	const { promise } = await startCall(h, { questions: [
		{ id: "permission", prompt: "Read or write?", options: [{ value: "ro", label: "Read only" }, { value: "rw", label: "Read/write" }] },
		{ id: "approval", prompt: "Proceed?", options: [{ value: "yes", label: "Yes" }] },
	], final: true });
	const panel = h.component();
	panel.handleInput("\x1b[B");
	panel.handleInput("\x1b[B"); // Write another answer.
	panel.handleInput("c");
	for (const char of "What is the difference?") panel.handleInput(char);
	panel.handleInput(enter);
	const result = await promise;
	assert.equal(result.details.status, "needs_clarification");
	assert.equal(result.details.clarificationQuestionId, "permission");
	assert.equal(result.details.answers.length, 0);
	assert.equal(result.details.state.clarifications[0]?.question, "What is the difference?");
	assert.equal(h.hidden(), false);
});

test("same-question follow-ups return to the main agent repeatedly in one persistent panel", async () => {
	const h = harness();
	const { promise: first } = await startCall(h, {
		questions: [
			{ id: "q1", prompt: "First choice", options: [{ value: "a", label: "A" }] },
			{ id: "q2", prompt: "Second choice", options: [{ value: "b", label: "B" }] },
		],
	});
	const panel = h.component();
	panel.handleInput("\x1b[C");
	panel.handleInput("c");
	for (const char of "What does B mean?") panel.handleInput(char);
	panel.handleInput(enter);
	const clarification = await first;
	assert.equal(clarification.details.status, "needs_clarification");
	assert.equal(clarification.details.clarificationQuestionId, "q2");
	assert.match(clarification.content[0].text, /question "q2"/);
	assert.equal(h.hidden(), false);
	let rendered = panel.render(70).join("\n");
	assert.match(rendered, /Second choice/);
	assert.match(rendered, /What does B mean?/);
	assert.match(rendered, /Agent is working…/);

	const { promise: second } = await startCall(h, {
		questionnaire_id: clarification.details.questionnaireId,
		message: "B preserves the current behavior.",
		final: true,
	});
	assert.equal(h.component(), panel);
	rendered = panel.render(70).join("\n");
	assert.match(rendered, /What does B mean?/);
	assert.match(rendered, /B preserves the current behavior/);
	assert.match(rendered, /C follow-up/);
	panel.handleInput("c");
	for (const char of "What about migrations?") panel.handleInput(char);
	panel.handleInput(enter);
	const followUp = await second;
	assert.equal(followUp.details.status, "needs_clarification");
	assert.equal(followUp.details.clarificationQuestionId, "q2");
	assert.equal(followUp.details.answers.length, 0, "clarifying does not answer or advance either question");
	assert.equal(h.component(), panel);

	const { promise: third } = await startCall(h, {
		questionnaire_id: followUp.details.questionnaireId,
		message: "Migrations run before switching traffic.",
		final: true,
	});
	assert.equal(h.component(), panel);
	rendered = panel.render(70).join("\n");
	for (const text of ["What does B mean?", "B preserves the current behavior", "What about migrations?", "Migrations run before switching traffic"]) {
		assert.match(rendered, new RegExp(text));
	}
	panel.handleInput("\x1b[D");
	rendered = panel.render(70).join("\n");
	assert.match(rendered, /First choice/);
	assert.doesNotMatch(rendered, /What does B mean|migrations|preserves the current behavior/);
	panel.handleInput(enter);
	panel.handleInput(enter);
	panel.handleInput(enter);
	const result = await third;
	assert.equal(result.details.status, "completed");
	assert.deepEqual(result.details.state.clarifications.map((item: any) => [item.questionId, item.question, item.response]), [
		["q2", "What does B mean?", "B preserves the current behavior."],
		["q2", "What about migrations?", "Migrations run before switching traffic."],
	]);
	assert.equal(result.details.state.message, undefined);
});

test("external abort resolves the tool, persists cancellation, and closes the panel", async () => {
	const h = harness();
	const controller = new AbortController();
	const { promise: call } = await startCall(h, {
		questions: [{ id: "q", prompt: "Answer", kind: "text" }],
	}, controller.signal);
	controller.abort();
	const result = await call;
	assert.equal(result.details.status, "cancelled");
	assert.equal(h.hidden(), true);
	assert.equal(result.details.state.phase, "cancelled");
});

test("reload reconstructs a passive visible panel from branch-local persisted state", async () => {
	const firstHarness = harness();
	const { promise: call } = await startCall(firstHarness, {
		questions: [{ id: "q", prompt: "Choose", options: [{ value: "a", label: "A" }] }],
	});
	firstHarness.component().handleInput(enter);
	firstHarness.component().handleInput(enter);
	const waiting = await call;
	assert.equal(waiting.details.status, "needs_more_questions");
	await firstHarness.emit("session_shutdown", { reason: "reload" });

	const restored = harness(firstHarness.entries);
	await restored.emit("session_start", { reason: "reload" });
	await tick();
	await tick();
	assert.ok(restored.component());
	assert.equal(restored.focused(), false);
	assert.equal(restored.hidden(), false);
	assert.match(restored.component().render(64).join("\n"), /Agent is working/);
	assert.ok(restored.statuses.some((status) => status?.includes("Questionnaire")));
});

test("non-TUI modes fail explicitly without creating state or pretending to ask", async () => {
	const h = harness();
	h.ctx.mode = "rpc";
	const result = await h.tool().execute("call", {
		questions: [{ id: "q", prompt: "Q", kind: "text" }],
	}, undefined, undefined, h.ctx);
	assert.equal(result.details.status, "unavailable");
	assert.equal(h.entries.length, 0);
});

test("a completed questionnaire does not block a new questionnaire in the same session", async () => {
	const h = harness();
	const { promise: first } = await startCall(h, {
		questions: [{ id: "first", prompt: "First", options: [{ value: "a", label: "A" }] }],
		final: true,
	});
	h.component().handleInput(enter);
	h.component().handleInput(enter);
	const completed = await first;
	assert.equal(completed.details.status, "completed");

	const { promise: second } = await startCall(h, {
		questions: [{ id: "second", prompt: "Second", options: [{ value: "b", label: "B" }] }],
		final: true,
	});
	assert.notEqual(h.component(), undefined);
	h.component().handleInput(enter);
	h.component().handleInput(enter);
	const next = await second;
	assert.equal(next.details.status, "completed");
	assert.notEqual(next.details.questionnaireId, completed.details.questionnaireId);
});


test("Alt+Q toggles focus inside the interactive panel and the editor shortcut restores it", async () => {
	const h = harness();
	const { promise } = await startCall(h, {
		questions: [{ id: "q", prompt: "Choose", options: [{ value: "stable", label: "Readable" }] }],
		final: true,
	});
	let settled = false;
	void promise.then(() => { settled = true; });
	const panel = h.component();
	panel.handleInput("\x1bq");
	assert.equal(h.focused(), false);
	await tick();
	assert.equal(settled, false, "focus toggling must not settle the questionnaire");
	await h.shortcut().handler(h.ctx);
	assert.equal(h.focused(), true);
	panel.handleInput(enter);
	panel.handleInput(enter);
	assert.equal((await promise).details.status, "completed");
});

test("session shutdown settles the active waiter before disposal without a terminal snapshot write", async () => {
	const h = harness();
	const { promise } = await startCall(h, {
		questions: [{ id: "q", prompt: "Choose", options: [{ value: "a", label: "A" }] }],
	});
	const oldPanel = h.component();
	const snapshotsBeforeShutdown = h.entries.length;
	await h.emit("session_shutdown", { reason: "reload" });
	const result = await promise;
	assert.equal(result.details.status, "cancelled");
	assert.match(result.content[0].text, /session shutdown/);
	assert.equal(h.hidden(), true);
	assert.equal(h.entries.length, snapshotsBeforeShutdown, "shutdown must not append cancellation state to a dead runtime");
	oldPanel.handleInput(enter);
	assert.equal(h.entries.length, snapshotsBeforeShutdown, "disposed old-branch UI cannot persist later input");
});

test("shutdown settles while TUI capture is delayed and late capture cannot mount an overlay", async () => {
	const h = harness([], { delayCustom: true });
	const { promise } = await startCall(h, {
		questions: [{ id: "q", prompt: "Choose", options: [{ value: "a", label: "A" }] }],
	});
	assert.equal(h.customPending(), 1);
	const entriesBeforeShutdown = h.entries.length;
	const statusesBeforeShutdown = h.statuses.length;
	await h.emit("session_shutdown", { reason: "reload" });
	const result = await promise;
	assert.equal(result.details.status, "cancelled", "shutdown settles without waiting for custom capture");
	assert.equal(h.entries.length, entriesBeforeShutdown);
	assert.equal(h.statuses.length, statusesBeforeShutdown);
	assert.equal(h.componentMaybe(), undefined);
	h.releaseCustom();
	await tick();
	await tick();
	assert.equal(h.customPending(), 0);
	assert.equal(h.componentMaybe(), undefined, "a stale capture cannot mount after shutdown");
});

test("session_tree rebinds from the selected branch and never persists the old active state there", async () => {
	const h = harness();
	const { promise: oldCall } = await startCall(h, {
		questions: [{ id: "old", prompt: "Old branch", options: [{ value: "old", label: "Old" }] }],
	});
	const oldQuestionnaireId = h.entries.at(-1).data.state.id;
	const newBranch: any[] = [];
	h.setBranch(newBranch);
	await h.emit("session_tree", { newLeafId: null, oldLeafId: "old-leaf" });
	const interrupted = await oldCall;
	assert.equal(interrupted.details.status, "cancelled");
	assert.match(interrupted.content[0].text, /session tree/);
	assert.equal(newBranch.length, 0, "old branch state must not be copied to the selected branch");
	assert.equal(h.statuses.at(-1), undefined, "a branch without Questionnaire state clears status");

	const { promise: newCall } = await startCall(h, {
		questions: [{ id: "new", prompt: "New branch", options: [{ value: "new", label: "New" }] }],
		final: true,
	});
	h.component().handleInput(enter);
	h.component().handleInput(enter);
	const completed = await newCall;
	assert.equal(completed.details.status, "completed");
	assert.notEqual(completed.details.questionnaireId, oldQuestionnaireId);
	assert.ok(newBranch.every((entry) => entry.data?.state?.id !== oldQuestionnaireId));
});

test("session_tree replaces an old passive overlay with the selected branch snapshot", async () => {
	const branchA = mergeQuestionnaire(undefined, {
		questionnaireId: "branch-a",
		questions: [{ id: "a", prompt: "Branch A prompt", options: [{ value: "a", label: "A" }] }],
	}, () => "unused");
	commitAnswer(branchA, "a", ["a"]);
	markWaiting(branchA);
	const h = harness([{ type: "custom", customType: ASK_USER_STATE_ENTRY, data: { state: branchA } }]);
	await h.emit("session_start", { reason: "startup" });
	await tick();
	const oldPanel = h.component();

	const branchB = mergeQuestionnaire(undefined, {
		questionnaireId: "branch-b",
		questions: [{ id: "b", prompt: "Branch B prompt", options: [{ value: "b", label: "B" }] }],
	}, () => "unused");
	commitAnswer(branchB, "b", ["b"]);
	markWaiting(branchB);
	const selected = [{ type: "custom", customType: ASK_USER_STATE_ENTRY, data: { state: branchB } }];
	h.setBranch(selected);
	await h.emit("session_tree", { newLeafId: "b", oldLeafId: "a" });
	await tick();
	const selectedPanel = h.component();
	assert.notEqual(selectedPanel, oldPanel);
	assert.equal((selectedPanel as any).state.id, "branch-b");
	assert.doesNotMatch(selectedPanel.render(70).join("\n"), /branch-a|branch-b/, "internal questionnaire IDs stay out of the UI");
	assert.equal(h.focused(), false);
	const entryCount = selected.length;
	oldPanel.handleInput("\x1bq");
	oldPanel.handleInput("\x1b");
	assert.equal(h.focused(), false, "stale panel callbacks cannot change selected-branch focus");
	assert.equal(selected.length, entryCount, "stale panel callbacks cannot persist into selected branch");
});

test("session_tree restores terminal state from the selected branch instead of retaining the previous branch", async () => {
	const h = harness();
	await h.emit("session_start", { reason: "startup" });
	const selected = mergeQuestionnaire(undefined, {
		questionnaireId: "selected-completed",
		questions: [{ id: "q", prompt: "Selected", options: [{ value: "v", label: "Value" }] }],
		final: true,
	}, () => "unused");
	commitAnswer(selected, "q", ["v"]);
	markCompleted(selected);
	h.setBranch([{ type: "custom", customType: ASK_USER_STATE_ENTRY, data: { state: selected } }]);
	await h.emit("session_tree", { newLeafId: "selected", oldLeafId: "old" });
	assert.equal(h.focused(), false);
	const { promise } = await startCall(h, {
		questions: [{ id: "fresh", prompt: "Fresh", options: [{ value: "f", label: "Fresh" }] }],
		final: true,
	});
	h.component().handleInput(enter);
	h.component().handleInput(enter);
	const result = await promise;
	assert.notEqual(result.details.questionnaireId, "selected-completed");
});

test("model-facing result text includes stable single, multi, and written values", async () => {
	const h = harness();
	const { promise } = await startCall(h, {
		questions: [
			{ id: "single", prompt: "Single", options: [{ value: "stable-one", label: "Readable one" }] },
			{ id: "multi", prompt: "Multi", kind: "multi", options: [
				{ value: "stable-x", label: "Readable X" },
				{ value: "stable-y", label: "Readable Y" },
			] },
			{ id: "text", prompt: "Text", kind: "text" },
		],
		final: true,
	});
	const panel = h.component();
	panel.handleInput(enter);
	panel.handleInput(" ");
	panel.handleInput("\x1b[B");
	panel.handleInput(" ");
	panel.handleInput(enter);
	panel.handleInput(enter);
	for (const char of "written value") panel.handleInput(char);
	panel.handleInput(enter);
	panel.handleInput(enter);
	const result = await promise;
	const text = result.content[0].text;
	assert.match(text, /single: "stable-one" \(Readable one\)/);
	assert.match(text, /multi: "stable-x" \(Readable X\), "stable-y" \(Readable Y\)/);
	assert.match(text, /text: "written value"/);
});


test("rewording preserves the clarification reply in the panel; removal prunes it", async () => {
	for (const variant of ["remove", "revise"] as const) {
		const h = harness();
		const { promise: first } = await startCall(h, {
			questions: [
				{ id: "q1", prompt: "First survives", options: [{ value: "a", label: "A" }] },
				{ id: "q2", prompt: "Old second", options: [{ value: "b", label: "B" }] },
			],
		});
		const panel = h.component();
		panel.handleInput("\x1b[C");
		panel.handleInput("c");
		for (const char of "Clarify old second") panel.handleInput(char);
		panel.handleInput(enter);
		const clarification = await first;
		const controller = new AbortController();
		const update = variant === "remove"
			? { remove_question_ids: ["q2"] }
			: { questions: [{ id: "q2", prompt: "Revised second", options: [{ value: "b", label: "B" }] }] };
		const { promise: second } = await startCall(h, {
			questionnaire_id: clarification.details.questionnaireId,
			message: "It is the Excel reader, not Word.",
			...update,
		}, controller.signal);
		const rendered = panel.render(70).join("\n");
		if (variant === "revise") {
			assert.match(rendered, /Revised second/);
			assert.match(rendered, /Clarify old second/);
			assert.match(rendered, /It is the Excel reader, not Word/);
		} else {
			assert.match(rendered, /First survives/);
			assert.doesNotMatch(rendered, /Clarify old second|It is the Excel reader/);
		}
		controller.abort();
		const cancelled = await second;
		assert.equal(cancelled.details.state.message, undefined);
		if (variant === "revise") {
			assert.equal(cancelled.details.state.clarifications[0]?.response, "It is the Excel reader, not Word.");
		} else assert.deepEqual(cancelled.details.state.clarifications, []);
	}
});

test("message remains general round context when no clarification is pending", async () => {
	const h = harness();
	const controller = new AbortController();
	const { promise } = await startCall(h, {
		message: "General round context only",
		questions: [{ id: "q", prompt: "Question", options: [{ value: "a", label: "A" }] }],
	}, controller.signal);
	assert.match(h.component().render(64).join("\n"), /General round context only/);
	controller.abort();
	const result = await promise;
	assert.equal(result.details.state.message, "General round context only");
});

test("reload restores a same-question thread with prior replies and a pending follow-up", async () => {
	const firstHarness = harness();
	const { promise: first } = await startCall(firstHarness, {
		questions: [
			{ id: "q1", prompt: "First persisted", options: [{ value: "a", label: "A" }] },
			{ id: "q2", prompt: "Second persisted", options: [{ value: "b", label: "B" }] },
		],
	});
	const panel = firstHarness.component();
	panel.handleInput("\x1b[C");
	panel.handleInput("c");
	for (const char of "First persisted clarification") panel.handleInput(char);
	panel.handleInput(enter);
	const firstResult = await first;

	const { promise: second } = await startCall(firstHarness, {
		questionnaire_id: firstResult.details.questionnaireId,
		message: "First persisted reply",
	});
	panel.handleInput("c");
	for (const char of "Persisted follow-up") panel.handleInput(char);
	panel.handleInput(enter);
	const secondResult = await second;
	assert.equal(secondResult.details.status, "needs_clarification");
	assert.equal(secondResult.details.state.clarifications.length, 2);
	await firstHarness.emit("session_shutdown", { reason: "reload" });

	const restored = harness(firstHarness.entries);
	await restored.emit("session_start", { reason: "reload" });
	await tick();
	await tick();
	const rendered = restored.component().render(72).join("\n");
	assert.match(rendered, /Second persisted/);
	assert.match(rendered, /First persisted clarification/);
	assert.match(rendered, /First persisted reply/);
	assert.match(rendered, /Persisted follow-up/);
	assert.match(rendered, /Agent is working…/);
	assert.doesNotMatch(rendered, /First persisted\s*$/m);
});

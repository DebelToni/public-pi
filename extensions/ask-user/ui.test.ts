import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { addClarification, commitAnswer, mergeQuestionnaire, type QuestionnaireState } from "./state.ts";
import { QuestionnairePanel, type PanelEvent } from "./ui.ts";

function theme() {
	return {
		fg(_color: string, text: string) { return text; },
		bg(_color: string, text: string) { return text; },
		bold(text: string) { return text; },
	} as any;
}

function fixture() {
	return mergeQuestionnaire(undefined, {
		questions: [
			{ id: "single", prompt: "Pick A, B, or C", kind: "single", options: [
				{ value: "a", label: "A" }, { value: "b", label: "B" }, { value: "c", label: "C" },
			] },
			{ id: "multi", prompt: "Pick several", kind: "multi", options: [
				{ value: "x", label: "X" }, { value: "y", label: "Y" },
			] },
			{ id: "text", prompt: "Write the rationale", kind: "text" },
		],
		final: true,
	}, () => "ui-test");
}

function setup(state = fixture(), rows = 30) {
	let renders = 0;
	let persisted: QuestionnaireState | undefined;
	const tui = { terminal: { rows }, requestRender() { renders++; } } as any;
	const panel = new QuestionnairePanel(state, tui, theme(), (next) => { persisted = structuredClone(next); });
	panel.focused = true;
	const events: PanelEvent[] = [];
	panel.setInteraction((event) => events.push(event));
	return { panel, state, events, persisted: () => persisted, renders: () => renders };
}

function renderedCursor(panel: QuestionnairePanel, width: number) {
	const lines = panel.render(width);
	for (let row = 0; row < lines.length; row++) {
		const index = lines[row]!.indexOf(CURSOR_MARKER);
		if (index >= 0) {
			assert.match(lines[row]!.slice(index + CURSOR_MARKER.length), /^\x1b\[7m/, "cursor marker precedes the visible cursor box");
			return { row, col: visibleWidth(lines[row]!.slice(0, index)) };
		}
	}
	throw new Error("Rendered editor cursor marker was not found");
}

const enter = "\r";
const down = "\x1b[B";
const left = "\x1b[D";
const right = "\x1b[C";

test("keyboard flow supports single, multi, text, review, and revision navigation", () => {
	const { panel, state, events, persisted } = setup();
	panel.handleInput(down);
	panel.handleInput(enter);
	assert.deepEqual(state.answers.single.values, ["b"]);

	panel.handleInput(" ");
	panel.handleInput(down);
	panel.handleInput(" ");
	panel.handleInput(enter);
	assert.deepEqual(state.answers.multi.values, ["x", "y"]);

	panel.handleInput(enter);
	for (const char of "because") panel.handleInput(char);
	panel.handleInput(enter);
	assert.deepEqual(state.answers.text.values, ["because"]);
	assert.ok(persisted());

	panel.handleInput(left);
	panel.handleInput(left);
	panel.handleInput(left);
	panel.handleInput(enter);
	assert.deepEqual(state.answers.single.values, ["b"], "reconfirming the same answer should be stable");
	panel.handleInput(right);
	panel.handleInput(right);
	panel.handleInput(right);
	panel.handleInput(enter);
	assert.deepEqual(events, [{ kind: "continue" }]);
});

test("inline clarification input emits a clarification event without answering a question", () => {
	const { panel, state, events } = setup();
	panel.handleInput("c");
	for (const char of "Can you explain B?") panel.handleInput(char);
	panel.handleInput(enter);
	assert.equal(state.clarifications.at(-1)?.question, "Can you explain B?");
	assert.equal(state.answers.single, undefined);
	assert.deepEqual(events, [{ kind: "clarification" }]);
});

test("C clarifies even with Write another answer selected; Enter there still writes an answer", () => {
	const { panel, state, events } = setup();
	panel.handleInput(down);
	panel.handleInput(down);
	panel.handleInput(down);
	const choices = stripVTControlCharacters(panel.render(70).join("\n"));
	assert.match(choices, /Write an answer \(moves on\)/);
	assert.match(choices, /Ask a question \(wait for agent\)/);
	panel.handleInput("c");
	for (const char of "How does this option differ?") panel.handleInput(char);
	panel.handleInput(enter);
	assert.equal(state.clarifications.at(-1)?.question, "How does this option differ?");
	assert.equal(state.clarifications.at(-1)?.questionId, "single");
	assert.equal(state.answers.single, undefined);
	assert.deepEqual(events, [{ kind: "clarification" }]);

	const next = setup();
	for (let i = 0; i < 3; i++) next.panel.handleInput(down);
	next.panel.handleInput(enter);
	for (const char of "custom answer") next.panel.handleInput(char);
	next.panel.handleInput(enter);
	assert.deepEqual(next.state.answers.single.values, ["custom answer"]);
	assert.deepEqual(next.state.clarifications, []);

	const ask = setup();
	for (let i = 0; i < 4; i++) ask.panel.handleInput(down);
	assert.match(stripVTControlCharacters(ask.panel.render(70).join("\n")), /Enter ask/);
	ask.panel.handleInput(enter);
	for (const char of "Explain read-only?") ask.panel.handleInput(char);
	ask.panel.handleInput(enter);
	assert.deepEqual(ask.events, [{ kind: "clarification" }]);
	assert.equal(ask.state.answers.single, undefined);
	assert.equal(ask.state.clarifications[0]?.question, "Explain read-only?");
});

test("escape requires explicit abort confirmation", () => {
	const { panel, events } = setup();
	panel.handleInput("\x1b");
	assert.match(stripVTControlCharacters(panel.render(60).join("\n")), /Abort questionnaire/);
	panel.handleInput("n");
	assert.equal(events.length, 0);
	panel.handleInput("\x1b");
	panel.handleInput("y");
	assert.deepEqual(events, [{ kind: "cancel" }]);
});

test("full-viewport rendering fills narrow and wide terminal dimensions safely", () => {
	for (const { width, rows } of [
		{ width: 20, rows: 8 },
		{ width: 48, rows: 14 },
		{ width: 120, rows: 40 },
		{ width: 200, rows: 55 },
	]) {
		const { panel } = setup(fixture(), rows);
		const lines = panel.render(width);
		assert.equal(lines.length, rows, `height mismatch at ${width}x${rows}`);
		assert.ok(lines.every((line) => visibleWidth(line) === width), `width mismatch at ${width}x${rows}`);
	}
});

test("passive panel is read-only and dismisses without creating questionnaire events", () => {
	const { panel, state, events } = setup();
	let dismissed = 0;
	panel.setPassive(() => { dismissed++; });
	panel.handleInput(enter);
	assert.equal(state.answers.single, undefined);
	panel.handleInput("\x1b");
	assert.equal(dismissed, 1);
	assert.deepEqual(events, []);
});

test("choice questions expose a non-empty free-written answer", () => {
	const state = mergeQuestionnaire(undefined, {
		questions: [{ id: "choice", prompt: "Choose", options: [
			{ value: "a", label: "A" }, { value: "b", label: "B" }, { value: "c", label: "C" },
		] }],
		final: true,
	}, () => "other-test");
	const { panel } = setup(state);
	panel.handleInput(down);
	panel.handleInput(down);
	panel.handleInput(down);
	for (const char of "A different answer") panel.handleInput(char);
	panel.handleInput("\n");
	for (const char of "on two lines") panel.handleInput(char);
	panel.handleInput(enter);
	assert.equal(state.answers.choice.custom, true);
	assert.deepEqual(state.answers.choice.values, ["A different answer\non two lines"]);
});

test("Alt+Q dismisses focus before every panel mode without emitting or mutating", () => {
	const altQ = "\x1bq";
	const cases: Array<{ name: string; prepare(panel: QuestionnairePanel): void; passive?: boolean }> = [
		{ name: "question", prepare() {} },
		{ name: "answer editor", prepare(panel) { panel.handleInput(right); panel.handleInput(right); panel.handleInput(enter); } },
		{ name: "clarification editor", prepare(panel) { panel.handleInput("c"); } },
		{ name: "abort confirmation", prepare(panel) { panel.handleInput("\x1b"); } },
		{ name: "passive", passive: true, prepare() {} },
	];
	for (const item of cases) {
		const { panel, state, events } = setup();
		let toggles = 0;
		panel.setFocusToggle(() => { toggles++; });
		if (item.passive) panel.setPassive(() => { throw new Error("Alt+Q must not use passive Escape dismissal"); });
		item.prepare(panel);
		const before = JSON.stringify(state);
		panel.handleInput(altQ);
		assert.equal(toggles, 1, item.name);
		assert.equal(JSON.stringify(state), before, item.name);
		assert.deepEqual(events, [], item.name);
	}
});

test("text questions accept typing immediately and submit multiline answers", () => {
	const state = mergeQuestionnaire(undefined, {
		questions: [{ id: "notes", prompt: "Write notes", kind: "text" }],
		final: true,
	}, () => "hidden-internal-id");
	const { panel } = setup(state);
	for (const char of "first line") panel.handleInput(char);
	assert.equal((panel as any).editor.getText(), "first line");
	assert.equal(state.answers.notes, undefined, "typing does not need an activation Enter");
	panel.handleInput("\x1b[13;2~"); // Shift+Enter in xterm modifyOtherKeys form.
	for (const char of "second line") panel.handleInput(char);
	panel.handleInput("\n"); // Ctrl+J / newline fallback.
	for (const char of "third line") panel.handleInput(char);
	panel.handleInput(enter);
	assert.equal(state.answers.notes.values[0], "first line\nsecond line\nthird line");
	const rendered = stripVTControlCharacters(panel.render(32).join("\n"));
	assert.match(rendered, /Review and submit/);
	assert.equal(rendered.match(/Review/g)?.length, 1, "final review has one shallow heading");
	assert.match(rendered, /first line/);
	assert.match(rendered, /second line/);
	assert.match(rendered, /third line/);
	assert.doesNotMatch(rendered, /hidden-internal-id/);
});

test("long editor content wraps in a narrow viewport", () => {
	const state = mergeQuestionnaire(undefined, {
		questions: [{ id: "long", prompt: "Long answer", kind: "text" }],
	}, () => "wrap-test");
	const { panel } = setup(state, 24);
	for (const char of "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda") panel.handleInput(char);
	const renderedLines = panel.render(24);
	assert.equal(renderedLines.length, 24);
	assert.ok(renderedLines.every((line) => visibleWidth(line) === 24));
	const plain = renderedLines.map((line) => stripVTControlCharacters(line));
	assert.ok(plain.filter((line) => /alpha|gamma|epsilon|theta|lambda/.test(line)).length >= 3, "answer wraps over multiple visible lines");
});

test("left, right, up, and down redraw the visible multiline cursor without mutating text", () => {
	const state = mergeQuestionnaire(undefined, {
		questions: [{ id: "text", prompt: "Text", kind: "text" }],
	}, () => "cursor-redraw-test");
	const { panel, renders } = setup(state, 24);
	for (const char of "abcd") panel.handleInput(char);
	panel.handleInput("\n");
	for (const char of "wxyz") panel.handleInput(char);
	const editor = (panel as any).editor;
	const text = editor.getText();
	let cursor = renderedCursor(panel, 30);

	for (const step of [
		{ key: left, row: 0, col: -1 },
		{ key: right, row: 0, col: 1 },
		{ key: "\x1b[A", row: -1, col: 0 },
		{ key: down, row: 1, col: 0 },
	]) {
		const rendersBefore = renders();
		panel.handleInput(step.key);
		assert.equal(editor.getText(), text, "arrow movement cannot mutate text");
		assert.ok(renders() > rendersBefore, "cursor-only input requests a TUI frame");
		const next = renderedCursor(panel, 30);
		assert.equal(next.row, cursor.row + step.row);
		assert.equal(next.col, cursor.col + step.col);
		cursor = next;
	}
});

test("all arrows stay inside text editors; Escape preserves drafts and restores question navigation", () => {
	const state = mergeQuestionnaire(undefined, {
		questions: [
			{ id: "text", prompt: "Text", kind: "text" },
			{ id: "choice", prompt: "Choice", options: [{ value: "a", label: "A" }] },
		],
	}, () => "arrow-test");
	const { panel } = setup(state, 20);
	for (const char of "a wrapped answer with several words") panel.handleInput(char);
	panel.render(18);
	for (const arrow of [left, right, "\x1b[A", down]) panel.handleInput(arrow);
	assert.equal((panel as any).page, 0, "editor arrows cannot change the question");
	panel.handleInput("\x1b");
	panel.handleInput(right);
	assert.equal((panel as any).page, 1, "Escape returns arrows to questionnaire navigation");
	panel.handleInput(left);
	assert.equal((panel as any).editor.getText(), "a wrapped answer with several words", "revisiting restores the uncommitted draft");
});

test("choice-written and clarification editors retain multiline drafts", () => {
	const state = mergeQuestionnaire(undefined, {
		questions: [{ id: "choice", prompt: "Choose", options: [{ value: "a", label: "A" }] }],
	}, () => "draft-test");
	const { panel, events } = setup(state);
	panel.handleInput(down); // Written alternative.
	panel.handleInput(enter); // Open it before typing a value that starts with the clarification shortcut.
	for (const char of "custom") panel.handleInput(char);
	assert.equal((panel as any).editor.getText(), "custom");
	for (const arrow of [left, right, "\x1b[A", down]) panel.handleInput(arrow);
	assert.equal((panel as any).page, 0);
	panel.handleInput("\n");
	for (const char of "answer") panel.handleInput(char);
	panel.handleInput("\x1b");
	panel.handleInput(enter);
	assert.equal((panel as any).editor.getText(), "custom\nanswer", "written-answer draft survives Escape");
	panel.handleInput("\x1b");
	panel.handleInput("\x1b[A");
	panel.handleInput("c");
	for (const char of "please explain") panel.handleInput(char);
	panel.handleInput("\n");
	for (const char of "this") panel.handleInput(char);
	panel.handleInput("\x1b");
	panel.handleInput("c");
	assert.equal((panel as any).editor.getText(), "please explain\nthis", "clarification draft survives Escape");
	for (const arrow of [left, right, "\x1b[A", down]) panel.handleInput(arrow);
	assert.equal((panel as any).page, 0);
	panel.handleInput(enter);
	assert.deepEqual(events, [{ kind: "clarification" }]);
	assert.equal(state.clarifications[0]?.question, "please explain\nthis");
});


function twoQuestionFixture() {
	return mergeQuestionnaire(undefined, {
		questions: [
			{ id: "q1", prompt: "First question with context", options: [{ value: "a", label: "First A" }, { value: "b", label: "First B" }] },
			{ id: "q2", prompt: "Second question", options: [{ value: "x", label: "Second X" }, { value: "y", label: "Second Y" }] },
		],
	}, () => "scoped-ui");
}

test("clarification editor stays inline below the active question across narrow and tall screens", () => {
	for (const { width, rows } of [{ width: 28, rows: 28 }, { width: 78, rows: 44 }]) {
		const state = twoQuestionFixture();
		state.clarifications.push({
			id: 1,
			questionId: "q1",
			question: "Earlier clarification",
			response: "Earlier scoped reply",
			askedAt: 1,
			respondedAt: 2,
		});
		const { panel } = setup(state, rows);
		panel.handleInput("c");
		for (const char of "Please explain how the first two choices differ in this situation") panel.handleInput(char);
		const lines = panel.render(width);
		const plain = lines.map((line) => stripVTControlCharacters(line));
		assert.equal(lines.length, rows);
		assert.ok(lines.every((line) => visibleWidth(line) === width));
		assert.match(plain.join("\n"), /First question with/);
		assert.match(plain.join("\n"), /First A/);
		assert.match(plain.join("\n"), /First B/);
		const compactRender = plain.join(" ").replace(/\s+/g, " ");
		assert.match(compactRender, /Earlier clarification/);
		assert.match(compactRender, /Earlier scoped reply/);
		assert.doesNotMatch(plain.join("\n"), /Second question/);
		const optionRow = plain.findIndex((line) => line.includes("First B"));
		const cursorRow = lines.findIndex((line) => line.includes(CURSOR_MARKER));
		assert.ok(optionRow >= 0 && cursorRow > optionRow, "the clarification editor is rendered below option context");
	}
});

test("question navigation shows only the clarification thread associated with that question", () => {
	const state = twoQuestionFixture();
	state.clarifications = [
		{ id: 1, questionId: "q1", question: "Q1 clarification", response: "Q1 reply", askedAt: 1, respondedAt: 2 },
		{ id: 2, questionId: "q2", question: "Q2 clarification", response: "Q2 reply", askedAt: 3, respondedAt: 4 },
	];
	const { panel } = setup(state, 30);
	let rendered = stripVTControlCharacters(panel.render(60).join("\n"));
	assert.match(rendered, /Q1 clarification/);
	assert.match(rendered, /Q1 reply/);
	assert.doesNotMatch(rendered, /Q2 clarification|Q2 reply/);
	panel.handleInput(right);
	rendered = stripVTControlCharacters(panel.render(60).join("\n"));
	assert.match(rendered, /Q2 clarification/);
	assert.match(rendered, /Q2 reply/);
	assert.doesNotMatch(rendered, /Q1 clarification|Q1 reply/);
	panel.handleInput(left);
	rendered = stripVTControlCharacters(panel.render(60).join("\n"));
	assert.match(rendered, /Q1 clarification/);
	assert.doesNotMatch(rendered, /Q2 clarification|Q2 reply/);
});

test("a pending clarification keeps its question and thread visible while the agent works", () => {
	const state = twoQuestionFixture();
	addClarification(state, "q1", "Pending Q1 clarification", 2);
	state.clarifications.push({ id: 2, questionId: "q2", question: "Old Q2 clarification", response: "Old Q2 reply", askedAt: 0, respondedAt: 1 });
	const { panel } = setup(state, 28);
	panel.setPassive(() => {});
	const rendered = stripVTControlCharacters(panel.render(58).join("\n"));
	assert.match(rendered, /First question with context/);
	assert.match(rendered, /First A/);
	assert.match(rendered, /Pending Q1 clarification/);
	assert.match(rendered, /Agent is working…/);
	assert.doesNotMatch(rendered, /Old Q2 clarification|Old Q2 reply|Second question/);
});

test("a model reply refocuses its question without leaking through next and back navigation", () => {
	let state = twoQuestionFixture();
	addClarification(state, "q2", "Explain Q2", 2);
	const setupResult = setup(state, 30);
	state = mergeQuestionnaire(state, {
		questionnaireId: "scoped-ui",
		message: "Only the Q2 reply",
	}, () => "unused", 3);
	setupResult.panel.setState(state);
	setupResult.panel.setInteraction((event) => setupResult.events.push(event));
	assert.equal((setupResult.panel as any).page, 1);
	let rendered = stripVTControlCharacters(setupResult.panel.render(60).join("\n"));
	assert.match(rendered, /Explain Q2/);
	assert.match(rendered, /Only the Q2 reply/);
	setupResult.panel.handleInput(left);
	rendered = stripVTControlCharacters(setupResult.panel.render(60).join("\n"));
	assert.doesNotMatch(rendered, /Explain Q2|Only the Q2 reply/);
	setupResult.panel.handleInput(right);
	rendered = stripVTControlCharacters(setupResult.panel.render(60).join("\n"));
	assert.match(rendered, /Explain Q2/);
	assert.match(rendered, /Only the Q2 reply/);
});

test("clarification drafts are isolated per question", () => {
	const { panel } = setup(twoQuestionFixture());
	panel.handleInput("c");
	for (const char of "first draft") panel.handleInput(char);
	panel.handleInput("\x1b");
	panel.handleInput(right);
	panel.handleInput("c");
	for (const char of "second draft") panel.handleInput(char);
	panel.handleInput("\x1b");
	panel.handleInput(left);
	panel.handleInput("c");
	assert.equal((panel as any).editor.getText(), "first draft");
	panel.handleInput("\x1b");
	panel.handleInput(right);
	panel.handleInput("c");
	assert.equal((panel as any).editor.getText(), "second draft");
});

test("review groups each clarification thread beneath its own question", () => {
	const state = twoQuestionFixture();
	commitAnswer(state, "q1", ["a"], { now: 1 });
	commitAnswer(state, "q2", ["x"], { now: 2 });
	state.clarifications = [
		{ id: 1, questionId: "q1", question: "Q1 review clarification", response: "Q1 review reply", askedAt: 3, respondedAt: 4 },
		{ id: 2, questionId: "q2", question: "Q2 review clarification", response: "Q2 review reply", askedAt: 5, respondedAt: 6 },
	];
	const { panel } = setup(state, 40);
	panel.handleInput(right);
	const rendered = stripVTControlCharacters(panel.render(72).join("\n"));
	const q1Answer = rendered.indexOf("First question with context: First A");
	const q1Thread = rendered.indexOf("Q1 review clarification");
	const q2Answer = rendered.indexOf("Second question: Second X");
	const q2Thread = rendered.indexOf("Q2 review clarification");
	assert.ok(q1Answer >= 0 && q1Answer < q1Thread && q1Thread < q2Answer && q2Answer < q2Thread);
});

test("a text question supports repeated follow-ups before and after it is answered", () => {
	let state = mergeQuestionnaire(undefined, {
		questions: [
			{ id: "text", prompt: "Explain the rollout", kind: "text" },
			{ id: "next", prompt: "Confirm next", options: [{ value: "yes", label: "Yes" }] },
		],
		final: true,
	}, () => "repeat-ui", 1);
	const result = setup(state, 46);
	const panel = result.panel;
	panel.handleInput("\x1b"); // Leave the pristine text-answer editor for question actions.

	panel.handleInput("c");
	for (const char of "First clarification") panel.handleInput(char);
	assert.match((panel as any).hint(), /Enter ask/);
	panel.handleInput(enter);
	assert.equal(state.answers.text, undefined);
	assert.deepEqual(result.events, [{ kind: "clarification" }]);

	state = mergeQuestionnaire(state, { questionnaireId: "repeat-ui", message: "First reply" }, () => "unused", 3);
	panel.setState(state);
	panel.setInteraction((event) => result.events.push(event));
	let rendered = stripVTControlCharacters(panel.render(84).join("\n"));
	assert.equal((panel as any).editMode, undefined, "a reply returns to question actions instead of forcing the answer editor");
	assert.match(rendered, /First clarification/);
	assert.match(rendered, /First reply/);
	assert.match(rendered, /C follow-up/);

	panel.handleInput("c");
	for (const char of "Second clarification") panel.handleInput(char);
	panel.handleInput(enter);
	assert.equal(state.answers.text, undefined, "asking again cannot answer or advance the question");
	assert.equal((panel as any).page, 0);
	state = mergeQuestionnaire(state, { questionnaireId: "repeat-ui", message: "Second reply" }, () => "unused", 5);
	panel.setState(state);
	panel.setInteraction((event) => result.events.push(event));
	rendered = stripVTControlCharacters(panel.render(84).join("\n"));
	assert.match(rendered, /First clarification/);
	assert.match(rendered, /First reply/);
	assert.match(rendered, /Second clarification/);
	assert.match(rendered, /Second reply/);

	for (const char of "settled answer") panel.handleInput(char);
	panel.handleInput(enter);
	assert.equal(state.answers.text.values[0], "settled answer");
	panel.handleInput(left);
	assert.equal((panel as any).editMode, undefined, "an answered text question returns to actions when revisited");
	panel.handleInput("c");
	for (const char of "Post-answer follow-up") panel.handleInput(char);
	panel.handleInput(enter);
	assert.equal(state.answers.text.values[0], "settled answer");
	assert.equal((panel as any).page, 0);
	state = mergeQuestionnaire(state, { questionnaireId: "repeat-ui", message: "Post-answer reply" }, () => "unused", 7);
	panel.setState(state);
	panel.setInteraction((event) => result.events.push(event));
	assert.deepEqual(state.clarifications.map((item) => item.questionId), ["text", "text", "text"]);
	assert.equal(state.answers.text.values[0], "settled answer");
	rendered = stripVTControlCharacters(panel.render(84).join("\n"));
	for (const text of ["First clarification", "First reply", "Second clarification", "Second reply", "Post-answer follow-up", "Post-answer reply"]) {
		assert.match(rendered, new RegExp(text));
	}
});

test("long ongoing threads retain every exchange and support page scrolling", () => {
	const state = mergeQuestionnaire(undefined, {
		questions: [{ id: "q", prompt: "Scrollable question", options: [{ value: "a", label: "A" }] }],
	}, () => "scroll-thread", 1);
	state.clarifications = Array.from({ length: 10 }, (_, index) => ({
		id: index + 1,
		questionId: "q",
		question: `Clarification ${index + 1} with retained context`,
		response: `Reply ${index + 1} with retained context`,
		askedAt: index * 2 + 2,
		respondedAt: index * 2 + 3,
	}));
	state.updatedAt = state.clarifications.at(-1)!.respondedAt!;
	const { panel } = setup(state, 14);
	let rendered = stripVTControlCharacters(panel.render(44).join("\n"));
	assert.match(rendered, /Reply 10/);
	assert.match(rendered, /PgUp\/PgDn thread/);
	for (let index = 0; index < 10; index++) panel.handleInput("\x1b[5~");
	rendered = stripVTControlCharacters(panel.render(44).join("\n"));
	assert.match(rendered, /Scrollable question/);
	assert.match(rendered, /Clarification 1/);
	for (let index = 0; index < 10; index++) panel.handleInput("\x1b[6~");
	rendered = stripVTControlCharacters(panel.render(44).join("\n"));
	assert.match(rendered, /Reply 10/);
	assert.equal(state.clarifications.length, 10);
});

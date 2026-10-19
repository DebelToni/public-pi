import assert from "node:assert/strict";
import test from "node:test";
import {
	addClarification,
	answerSummary,
	cloneQuestionnaireState,
	commitAnswer,
	isQuestionnaireState,
	isReadyForReview,
	markCompleted,
	mergeQuestionnaire,
	unansweredVisibleQuestions,
	visibleQuestions,
} from "./state.ts";

const createId = () => "survey";

function baseState() {
	return mergeQuestionnaire(undefined, {
		questions: [
			{
				id: "path",
				prompt: "Choose a path",
				kind: "single",
				options: [
					{ value: "a", label: "A" },
					{ value: "b", label: "B" },
					{ value: "c", label: "C" },
				],
			},
			{
				id: "a_detail",
				prompt: "Explain A",
				kind: "text",
				showIf: [{ questionId: "path", value: "a" }],
			},
			{
				id: "a_depth",
				prompt: "Choose depth",
				kind: "single",
				options: [{ value: "deep", label: "Deep" }],
				showIf: [{ questionId: "a_detail", operator: "includes", value: "detail" }],
			},
			{
				id: "b_tags",
				prompt: "Pick tags",
				kind: "multi",
				options: [{ value: "x", label: "X" }, { value: "y", label: "Y" }],
				showIf: [{ questionId: "path", value: "b" }],
			},
		],
	}, createId, 1);
}

test("conditional graph reveals branches and revision invalidates descendants", () => {
	const state = baseState();
	assert.deepEqual(visibleQuestions(state).map((q) => q.id), ["path"]);
	commitAnswer(state, "path", ["a"], { now: 2 });
	assert.deepEqual(visibleQuestions(state).map((q) => q.id), ["path", "a_detail"]);
	commitAnswer(state, "a_detail", ["a detailed response"], { custom: true, now: 3 });
	assert.deepEqual(visibleQuestions(state).map((q) => q.id), ["path", "a_detail", "a_depth"]);
	commitAnswer(state, "a_depth", ["deep"], { now: 4 });
	assert.equal(isReadyForReview(state), true);

	commitAnswer(state, "path", ["b"], { now: 5 });
	assert.deepEqual(visibleQuestions(state).map((q) => q.id), ["path", "b_tags"]);
	assert.equal(state.answers.a_detail, undefined);
	assert.equal(state.answers.a_depth, undefined);
	assert.equal(isReadyForReview(state), false);
	commitAnswer(state, "b_tags", ["x", "y"], { now: 6 });
	assert.deepEqual(answerSummary(state).map((answer) => [answer.id, answer.labels]), [
		["path", ["B"]],
		["b_tags", ["X", "Y"]],
	]);
});

test("updating a question invalidates its answer and transitive dependent answers", () => {
	let state = baseState();
	commitAnswer(state, "path", ["a"]);
	commitAnswer(state, "a_detail", ["detail"]);
	commitAnswer(state, "a_depth", ["deep"]);
	state = mergeQuestionnaire(state, {
		questionnaireId: "survey",
		questions: [{ id: "a_detail", prompt: "Explain A precisely", kind: "text" }],
	}, createId, 10);
	assert.ok(state.answers.path);
	assert.equal(state.answers.a_detail, undefined);
	assert.equal(state.answers.a_depth, undefined);
});

test("same question update preserves answers and future questions append", () => {
	let state = baseState();
	commitAnswer(state, "path", ["b"]);
	const identical = {
		id: "path",
		prompt: "Choose a path",
		kind: "single" as const,
		options: [
			{ value: "a", label: "A" },
			{ value: "b", label: "B" },
			{ value: "c", label: "C" },
		],
	};
	state = mergeQuestionnaire(state, {
		questionnaireId: "survey",
		questions: [identical, { id: "future", prompt: "Future answer", kind: "text" }],
	}, createId);
	assert.deepEqual(state.answers.path.values, ["b"]);
	assert.equal(state.questions.at(-1)?.id, "future");
});

test("no active question can be skipped or completed unanswered", () => {
	const state = baseState();
	assert.deepEqual(unansweredVisibleQuestions(state).map((q) => q.id), ["path"]);
	assert.equal(isReadyForReview(state), false);
	assert.throws(() => markCompleted(state), /Cannot complete/);
	assert.throws(() => commitAnswer(state, "a_detail", ["hidden"], { custom: true }), /not active/);
	assert.throws(() => commitAnswer(state, "path", []), /exactly one/);
});

test("graph validation rejects missing references, cycles, and duplicate options", () => {
	assert.throws(() => mergeQuestionnaire(undefined, {
		questions: [{ id: "q", prompt: "Q", kind: "text", showIf: [{ questionId: "missing", value: "x" }] }],
	}, createId), /unknown question/);
	assert.throws(() => mergeQuestionnaire(undefined, {
		questions: [
			{ id: "a", prompt: "A", kind: "text", showIf: [{ questionId: "b", value: "x" }] },
			{ id: "b", prompt: "B", kind: "text", showIf: [{ questionId: "a", value: "x" }] },
		],
	}, createId), /cycle/);
	assert.throws(() => mergeQuestionnaire(undefined, {
		questions: [{
			id: "q",
			prompt: "Q",
			kind: "single",
			options: [{ value: "x", label: "X" }, { value: "x", label: "Again" }],
		}],
	}, createId), /duplicate option/);
});

test("clarification is distinct from answers and receives a model response", () => {
	let state = baseState();
	addClarification(state, "path", "What does path A imply?", 2);
	assert.equal(state.clarifications[0]?.questionId, "path");
	assert.equal(state.clarifications[0]?.question, "What does path A imply?");
	assert.equal(Object.keys(state.answers).length, 0);
	state = mergeQuestionnaire(state, {
		questionnaireId: "survey",
		message: "Path A preserves compatibility.",
	}, createId, 3);
	assert.equal(state.clarifications[0]?.response, "Path A preserves compatibility.");
	assert.equal(state.clarifications[0]?.respondedAt, 3);
	assert.equal(state.message, undefined, "a clarification reply is not global round context");
	assert.equal(state.currentQuestionId, "path");
	state = mergeQuestionnaire(state, {
		questionnaireId: "survey",
		message: "General round context.",
	}, createId, 4);
	assert.equal(state.message, "General round context.");
});


test("reserved question IDs cannot satisfy no-skip through inherited answer properties", () => {
	for (const id of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
		assert.throws(() => mergeQuestionnaire(undefined, {
			questions: [{ id, prompt: "Unsafe", kind: "text" }],
		}, createId), /reserved/);
	}
	const forged = {
		version: 1,
		id: "forged",
		title: "Questionnaire",
		phase: "completed",
		final: true,
		questions: [{ id: "toString", prompt: "Unsafe", kind: "text", options: [], allowOther: false, showIf: [] }],
		answers: {},
		clarifications: [],
		revision: 1,
		updatedAt: 1,
	} as any;
	assert.equal(isReadyForReview(forged), false, "inherited Object.prototype values are not answers");
	assert.equal(isQuestionnaireState(forged), false, "restored snapshots reject reserved IDs");
});

test("restored Questionnaire state is structurally validated", () => {
	const valid = baseState();
	assert.equal(isQuestionnaireState(valid), true);
	const badAnswer = structuredClone(valid) as any;
	badAnswer.answers.path = { questionId: "path", values: ["not-an-option"], labels: ["fake"], custom: false, answeredAt: 1 };
	assert.equal(isQuestionnaireState(badAnswer), false);
	const badLabel = structuredClone(valid) as any;
	badLabel.answers.path = { questionId: "path", values: ["a"], labels: ["forged label"], custom: false, answeredAt: 1 };
	assert.equal(isQuestionnaireState(badLabel), false);
	const inherited = structuredClone(valid) as any;
	inherited.answers = Object.create({ path: { questionId: "path", values: ["a"], labels: ["A"], custom: false, answeredAt: 1 } });
	assert.equal(isQuestionnaireState(inherited), false);
});


test("snapshot validation rejects malformed graphs, hidden answers, and invalid terminal metadata", () => {
	const valid = baseState();
	const malformedQuestion = structuredClone(valid) as any;
	malformedQuestion.questions[0].prompt = "";
	assert.equal(isQuestionnaireState(malformedQuestion), false);

	const duplicate = structuredClone(valid) as any;
	duplicate.questions.push(structuredClone(duplicate.questions[0]));
	assert.equal(isQuestionnaireState(duplicate), false);

	const unknownDependency = structuredClone(valid) as any;
	unknownDependency.questions[0].showIf = [{ questionId: "missing", operator: "equals", value: "x" }];
	assert.equal(isQuestionnaireState(unknownDependency), false);

	const cycle = structuredClone(valid) as any;
	cycle.questions[0].showIf = [{ questionId: "a_detail", operator: "equals", value: "x" }];
	assert.equal(isQuestionnaireState(cycle), false);

	const unknownAnswer = structuredClone(valid) as any;
	unknownAnswer.answers.missing = { questionId: "missing", values: ["x"], labels: ["x"], custom: true, answeredAt: 1 };
	assert.equal(isQuestionnaireState(unknownAnswer), false);

	const hiddenAnswer = structuredClone(valid) as any;
	hiddenAnswer.answers.a_detail = { questionId: "a_detail", values: ["hidden"], labels: ["hidden"], custom: true, answeredAt: 1 };
	assert.equal(isQuestionnaireState(hiddenAnswer), false);

	const incompleteCompleted = structuredClone(valid) as any;
	incompleteCompleted.phase = "completed";
	incompleteCompleted.final = true;
	assert.equal(isQuestionnaireState(incompleteCompleted), false);

	const malformedClarification = structuredClone(valid) as any;
	malformedClarification.clarifications = [{ id: 1, question: "", askedAt: 1 }];
	assert.equal(isQuestionnaireState(malformedClarification), false);
});

test("valid JSON and null-prototype answer maps restore and clone safely", () => {
	const state = baseState();
	commitAnswer(state, "path", ["b"]);
	assert.equal(Object.getPrototypeOf(state.answers), null);
	assert.equal(isQuestionnaireState(state), true);
	const jsonState = JSON.parse(JSON.stringify(state));
	assert.equal(Object.getPrototypeOf(jsonState.answers), Object.prototype);
	assert.equal(isQuestionnaireState(jsonState), true);
	const cloned = cloneQuestionnaireState(jsonState);
	assert.equal(Object.getPrototypeOf(cloned.answers), null);
	assert.deepEqual(cloned.answers.path.values, ["b"]);
});


test("clarification replies stay associated with their questions", () => {
	let state = mergeQuestionnaire(undefined, {
		questions: [
			{ id: "q1", prompt: "First", kind: "text" },
			{ id: "q2", prompt: "Second", kind: "text" },
		],
	}, createId, 1);
	addClarification(state, "q1", "Clarify first", 2);
	state = mergeQuestionnaire(state, { questionnaireId: "survey", message: "First reply" }, createId, 3);
	addClarification(state, "q1", "Follow up on first", 4);
	state = mergeQuestionnaire(state, { questionnaireId: "survey", message: "First follow-up reply" }, createId, 5);
	addClarification(state, "q2", "Clarify second", 6);
	state = mergeQuestionnaire(state, { questionnaireId: "survey", message: "Second reply" }, createId, 7);
	assert.deepEqual(state.clarifications.map(({ questionId, question, response }) => ({ questionId, question, response })), [
		{ questionId: "q1", question: "Clarify first", response: "First reply" },
		{ questionId: "q1", question: "Follow up on first", response: "First follow-up reply" },
		{ questionId: "q2", question: "Clarify second", response: "Second reply" },
	]);
	assert.equal(state.message, undefined);
});

test("legacy unscoped clarifications restore while malformed scoped metadata is rejected", () => {
	const legacy = baseState() as any;
	legacy.clarifications = [{ id: 1, question: "Legacy question", response: "Legacy reply", askedAt: 2 }];
	assert.equal(isQuestionnaireState(legacy), true);

	const unknownQuestion = structuredClone(legacy);
	unknownQuestion.clarifications = [{ id: 1, questionId: "missing", question: "Scoped", askedAt: 2 }];
	assert.equal(isQuestionnaireState(unknownQuestion), false);

	const responseTimeWithoutResponse = structuredClone(legacy);
	responseTimeWithoutResponse.clarifications = [{ id: 1, questionId: "path", question: "Scoped", askedAt: 2, respondedAt: 3 }];
	assert.equal(isQuestionnaireState(responseTimeWithoutResponse), false);

	const hiddenQuestion = structuredClone(legacy);
	hiddenQuestion.clarifications = [{ id: 1, questionId: "a_detail", question: "Hidden scope", askedAt: 2 }];
	assert.equal(isQuestionnaireState(hiddenQuestion), false);
});

test("question removal, revision, and conditional invalidation prune only stale scoped threads", () => {
	const makeTwo = () => mergeQuestionnaire(undefined, {
		questions: [
			{ id: "q1", prompt: "First", kind: "text" },
			{ id: "q2", prompt: "Second", kind: "text" },
		],
	}, createId, 1);

	let removed = makeTwo();
	addClarification(removed, "q1", "Keep me", 2);
	addClarification(removed, "q2", "Remove me", 3);
	removed = mergeQuestionnaire(removed, { questionnaireId: "survey", removeQuestionIds: ["q2"] }, createId, 4);
	assert.deepEqual(removed.clarifications.map((item) => item.questionId), ["q1"]);

	let changed = makeTwo();
	addClarification(changed, "q2", "Old definition", 2);
	changed = mergeQuestionnaire(changed, {
		questionnaireId: "survey",
		questions: [{ id: "q2", prompt: "Revised second", kind: "text" }],
	}, createId, 3);
	assert.deepEqual(changed.clarifications, []);

	let identical = makeTwo();
	addClarification(identical, "q2", "Still relevant", 2);
	identical = mergeQuestionnaire(identical, {
		questionnaireId: "survey",
		questions: [{ id: "q2", prompt: "Second", kind: "text" }],
	}, createId, 3);
	assert.equal(identical.clarifications[0]?.question, "Still relevant");

	let conditional = mergeQuestionnaire(undefined, {
		questions: [
			{ id: "toggle", prompt: "Show detail", options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }] },
			{ id: "detail", prompt: "Detail", kind: "text", showIf: [{ questionId: "toggle", value: "yes" }] },
		],
	}, createId, 1);
	commitAnswer(conditional, "toggle", ["yes"], { now: 2 });
	addClarification(conditional, "detail", "About detail", 3);
	commitAnswer(conditional, "toggle", ["no"], { now: 4 });
	assert.deepEqual(conditional.clarifications, []);
	assert.throws(() => addClarification(conditional, "detail", "Hidden", 5), /inactive question/);
});

test("reply to a reworded question stays in its thread while its old answer is invalidated", () => {
	let state = mergeQuestionnaire(undefined, {
		questions: [{ id: "workbook", prompt: "Is the workbook active?", options: [{ value: "yes", label: "Yes" }] }],
	}, createId, 1);
	addClarification(state, "workbook", "Which workbook?", 2);
	state = mergeQuestionnaire(state, { questionnaireId: "survey", message: "The Excel workbook." }, createId, 3);
	commitAnswer(state, "workbook", ["yes"], { now: 4 });
	addClarification(state, "workbook", "Is this a Word reader?", 5);
	state = mergeQuestionnaire(state, {
		questionnaireId: "survey",
		message: "No, it reads one Excel file.",
		questions: [{ id: "workbook", prompt: "Keep this one-file Excel reader?", options: [{ value: "keep", label: "Keep" }] }],
	}, createId, 6);
	assert.equal(state.message, undefined);
	assert.equal(state.answers.workbook, undefined);
	assert.deepEqual(state.clarifications.map(({ question, response }) => [question, response]), [
		["Which workbook?", "The Excel workbook."],
		["Is this a Word reader?", "No, it reads one Excel file."],
	]);
	assert.equal(state.clarifications[1]?.respondedAt, 6);
	assert.equal(isQuestionnaireState(state), true);
});

test("replying while removing a pending question prunes its thread without leaking into global context", () => {
	let state = mergeQuestionnaire(undefined, {
		questions: [
			{ id: "q1", prompt: "First", kind: "text" },
			{ id: "q2", prompt: "Second", kind: "text" },
		],
	}, createId, 1);
	addClarification(state, "q2", "Pending", 2);
	state = mergeQuestionnaire(state, {
		questionnaireId: "survey",
		message: "Reply to removed question",
		removeQuestionIds: ["q2"],
	}, createId, 3);
	assert.equal(state.message, undefined);
	assert.deepEqual(state.clarifications, []);
});

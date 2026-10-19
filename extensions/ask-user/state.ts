export const ASK_USER_STATE_VERSION = 1;
export const ASK_USER_STATE_ENTRY = "ask-user-state";

const RESERVED_QUESTION_IDS = new Set([
	"__proto__", "prototype", "constructor", "toString", "toLocaleString", "valueOf",
	"hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "__defineGetter__",
	"__defineSetter__", "__lookupGetter__", "__lookupSetter__",
]);

const hasOwn = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key);

export type QuestionKind = "single" | "multi" | "text";
export type ConditionOperator = "equals" | "includes" | "not_equals" | "not_includes";

export interface QuestionOption {
	value: string;
	label: string;
	description?: string;
}

export interface QuestionCondition {
	questionId: string;
	operator: ConditionOperator;
	value: string;
}

export interface QuestionDefinition {
	id: string;
	prompt: string;
	label?: string;
	kind: QuestionKind;
	options: QuestionOption[];
	allowOther: boolean;
	showIf: QuestionCondition[];
}

export interface QuestionAnswer {
	questionId: string;
	values: string[];
	labels: string[];
	custom: boolean;
	answeredAt: number;
}

export interface ClarificationExchange {
	id: number;
	/** Undefined only for snapshots written before clarifications became question-scoped. */
	questionId?: string;
	question: string;
	response?: string;
	askedAt: number;
	respondedAt?: number;
}

export type QuestionnairePhase = "answering" | "waiting_model" | "completed" | "cancelled";

export interface QuestionnaireState {
	version: typeof ASK_USER_STATE_VERSION;
	id: string;
	title: string;
	phase: QuestionnairePhase;
	final: boolean;
	message?: string;
	questions: QuestionDefinition[];
	answers: Record<string, QuestionAnswer>;
	clarifications: ClarificationExchange[];
	currentQuestionId?: string;
	revision: number;
	updatedAt: number;
}

export interface QuestionInput {
	id: string;
	prompt: string;
	label?: string;
	kind?: QuestionKind;
	options?: QuestionOption[];
	allowOther?: boolean;
	showIf?: Array<{
		questionId: string;
		operator?: ConditionOperator;
		value: string;
	}>;
}

export interface QuestionnaireUpdate {
	questionnaireId?: string;
	title?: string;
	message?: string;
	questions?: QuestionInput[];
	removeQuestionIds?: string[];
	final?: boolean;
}

function cleanText(value: string, name: string) {
	const cleaned = value.trim();
	if (!cleaned) throw new Error(`${name} cannot be empty`);
	return cleaned;
}

function normalizeQuestion(input: QuestionInput): QuestionDefinition {
	const id = cleanText(input.id, "Question id");
	if (RESERVED_QUESTION_IDS.has(id)) throw new Error(`Question id is reserved: ${id}`);
	const kind = input.kind ?? "single";
	const options = (input.options ?? []).map((option) => ({
		value: cleanText(option.value, `Option value in ${id}`),
		label: cleanText(option.label, `Option label in ${id}`),
		...(option.description?.trim() ? { description: option.description.trim() } : {}),
	}));
	if (kind === "text" && options.length > 0) throw new Error(`Text question ${id} cannot define options`);
	if (kind !== "text" && options.length === 0) throw new Error(`${kind} question ${id} requires at least one option`);
	if (new Set(options.map((option) => option.value)).size !== options.length) {
		throw new Error(`Question ${id} has duplicate option values`);
	}
	return {
		id,
		prompt: cleanText(input.prompt, `Question prompt for ${id}`),
		...(input.label?.trim() ? { label: input.label.trim() } : {}),
		kind,
		options,
		allowOther: kind !== "text" && input.allowOther !== false,
		showIf: (input.showIf ?? []).map((condition) => ({
			questionId: cleanText(condition.questionId, `Condition question id in ${id}`),
			operator: condition.operator ?? "equals",
			value: cleanText(condition.value, `Condition value in ${id}`),
		})),
	};
}

function stableQuestion(question: QuestionDefinition) {
	return JSON.stringify(question);
}

function dependencyMap(questions: QuestionDefinition[]) {
	const dependents = new Map<string, Set<string>>();
	for (const question of questions) {
		for (const condition of question.showIf) {
			let children = dependents.get(condition.questionId);
			if (!children) dependents.set(condition.questionId, children = new Set());
			children.add(question.id);
		}
	}
	return dependents;
}

function descendants(questions: QuestionDefinition[], roots: Iterable<string>) {
	const graph = dependencyMap(questions);
	const found = new Set<string>();
	const queue = [...roots];
	while (queue.length) {
		const id = queue.shift()!;
		for (const child of graph.get(id) ?? []) {
			if (found.has(child)) continue;
			found.add(child);
			queue.push(child);
		}
	}
	return found;
}

export function validateGraph(questions: QuestionDefinition[]) {
	const ids = new Set<string>();
	for (const question of questions) {
		if (ids.has(question.id)) throw new Error(`Duplicate question id: ${question.id}`);
		ids.add(question.id);
	}
	for (const question of questions) {
		for (const condition of question.showIf) {
			if (!ids.has(condition.questionId)) {
				throw new Error(`Question ${question.id} depends on unknown question ${condition.questionId}`);
			}
			if (condition.questionId === question.id) throw new Error(`Question ${question.id} cannot depend on itself`);
		}
	}
	const graph = dependencyMap(questions);
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (id: string) => {
		if (visiting.has(id)) throw new Error(`Question dependency cycle includes ${id}`);
		if (visited.has(id)) return;
		visiting.add(id);
		for (const child of graph.get(id) ?? []) visit(child);
		visiting.delete(id);
		visited.add(id);
	};
	for (const id of ids) visit(id);
}

function conditionMatches(condition: QuestionCondition, answer: QuestionAnswer | undefined) {
	if (!answer) return false;
	const has = answer.values.includes(condition.value);
	const contains = answer.values.some((value) => value.includes(condition.value));
	switch (condition.operator) {
		case "equals": return has;
		case "includes": return contains;
		case "not_equals": return !has;
		case "not_includes": return !contains;
	}
}

export function hasAnswer(state: QuestionnaireState, questionId: string) {
	return hasOwn(state.answers, questionId);
}

export function visibleQuestions(state: QuestionnaireState) {
	return state.questions.filter((question) =>
		question.showIf.every((condition) => conditionMatches(condition, hasAnswer(state, condition.questionId) ? state.answers[condition.questionId] : undefined)),
	);
}

export function unansweredVisibleQuestions(state: QuestionnaireState) {
	return visibleQuestions(state).filter((question) => !hasAnswer(state, question.id));
}

export function isReadyForReview(state: QuestionnaireState) {
	const visible = visibleQuestions(state);
	return visible.length > 0 && visible.every((question) => hasAnswer(state, question.id));
}

function pruneHiddenQuestionData(state: QuestionnaireState) {
	for (;;) {
		const visible = new Set(visibleQuestions(state).map((question) => question.id));
		const hiddenAnswered = Object.keys(state.answers).filter((id) => !visible.has(id));
		if (hiddenAnswered.length === 0) {
			state.clarifications = state.clarifications.filter((item) => item.questionId === undefined || visible.has(item.questionId));
			return;
		}
		for (const id of hiddenAnswered) delete state.answers[id];
	}
}

export function mergeQuestionnaire(
	previous: QuestionnaireState | undefined,
	update: QuestionnaireUpdate,
	createId: () => string,
	now = Date.now(),
): QuestionnaireState {
	if (previous && update.questionnaireId && update.questionnaireId !== previous.id) {
		throw new Error(`Active questionnaire is ${previous.id}; received update for ${update.questionnaireId}`);
	}
	if (!previous && (!update.questions || update.questions.length === 0)) {
		throw new Error("A new questionnaire requires at least one question");
	}
	const state: QuestionnaireState = previous
		? cloneQuestionnaireState(previous)
		: {
			version: ASK_USER_STATE_VERSION,
			id: update.questionnaireId?.trim() || createId(),
			title: "Questionnaire",
			phase: "answering",
			final: false,
			questions: [],
			answers: Object.create(null) as Record<string, QuestionAnswer>,
			clarifications: [],
			revision: 0,
			updatedAt: now,
		};
	if (state.phase === "completed" || state.phase === "cancelled") {
		throw new Error(`Questionnaire ${state.id} is already ${state.phase}`);
	}
	if (update.title !== undefined) state.title = cleanText(update.title, "Title");
	if (update.final !== undefined) state.final = update.final;
	let repliedQuestionId: string | undefined;
	if (update.message !== undefined) {
		const message = cleanText(update.message, "Message");
		const pending = [...state.clarifications].reverse().find((item) => item.response === undefined);
		if (pending) {
			pending.response = message;
			pending.respondedAt = now;
			repliedQuestionId = pending.questionId;
			if (pending.questionId) state.currentQuestionId = pending.questionId;
		} else {
			state.message = message;
		}
	}

	const removed = new Set(update.removeQuestionIds ?? []);
	const oldById = new Map(state.questions.map((question) => [question.id, question]));
	const replacements = new Map<string, QuestionDefinition>();
	for (const input of update.questions ?? []) {
		const question = normalizeQuestion(input);
		if (replacements.has(question.id)) throw new Error(`Duplicate question update: ${question.id}`);
		replacements.set(question.id, question);
	}
	const changed = new Set<string>();
	const merged: QuestionDefinition[] = [];
	for (const question of state.questions) {
		if (removed.has(question.id)) {
			changed.add(question.id);
			continue;
		}
		const replacement = replacements.get(question.id);
		if (replacement) {
			merged.push(replacement);
			replacements.delete(question.id);
			if (stableQuestion(replacement) !== stableQuestion(question)) changed.add(question.id);
		} else {
			merged.push(question);
		}
	}
	for (const question of replacements.values()) merged.push(question);
	state.questions = merged;
	validateGraph(state.questions);

	const invalid = new Set([...changed, ...descendants(state.questions, changed)]);
	for (const id of removed) invalid.add(id);
	for (const id of invalid) delete state.answers[id];
	state.clarifications = state.clarifications.filter((item) => item.questionId === undefined || !invalid.has(item.questionId)
		|| (item.questionId === repliedQuestionId && changed.has(item.questionId) && !removed.has(item.questionId)));
	pruneHiddenQuestionData(state);
	if (state.questions.length === 0) throw new Error("Questionnaire cannot be empty");
	if (state.currentQuestionId && !visibleQuestions(state).some((question) => question.id === state.currentQuestionId)) {
		state.currentQuestionId = undefined;
	}
	state.phase = "answering";
	state.revision++;
	state.updatedAt = now;
	return state;
}

export function commitAnswer(
	state: QuestionnaireState,
	questionId: string,
	values: string[],
	options: { custom?: boolean; now?: number } = {},
) {
	const question = state.questions.find((candidate) => candidate.id === questionId);
	if (!question) throw new Error(`Unknown question: ${questionId}`);
	if (!visibleQuestions(state).some((candidate) => candidate.id === questionId)) {
		throw new Error(`Question ${questionId} is not active`);
	}
	const cleaned = values.map((value) => value.trim()).filter(Boolean);
	if (question.kind === "single" && cleaned.length !== 1) throw new Error(`${questionId} requires exactly one answer`);
	if (question.kind === "multi" && cleaned.length === 0) throw new Error(`${questionId} requires at least one answer`);
	if (question.kind === "text" && cleaned.length !== 1) throw new Error(`${questionId} requires a non-empty text answer`);
	if (new Set(cleaned).size !== cleaned.length) throw new Error(`${questionId} contains duplicate answers`);
	const custom = options.custom === true || question.kind === "text";
	if (!custom) {
		const allowed = new Set(question.options.map((option) => option.value));
		if (cleaned.some((value) => !allowed.has(value))) throw new Error(`${questionId} contains an unknown option`);
	}
	if (custom && cleaned.length !== 1) throw new Error(`${questionId} requires one written answer`);
	if (custom && question.kind !== "text" && !question.allowOther) throw new Error(`${questionId} does not allow a custom answer`);
	const labels = custom
		? [...cleaned]
		: cleaned.map((value) => question.options.find((option) => option.value === value)!.label);
	const previous = hasAnswer(state, questionId) ? state.answers[questionId] : undefined;
	const changed = !previous || previous.custom !== custom || JSON.stringify(previous.values) !== JSON.stringify(cleaned);
	if (changed) {
		for (const id of descendants(state.questions, [questionId])) delete state.answers[id];
	}
	state.answers[questionId] = {
		questionId,
		values: cleaned,
		labels,
		custom,
		answeredAt: options.now ?? Date.now(),
	};
	pruneHiddenQuestionData(state);
	state.currentQuestionId = questionId;
	state.revision++;
	state.updatedAt = options.now ?? Date.now();
	return state;
}

export function addClarification(state: QuestionnaireState, questionId: string, question: string, now = Date.now()) {
	const id = cleanText(questionId, "Clarification question id");
	if (!visibleQuestions(state).some((candidate) => candidate.id === id)) throw new Error(`Cannot clarify inactive question ${id}`);
	const text = cleanText(question, "Clarification");
	state.clarifications.push({ id: (state.clarifications.at(-1)?.id ?? 0) + 1, questionId: id, question: text, askedAt: now });
	state.currentQuestionId = id;
	state.revision++;
	state.updatedAt = now;
	return state;
}

export function markWaiting(state: QuestionnaireState, now = Date.now()) {
	state.phase = "waiting_model";
	state.revision++;
	state.updatedAt = now;
	return state;
}

export function markCompleted(state: QuestionnaireState, now = Date.now()) {
	if (!isReadyForReview(state)) throw new Error("Cannot complete while active questions are unanswered");
	if (!state.final) throw new Error("Cannot complete before the questionnaire is final");
	state.phase = "completed";
	state.revision++;
	state.updatedAt = now;
	return state;
}

export function markCancelled(state: QuestionnaireState, now = Date.now()) {
	state.phase = "cancelled";
	state.revision++;
	state.updatedAt = now;
	return state;
}

export function answerSummary(state: QuestionnaireState) {
	return visibleQuestions(state)
		.filter((question) => hasAnswer(state, question.id))
		.map((question) => {
			const answer = state.answers[question.id]!;
			return {
				id: question.id,
				label: question.label ?? question.prompt,
				values: [...answer.values],
				labels: [...answer.labels],
				custom: answer.custom,
			};
		});
}

export function cloneQuestionnaireState(state: QuestionnaireState): QuestionnaireState {
	const clone = structuredClone(state);
	const answers = Object.create(null) as Record<string, QuestionAnswer>;
	for (const [id, answer] of Object.entries(clone.answers)) answers[id] = answer;
	clone.answers = answers;
	return clone;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

export function isQuestionnaireState(value: unknown): value is QuestionnaireState {
	if (!isPlainRecord(value)) return false;
	const state = value as unknown as QuestionnaireState;
	if (state.version !== ASK_USER_STATE_VERSION
		|| typeof state.id !== "string" || !state.id
		|| typeof state.title !== "string" || !state.title
		|| !["answering", "waiting_model", "completed", "cancelled"].includes(state.phase)
		|| typeof state.final !== "boolean"
		|| (state.message !== undefined && typeof state.message !== "string")
		|| !Array.isArray(state.questions)
		|| !isPlainRecord(state.answers)
		|| !Array.isArray(state.clarifications)
		|| (state.currentQuestionId !== undefined && typeof state.currentQuestionId !== "string")
		|| !Number.isSafeInteger(state.revision) || state.revision < 0
		|| !isFiniteNumber(state.updatedAt)) return false;
	const ids = new Set<string>();
	for (const question of state.questions) {
		if (!isPlainRecord(question)
			|| typeof question.id !== "string" || !question.id || RESERVED_QUESTION_IDS.has(question.id) || ids.has(question.id)
			|| typeof question.prompt !== "string" || !question.prompt
			|| (question.label !== undefined && typeof question.label !== "string")
			|| !["single", "multi", "text"].includes(question.kind)
			|| !Array.isArray(question.options) || typeof question.allowOther !== "boolean"
			|| !Array.isArray(question.showIf)) return false;
		ids.add(question.id);
		const optionValues = new Set<string>();
		for (const option of question.options) {
			if (!isPlainRecord(option) || typeof option.value !== "string" || !option.value
				|| typeof option.label !== "string" || !option.label
				|| (option.description !== undefined && typeof option.description !== "string")
				|| optionValues.has(option.value)) return false;
			optionValues.add(option.value);
		}
		if (question.kind === "text" ? question.options.length !== 0 || question.allowOther : question.options.length === 0) return false;
		for (const condition of question.showIf) {
			if (!isPlainRecord(condition) || typeof condition.questionId !== "string"
				|| !["equals", "includes", "not_equals", "not_includes"].includes(condition.operator)
				|| typeof condition.value !== "string" || !condition.value) return false;
		}
	}
	try { validateGraph(state.questions); } catch { return false; }
	for (const [id, answer] of Object.entries(state.answers)) {
		const question = state.questions.find((candidate) => candidate.id === id);
		if (!question || !isPlainRecord(answer) || answer.questionId !== id
			|| !Array.isArray(answer.values) || answer.values.length === 0 || answer.values.some((item) => typeof item !== "string" || !item)
			|| new Set(answer.values).size !== answer.values.length
			|| !Array.isArray(answer.labels) || answer.labels.length !== answer.values.length || answer.labels.some((item) => typeof item !== "string" || !item)
			|| typeof answer.custom !== "boolean" || !isFiniteNumber(answer.answeredAt)) return false;
		if (question.kind === "single" && answer.values.length !== 1) return false;
		if (question.kind === "text" && (!answer.custom || answer.values.length !== 1)) return false;
		if (!answer.custom) {
			const options = new Map(question.options.map((option) => [option.value, option.label]));
			if (answer.values.some((item, index) => options.get(item) !== answer.labels[index])) return false;
		} else if ((question.kind !== "text" && !question.allowOther)
			|| answer.values.length !== 1 || answer.labels[0] !== answer.values[0]) return false;
	}
	if (state.currentQuestionId !== undefined && !ids.has(state.currentQuestionId)) return false;
	const clarificationIds = new Set<number>();
	for (const item of state.clarifications) {
		if (!isPlainRecord(item)
			|| !Number.isSafeInteger(item.id) || item.id <= 0 || clarificationIds.has(item.id)
			|| (item.questionId !== undefined && (typeof item.questionId !== "string" || !ids.has(item.questionId)))
			|| typeof item.question !== "string" || !item.question
			|| (item.response !== undefined && (typeof item.response !== "string" || !item.response))
			|| !isFiniteNumber(item.askedAt)
			|| (item.respondedAt !== undefined && (!isFiniteNumber(item.respondedAt) || item.response === undefined))) return false;
		clarificationIds.add(item.id);
	}
	const visible = new Set(visibleQuestions(state).map((question) => question.id));
	if (Object.keys(state.answers).some((id) => !visible.has(id))) return false;
	if (state.clarifications.some((item) => item.questionId !== undefined && !visible.has(item.questionId))) return false;
	if (state.phase === "completed" && (!state.final || !isReadyForReview(state))) return false;
	return true;
}

export function questionnaireStateFromSnapshot(value: unknown): QuestionnaireState | undefined {
	if (!isPlainRecord(value) || !isQuestionnaireState(value.state)) return undefined;
	return cloneQuestionnaireState(value.state);
}

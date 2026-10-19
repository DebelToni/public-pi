import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { Editor, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type EditorTheme } from "@earendil-works/pi-tui";
import {
	addClarification,
	commitAnswer,
	hasAnswer,
	isReadyForReview,
	type QuestionDefinition,
	type QuestionnaireState,
	visibleQuestions,
} from "./state.js";

export type PanelEvent =
	| { kind: "continue" | "clarification" | "cancel" }
	| { kind: "lifecycle"; reason: "session_shutdown" | "session_tree" };

type EditMode = { kind: "answer" | "clarification"; questionId: string };

function compact(value: string, max = 72) {
	const text = value.replace(/\s+/g, " ").trim();
	return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

export class QuestionnairePanel implements Component, Focusable {
	private _focused = false;
	private page = 0;
	private optionCursor = new Map<string, number>();
	private multiDraft = new Map<string, Set<string>>();
	private editMode?: EditMode;
	private editor: Editor;
	private drafts = new Map<string, string>();
	private abortConfirm = false;
	private scrollOffset = 0;
	private manualScroll = false;
	private interaction?: (event: PanelEvent) => void;
	private passiveDismiss?: () => void;
	private toggleFocus?: () => void;
	private waiting = false;
	private cacheKey?: string;
	private cachedLines?: string[];

	constructor(
		private state: QuestionnaireState,
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly onStateChange: (state: QuestionnaireState) => void,
	) {
		this.waiting = state.phase === "waiting_model";
		this.editor = this.makeEditor();
		this.selectInitialPage();
		this.beginTextQuestion();
	}

	get focused() {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value && this.editMode !== undefined;
	}

	setState(state: QuestionnaireState) {
		this.state = state;
		this.waiting = state.phase === "waiting_model";
		this.abortConfirm = false;
		this.editMode = undefined;
		this.optionCursor.clear();
		this.multiDraft.clear();
		this.drafts.clear();
		this.scrollOffset = 0;
		this.editor = this.makeEditor();
		this.selectInitialPage();
		this.beginTextQuestion();
		this.invalidate();
		this.tui.requestRender();
	}

	setInteraction(handler: (event: PanelEvent) => void) {
		this.interaction = handler;
		this.passiveDismiss = undefined;
		this.waiting = false;
		this.invalidate();
		this.tui.requestRender();
	}

	setPassive(onDismiss: () => void) {
		this.interaction = undefined;
		this.passiveDismiss = onDismiss;
		this.waiting = true;
		this.invalidate();
		this.tui.requestRender();
	}

	setFocusToggle(handler: () => void) {
		this.toggleFocus = handler;
	}

	private draftKey(mode: EditMode) {
		return `${mode.kind}:${mode.questionId}`;
	}

	private makeEditor() {
		const editorTheme: EditorTheme = {
			borderColor: (text) => this.theme.fg("borderMuted", text),
			selectList: {
				selectedPrefix: (text) => this.theme.fg("accent", text),
				selectedText: (text) => this.theme.fg("accent", text),
				description: (text) => this.theme.fg("muted", text),
				scrollInfo: (text) => this.theme.fg("dim", text),
				noMatch: (text) => this.theme.fg("warning", text),
			},
		};
		const editor = new Editor(this.tui, editorTheme);
		editor.onSubmit = (value) => this.submitInput(value);
		editor.onChange = (value) => {
			if (this.editMode) this.drafts.set(this.draftKey(this.editMode), value);
		};
		return editor;
	}

	private selectInitialPage() {
		const questions = visibleQuestions(this.state);
		const current = this.state.currentQuestionId
			? questions.findIndex((question) => question.id === this.state.currentQuestionId)
			: -1;
		const unanswered = questions.findIndex((question) => !hasAnswer(this.state, question.id));
		const clarification = [...this.state.clarifications].reverse().find((item) => item.questionId
			&& (item.response === undefined || item.respondedAt === this.state.updatedAt));
		const clarified = clarification?.questionId
			? questions.findIndex((question) => question.id === clarification.questionId)
			: -1;
		this.page = clarified >= 0 ? clarified : unanswered >= 0 ? unanswered : current >= 0 ? current : questions.length;
		this.manualScroll = clarified >= 0;
		this.scrollOffset = clarified >= 0 ? Number.MAX_SAFE_INTEGER : 0;
		this.syncQuestionDraft();
	}

	private questions() {
		return visibleQuestions(this.state);
	}

	private currentQuestion() {
		return this.questions()[this.page];
	}

	private syncQuestionDraft() {
		const question = this.currentQuestion();
		if (!question) return;
		const answer = this.state.answers[question.id];
		if (question.kind === "multi" && !this.multiDraft.has(question.id)) {
			this.multiDraft.set(question.id, new Set(answer?.custom ? [] : answer?.values ?? []));
		}
		if (answer && !answer.custom) {
			const index = question.options.findIndex((option) => option.value === answer.values[0]);
			if (index >= 0) this.optionCursor.set(question.id, index);
		}
	}

	private movePage(delta: number) {
		const count = this.questions().length + 1;
		this.page = Math.max(0, Math.min(count - 1, this.page + delta));
		this.abortConfirm = false;
		this.scrollOffset = 0;
		this.manualScroll = false;
		this.syncQuestionDraft();
		this.beginTextQuestion();
		this.refresh();
	}

	private advance() {
		const questions = this.questions();
		const nextUnanswered = questions.findIndex((question, index) => index > this.page && !hasAnswer(this.state, question.id));
		this.page = nextUnanswered >= 0 ? nextUnanswered : Math.min(this.page + 1, questions.length);
		this.scrollOffset = 0;
		this.manualScroll = false;
		this.syncQuestionDraft();
		this.beginTextQuestion();
		this.refresh();
	}

	private pruneInvalidatedDrafts() {
		const visible = new Set(this.questions().map((question) => question.id));
		for (const id of this.multiDraft.keys()) {
			if (!hasAnswer(this.state, id)) this.multiDraft.delete(id);
		}
		for (const key of this.drafts.keys()) {
			const separator = key.indexOf(":");
			if (separator >= 0 && !visible.has(key.slice(separator + 1))) this.drafts.delete(key);
		}
	}

	private persist() {
		this.onStateChange(this.state);
		this.invalidate();
	}

	private beginInput(mode: EditMode, prefill = "") {
		this.editMode = mode;
		this.editor.setText(this.drafts.get(this.draftKey(mode)) ?? prefill);
		this.editor.focused = this.focused;
		this.scrollOffset = 0;
		this.manualScroll = false;
		this.refresh();
	}

	private beginTextQuestion() {
		const question = this.currentQuestion();
		if (this.waiting || !question || question.kind !== "text" || this.editMode) return;
		const hasThread = this.state.clarifications.some((item) => item.questionId === question.id);
		if (hasAnswer(this.state, question.id) || hasThread) return;
		this.beginInput({ kind: "answer", questionId: question.id });
	}

	private leaveInput() {
		this.editMode = undefined;
		this.editor.focused = false;
		this.scrollOffset = 0;
		this.manualScroll = false;
		this.refresh();
	}

	private submitInput(value: string) {
		const text = value.trim();
		if (!text || !this.editMode) return;
		const mode = this.editMode;
		this.drafts.delete(this.draftKey(mode));
		if (mode.kind === "clarification") {
			addClarification(this.state, mode.questionId, text);
			this.persist();
			this.leaveInput();
			this.interaction?.({ kind: "clarification" });
			return;
		}
		commitAnswer(this.state, mode.questionId, [text], { custom: true });
		this.pruneInvalidatedDrafts();
		this.multiDraft.delete(mode.questionId);
		this.persist();
		this.leaveInput();
		this.advance();
	}

	private optionCount(question: QuestionDefinition) {
		return question.options.length + (question.allowOther ? 1 : 0) + 1;
	}

	private answerChoice(question: QuestionDefinition) {
		const index = this.optionCursor.get(question.id) ?? 0;
		if (index === this.optionCount(question) - 1) {
			this.beginInput({ kind: "clarification", questionId: question.id });
			return;
		}
		if (index === question.options.length && question.allowOther) {
			const previous = this.state.answers[question.id];
			this.beginInput({ kind: "answer", questionId: question.id }, previous?.custom ? previous.values[0] ?? "" : "");
			return;
		}
		const option = question.options[index];
		if (!option) return;
		if (question.kind === "single") {
			commitAnswer(this.state, question.id, [option.value]);
			this.pruneInvalidatedDrafts();
			this.persist();
			this.advance();
			return;
		}
		const selected = this.multiDraft.get(question.id) ?? new Set<string>();
		if (selected.size === 0) return;
		commitAnswer(this.state, question.id, [...selected]);
		this.pruneInvalidatedDrafts();
		this.persist();
		this.advance();
	}

	private toggleMulti(question: QuestionDefinition) {
		const index = this.optionCursor.get(question.id) ?? 0;
		if (index === this.optionCount(question) - 1 || index === question.options.length && question.allowOther) {
			this.answerChoice(question);
			return;
		}
		const option = question.options[index];
		if (!option) return;
		const selected = this.multiDraft.get(question.id) ?? new Set<string>();
		if (selected.has(option.value)) selected.delete(option.value);
		else selected.add(option.value);
		this.multiDraft.set(question.id, selected);
		this.refresh();
	}

	private finish() {
		if (!isReadyForReview(this.state)) return;
		this.interaction?.({ kind: "continue" });
	}

	private isTextEntry(data: string) {
		return data.includes("\x1b[200~") || (data.length > 0 && data.charCodeAt(0) >= 32 && !data.startsWith("\x1b"));
	}

	private handleEditorInput(data: string) {
		this.editor.handleInput(data);
		this.refresh();
	}

	handleInput(data: string) {
		if (matchesKey(data, "alt+q")) {
			this.toggleFocus?.();
			return;
		}
		if (this.waiting) {
			if (matchesKey(data, Key.escape)) this.passiveDismiss?.();
			return;
		}
		if (this.editMode) {
			if (matchesKey(data, Key.escape)) this.leaveInput();
			else this.handleEditorInput(data);
			return;
		}
		if (this.abortConfirm) {
			if (data.toLowerCase() === "y" || matchesKey(data, Key.enter)) this.interaction?.({ kind: "cancel" });
			else if (data.toLowerCase() === "n" || matchesKey(data, Key.escape)) {
				this.abortConfirm = false;
				this.refresh();
			}
			return;
		}
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.abortConfirm = true;
			this.refresh();
			return;
		}
		if (data.toLowerCase() === "c") {
			const question = this.currentQuestion();
			if (question) {
				this.beginInput({ kind: "clarification", questionId: question.id });
				return;
			}
		}
		if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
			const amount = Math.max(1, Math.floor((this.tui.terminal.rows || 24) / 2));
			this.manualScroll = true;
			this.scrollOffset = Math.max(0, this.scrollOffset + (matchesKey(data, Key.pageUp) ? -amount : amount));
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.left)) {
			this.movePage(-1);
			return;
		}
		if (matchesKey(data, Key.right)) {
			this.movePage(1);
			return;
		}
		const question = this.currentQuestion();
		if (!question) {
			if (matchesKey(data, Key.up)) {
				this.scrollOffset = Math.max(0, this.scrollOffset - 1);
				this.refresh();
			} else if (matchesKey(data, Key.down)) {
				this.scrollOffset++;
				this.refresh();
			} else if (matchesKey(data, Key.enter)) this.finish();
			return;
		}
		if (question.kind === "text") {
			if (matchesKey(data, Key.enter) || this.isTextEntry(data)) {
				this.beginInput({ kind: "answer", questionId: question.id }, this.state.answers[question.id]?.values[0] ?? "");
				if (!matchesKey(data, Key.enter)) this.handleEditorInput(data);
			}
			return;
		}
		const count = this.optionCount(question);
		const index = this.optionCursor.get(question.id) ?? 0;
		if (index === question.options.length && question.allowOther && this.isTextEntry(data)) {
			this.answerChoice(question);
			this.handleEditorInput(data);
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.manualScroll = false;
			this.optionCursor.set(question.id, Math.max(0, index - 1));
			this.refresh();
		} else if (matchesKey(data, Key.down)) {
			this.manualScroll = false;
			this.optionCursor.set(question.id, Math.min(count - 1, index + 1));
			this.refresh();
		} else if (question.kind === "multi" && matchesKey(data, Key.space)) {
			this.toggleMulti(question);
		} else if (matchesKey(data, Key.enter)) {
			this.answerChoice(question);
		}
	}

	private addWrapped(lines: string[], width: number, text: string, prefix = "") {
		const prefixWidth = visibleWidth(prefix);
		const available = Math.max(1, width - prefixWidth);
		const wrapped = wrapTextWithAnsi(text, available);
		for (let index = 0; index < wrapped.length; index++) {
			lines.push(`${index === 0 ? prefix : " ".repeat(prefixWidth)}${wrapped[index]}`);
		}
	}

	private generalMessage() {
		const message = this.state.message;
		return message && !this.state.clarifications.some((item) => item.response === message) ? message : undefined;
	}

	private clarificationLines(questionId: string, width: number) {
		const lines: string[] = [];
		for (const item of this.state.clarifications.filter((candidate) => candidate.questionId === questionId)) {
			lines.push("");
			this.addWrapped(lines, width, item.question, this.theme.fg("muted", "You: "));
			if (item.response) this.addWrapped(lines, width, item.response, this.theme.fg("accent", "Agent: "));
			else if (this.waiting) lines.push(this.theme.fg("muted", "Agent is working…"));
		}
		return lines;
	}

	private questionLines(question: QuestionDefinition, width: number) {
		const lines: string[] = [];
		this.addWrapped(lines, width, this.theme.bold(question.prompt));
		lines.push("");
		const answer = this.state.answers[question.id];
		if (question.kind === "text") {
			const draft = this.drafts.get(`answer:${question.id}`);
			const value = draft || answer?.labels[0];
			if (value) this.addWrapped(lines, width, this.theme.fg(answer && !draft ? "success" : "muted", value));
			lines.push(...this.clarificationLines(question.id, width));
			return lines;
		}
		const cursor = this.optionCursor.get(question.id) ?? 0;
		const draft = this.multiDraft.get(question.id) ?? new Set<string>();
		for (let index = 0; index < this.optionCount(question); index++) {
			const option = question.options[index];
			const isClarify = index === this.optionCount(question) - 1;
			const selected = !isClarify && (question.kind === "multi"
				? option ? draft.has(option.value) : answer?.custom === true
				: option ? answer?.custom !== true && answer?.values[0] === option.value : answer?.custom === true);
			const marker = isClarify ? "?" : question.kind === "multi" ? (selected ? "[x]" : "[ ]") : (selected ? "●" : "○");
			const pointer = index === cursor ? this.theme.fg("accent", "›") : " ";
			const label = isClarify ? "Ask a question (wait for agent)" : option ? option.label : "Write an answer (moves on)";
			this.addWrapped(lines, width, index === cursor ? this.theme.fg("accent", label) : label, `${pointer} ${marker} `);
			if (option?.description) this.addWrapped(lines, width, this.theme.fg("muted", option.description), "      ");
		}
		lines.push(...this.clarificationLines(question.id, width));
		return lines;
	}

	private reviewLines(width: number) {
		const lines: string[] = [this.theme.bold(this.state.final ? "Review and submit" : "Review")];
		lines.push("");
		for (const question of this.questions()) {
			const answer = this.state.answers[question.id];
			const label = question.label ?? compact(question.prompt, 34);
			if (!answer) {
				this.addWrapped(lines, width, this.theme.fg("warning", `${label}: unanswered`));
				lines.push(...this.clarificationLines(question.id, width));
				continue;
			}
			this.addWrapped(lines, width, `${this.theme.fg("muted", `${label}: `)}${answer.labels.join(", ")}`);
			lines.push(...this.clarificationLines(question.id, width));
		}
		if (!isReadyForReview(this.state)) {
			lines.push("");
			lines.push(this.theme.fg("warning", "Answer every active question before continuing"));
		}
		return lines;
	}

	private waitingLines(width: number) {
		const lines: string[] = [this.theme.bold("Agent is working")];
		const message = this.generalMessage();
		if (message) {
			lines.push("");
			this.addWrapped(lines, width, message);
		}
		return lines;
	}

	render(width: number) {
		const height = Math.max(1, this.tui.terminal.rows || 24);
		const key = `${width}:${height}:${this.state.revision}:${this.page}:${this.scrollOffset}:${this.manualScroll}:${this.focused}:${this.waiting}:${this.abortConfirm}:${this.editMode?.kind ?? ""}:${this.editor.getText()}:${[...this.optionCursor].map(([id, value]) => `${id}:${value}`).join("|")}:${[...this.multiDraft].map(([id, values]) => `${id}:${[...values].join(",")}`).join("|")}`;
		if (this.cacheKey === key && this.cachedLines) return this.cachedLines;
		const padding = width >= 8 ? 2 : 0;
		const innerWidth = Math.max(1, width - padding * 2);
		const content: string[] = [];
		const heading = this.state.title === "Questionnaire" ? "Questionnaire" : `Questionnaire · ${this.state.title}`;
		this.addWrapped(content, innerWidth, this.theme.fg("accent", this.theme.bold(heading)));
		content.push("");
		const generalMessage = this.generalMessage();
		if (generalMessage && !this.waiting) {
			this.addWrapped(content, innerWidth, this.theme.fg("muted", generalMessage));
			content.push("");
		}
		if (this.abortConfirm) {
			content.push(this.theme.fg("warning", this.theme.bold("Abort questionnaire?")));
			this.addWrapped(content, innerWidth, "Saved answers remain in session history.");
		} else if (this.editMode) {
			const editMode = this.editMode;
			const question = this.questions().find((candidate) => candidate.id === editMode.questionId);
			if (question) {
				const questions = this.questions();
				content.push(this.theme.fg("muted", `${questions.indexOf(question) + 1} / ${questions.length}`));
				content.push("");
				if (editMode.kind === "clarification") {
					content.push(...this.questionLines(question, innerWidth));
					content.push("");
					content.push(...this.editor.render(innerWidth));
				} else {
					this.addWrapped(content, innerWidth, this.theme.bold(question.prompt));
					content.push(...this.clarificationLines(question.id, innerWidth));
					content.push("");
					content.push(...this.editor.render(innerWidth));
				}
			}
		} else if (this.waiting) {
			const pending = [...this.state.clarifications].reverse().find((item) => item.response === undefined && item.questionId);
			const question = pending?.questionId ? this.questions().find((candidate) => candidate.id === pending.questionId) : undefined;
			if (question) {
				const questions = this.questions();
				content.push(this.theme.fg("muted", `${questions.indexOf(question) + 1} / ${questions.length}`));
				content.push("");
				content.push(...this.questionLines(question, innerWidth));
			} else content.push(...this.waitingLines(innerWidth));
		} else {
			const questions = this.questions();
			const question = this.currentQuestion();
			if (question) {
				content.push(this.theme.fg("muted", `${this.page + 1} / ${questions.length}`));
				content.push("");
				content.push(...this.questionLines(question, innerWidth));
			} else {
				content.push(...this.reviewLines(innerWidth));
			}
		}
		const footer = this.hint();
		const footerRows = footer && height > 1 ? 1 : 0;
		const maxContent = Math.max(1, height - footerRows);
		let visible = content;
		if (content.length > maxContent) {
			const fixedCount = Math.min(2, content.length, Math.max(0, maxContent - 1));
			const fixed = content.slice(0, fixedCount);
			const body = content.slice(fixedCount);
			const bodyRows = maxContent - fixedCount;
			const selectedLine = body.findIndex((line) => line.includes("›"));
			const desired = this.editMode
				? Math.max(0, body.length - bodyRows)
				: this.manualScroll
					? this.scrollOffset
					: selectedLine >= 0
						? Math.max(0, selectedLine - Math.floor(bodyRows / 2))
						: this.scrollOffset;
			const start = Math.max(0, Math.min(desired, Math.max(0, body.length - bodyRows)));
			this.scrollOffset = start;
			const bodyWindow = body.slice(start, start + bodyRows);
			if (start > 0 && bodyWindow.length) bodyWindow[0] = this.theme.fg("dim", "↑ more");
			if (start + bodyRows < body.length && bodyWindow.length) bodyWindow[bodyWindow.length - 1] = this.theme.fg("dim", "↓ more");
			visible = [...fixed, ...bodyWindow];
		}
		while (visible.length < maxContent) visible.push("");
		if (footerRows) visible.push(this.theme.fg("dim", truncateToWidth(footer, innerWidth, "…")));
		const side = " ".repeat(padding);
		const lines = visible.map((line) => {
			const clipped = truncateToWidth(line, innerWidth, "…");
			return `${side}${clipped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)))}${side}`;
		});
		this.cacheKey = key;
		this.cachedLines = lines;
		return lines;
	}

	private hint() {
		if (this.waiting) return "Alt+Q switch focus";
		if (this.abortConfirm) return "Enter/Y abort · Esc/N keep answering";
		if (this.editMode?.kind === "clarification") return "Enter ask · Esc keep draft · Shift+Enter/Ctrl+J newline · Alt+Q focus";
		if (this.editMode) {
			const followUp = this.state.clarifications.some((item) => item.questionId === this.editMode?.questionId && item.response);
			return `Enter save · Esc then C ${followUp ? "follow-up" : "clarify"} (draft kept) · Shift+Enter/Ctrl+J newline`;
		}
		const question = this.currentQuestion();
		if (!question) return this.state.final
			? "←→ questions · ↑↓ scroll · Enter submit · Esc abort"
			: "←→ questions · ↑↓ scroll · Enter continue · Esc abort";
		const hasThread = this.state.clarifications.some((item) => item.questionId === question.id);
		const clarify = this.state.clarifications.some((item) => item.questionId === question.id && item.response)
			? "C follow-up"
			: "C clarify";
		const threadScroll = hasThread ? " · PgUp/PgDn thread" : "";
		if (question.kind !== "text" && (this.optionCursor.get(question.id) ?? 0) === this.optionCount(question) - 1)
			return `${clarify}${threadScroll} · Enter ask · ←→ questions · Esc abort`;
		if (question.kind === "multi") return `${clarify}${threadScroll} · ↑↓ move · Space toggle · Enter save · ←→ questions · Esc abort`;
		if (question.kind === "text") return `${clarify}${threadScroll} · Type to edit · ←→ questions · Esc abort`;
		return `${clarify}${threadScroll} · ↑↓ move · Enter save · ←→ questions · Esc abort`;
	}

	invalidate() {
		this.cacheKey = undefined;
		this.cachedLines = undefined;
		this.editor.invalidate();
	}

	private refresh() {
		this.invalidate();
		this.tui.requestRender();
	}
}

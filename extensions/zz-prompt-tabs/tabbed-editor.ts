import { AsyncLocalStorage } from "node:async_hooks";
import { CustomEditor, type AppKeybinding, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
	truncateToWidth,
	type AutocompleteProvider,
	type EditorTheme,
	type TUI,
} from "@earendil-works/pi-tui";

type Draft = {
	editor: CustomEditor;
	boundHandlers: Map<AppKeybinding, () => void>;
	revision: number;
};

type TabbedEditorOptions = {
	createEditor: () => CustomEditor;
	isIdle: () => boolean;
	recall: (actualQueuedText: string) => string[];
	onFooterChange: (text: string | undefined) => void;
	onStateChange: (snapshot: DraftTabsSnapshot) => void;
	onSubmitError: (error: unknown) => void;
};

type DequeueCapture = {
	currentText: string;
	combinedText?: string;
};

export type DraftTabsSnapshot = {
	texts: string[];
	activeIndex: number;
};

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return typeof value === "object" && value !== null && "then" in value && typeof value.then === "function";
}

function queuedPart(combinedText: string, currentText: string) {
	if (!currentText.trim()) return combinedText;
	const suffix = `\n\n${currentText}`;
	return combinedText.endsWith(suffix) ? combinedText.slice(0, -suffix.length) : combinedText;
}

function draftSummary(text: string) {
	const summary = text.replace(/\s+/g, " ").trim() || "new prompt";
	return truncateToWidth(summary, 20, "…");
}

export class TabbedEditor extends CustomEditor {
	private drafts: Draft[] = [];
	private activeIndex = 0;
	private sharedHistory: string[] = [];
	private autocomplete?: AutocompleteProvider;
	private editorPaddingX = 0;
	private tabAutocompleteMaxVisible = 5;
	private dequeueCapture?: DequeueCapture;
	private ignoreNextTransferredText = false;
	private mutationDepth = 0;
	private mutationSnapshot?: DraftTabsSnapshot;
	private stateDirty = false;
	private readonly submissionContext = new AsyncLocalStorage<Draft>();
	private readonly appKeybindings: KeybindingsManager;
	private readonly options: TabbedEditorOptions;

	constructor(tui: TUI, editorTheme: EditorTheme, appKeybindings: KeybindingsManager, options: TabbedEditorOptions) {
		super(tui, editorTheme, appKeybindings);
		this.appKeybindings = appKeybindings;
		this.options = options;
		this.mutationDepth = 1;
		this.createDraft("");
		this.mutationDepth = 0;
		this.stateDirty = false;
	}

	private activeDraft() {
		return this.drafts[this.activeIndex]!;
	}

	private targetDraft() {
		return this.submissionContext.getStore() ?? this.activeDraft();
	}

	private stateChanged() {
		if (this.mutationDepth > 0) {
			this.stateDirty = true;
			return;
		}
		this.options.onStateChange(this.getSnapshot());
	}

	private runMutation<T>(callback: () => T, rollback?: DraftTabsSnapshot): T {
		const outermost = this.mutationDepth === 0;
		const previousSnapshot = this.mutationSnapshot;
		let completed = false;
		if (outermost) this.mutationSnapshot = rollback;
		this.mutationDepth++;
		try {
			const result = callback();
			completed = true;
			return result;
		} catch (error) {
			if (outermost && rollback) this.replaceSnapshot(rollback, false);
			throw error;
		} finally {
			this.mutationDepth--;
			if (outermost) {
				const publish = completed && this.stateDirty;
				this.stateDirty = false;
				this.mutationSnapshot = previousSnapshot;
				if (publish) this.options.onStateChange(this.getSnapshot());
			}
		}
	}

	private bindDraftHandlers(draft: Draft) {
		draft.editor.onEscape = () => this.submissionContext.run(draft, () => this.onEscape?.());
		draft.editor.onCtrlD = () => this.submissionContext.run(draft, () => this.onCtrlD?.());
		draft.editor.onPasteImage = () => this.submissionContext.run(draft, () => this.onPasteImage?.());
		draft.editor.onExtensionShortcut = (data) => this.submissionContext.run(
			draft,
			() => this.onExtensionShortcut?.(data) ?? false,
		);
		const unchanged = draft.boundHandlers.size === this.actionHandlers.size
			&& [...this.actionHandlers].every(([action, handler]) => draft.boundHandlers.get(action) === handler);
		if (unchanged) return;
		draft.boundHandlers = new Map(this.actionHandlers);
		const handlers = new Map(this.actionHandlers);
		for (const [action, handler] of handlers) {
			handlers.set(action, () => this.submissionContext.run(draft, handler));
		}
		draft.editor.actionHandlers = handlers;
	}

	private createDraft(text: string) {
		const editor = this.options.createEditor();
		editor.setPaddingX(this.editorPaddingX);
		editor.setAutocompleteMaxVisible(this.tabAutocompleteMaxVisible);
		const draft: Draft = { editor, boundHandlers: new Map(), revision: 0 };
		this.bindDraftHandlers(draft);
		editor.onSubmit = (value) => this.submitDraft(draft, value);
		editor.onChange = (value) => {
			draft.revision++;
			if (!this.drafts.includes(draft)) return;
			if (this.activeDraft() === draft) this.onChange?.(value);
			this.publishFooter();
			this.stateChanged();
		};
		// Represent child-editor borders as empty lines; render() removes them
		// without guessing whether legitimate prompt text is a border.
		editor.borderColor = () => "";
		editor.disableSubmit = this.disableSubmit;
		if (this.autocomplete) editor.setAutocompleteProvider(this.autocomplete);
		for (const historyItem of [...this.sharedHistory].reverse()) editor.addToHistory(historyItem);
		this.drafts.push(draft);
		editor.setText(text);
		this.stateChanged();
		return draft;
	}

	private after(value: unknown, callback: () => void) {
		if (isPromiseLike(value)) {
			void Promise.resolve(value).then(callback, callback);
		} else {
			callback();
		}
	}

	private runSubmission(draft: Draft, text: string, submit: () => unknown) {
		const index = this.drafts.indexOf(draft);
		if (index < 0) return false;
		const currentText = draft.editor.getExpandedText();
		const originalText = this.mutationSnapshot?.texts[index] ?? (currentText || text);
		// Pi's editor callback is fire-and-forget: a non-throwing invocation is the
		// acceptance boundary. Keep the existing immediate pop for async handlers.
		const result = this.submissionContext.run(draft, submit);
		const replacement = this.popDraft(draft);
		const replacementRevision = replacement?.revision;
		if (isPromiseLike(result)) {
			void Promise.resolve(result).catch((error) => {
				this.restoreRejectedSubmission(draft, index, originalText, replacement, replacementRevision);
				this.options.onSubmitError(error);
			});
		}
		return true;
	}

	private submitDraft(draft: Draft, text: string) {
		const submit = this.onSubmit as ((value: string) => unknown) | undefined;
		if (!submit) return false;
		return this.runSubmission(draft, text, () => submit(text));
	}

	private restoreRejectedSubmission(
		draft: Draft,
		index: number,
		originalText: string,
		replacement?: Draft,
		replacementRevision?: number,
	) {
		this.runMutation(() => {
			if (this.drafts.includes(draft)) return;
			const replacementIndex = replacement ? this.drafts.indexOf(replacement) : -1;
			if (replacementIndex >= 0 && replacement!.revision === replacementRevision) {
				replacement!.editor.focused = false;
				this.drafts.splice(replacementIndex, 1);
				if (replacementIndex < this.activeIndex) this.activeIndex--;
				else if (replacementIndex === this.activeIndex) {
					this.activeIndex = Math.min(replacementIndex, Math.max(0, this.drafts.length - 1));
				}
			}
			draft.editor.setText(originalText);
			const insertionIndex = Math.max(0, Math.min(index, this.drafts.length));
			this.drafts.splice(insertionIndex, 0, draft);
			this.activeIndex = insertionIndex;
			this.syncActiveEditor();
			this.onChange?.(this.getText());
			this.publishFooter();
			this.stateChanged();
			this.tui.requestRender();
		});
	}

	private popDraft(draft: Draft) {
		const index = this.drafts.indexOf(draft);
		if (index < 0) return undefined;
		let replacement: Draft | undefined;
		if (this.drafts.length === 1) {
			draft.editor.focused = false;
			this.drafts = [];
			this.activeIndex = 0;
			replacement = this.createDraft("");
		} else {
			draft.editor.focused = false;
			const wasActive = index === this.activeIndex;
			this.drafts.splice(index, 1);
			if (index < this.activeIndex) this.activeIndex--;
			else if (wasActive) this.activeIndex = Math.min(index, this.drafts.length - 1);
		}
		this.syncActiveEditor();
		this.onChange?.(this.getText());
		this.publishFooter();
		this.stateChanged();
		this.tui.requestRender();
		return replacement;
	}

	private footerText() {
		if (this.drafts.length <= 1) return undefined;
		const tabs = this.drafts.map((draft, index) => {
			const marker = index === this.activeIndex ? "●" : "○";
			return `${marker} ${index + 1}:${draftSummary(draft.editor.getText())}`;
		});
		return `prompts ${this.activeIndex + 1}/${this.drafts.length}  ${tabs.join(" │ ")}`;
	}

	private publishFooter() {
		this.options.onFooterChange(this.footerText());
	}

	private syncActiveEditor() {
		for (const [index, draft] of this.drafts.entries()) {
			draft.editor.focused = this.focused && index === this.activeIndex;
			this.bindDraftHandlers(draft);
		}
		const editor = this.activeDraft().editor;
		editor.borderColor = () => "";
		editor.disableSubmit = this.disableSubmit;
	}

	private activate(index: number) {
		if (index < 0 || index >= this.drafts.length || index === this.activeIndex) return;
		this.activeIndex = index;
		this.syncActiveEditor();
		this.onChange?.(this.getText());
		this.publishFooter();
		this.stateChanged();
		this.tui.requestRender();
	}

	newDraft(text = "") {
		this.runMutation(() => {
			this.createDraft(text);
			this.activate(this.drafts.length - 1);
		});
	}

	previousDraft() {
		this.runMutation(() => this.activate((this.activeIndex - 1 + this.drafts.length) % this.drafts.length));
	}

	nextDraft() {
		this.runMutation(() => this.activate((this.activeIndex + 1) % this.drafts.length));
	}

	closeCurrentDraft() {
		this.runMutation(() => this.popDraft(this.activeDraft()));
	}

	submitCurrentDraft() {
		const snapshot = this.getSnapshot();
		return this.runMutation(() => {
			const draft = this.activeDraft();
			const text = draft.editor.getExpandedText().trim();
			if (!text) return false;
			return this.submitDraft(draft, text);
		}, snapshot);
	}

	addRecalledDrafts(texts: string[]) {
		this.runMutation(() => {
			let added = 0;
			for (const text of texts) {
				if (!text.trim()) continue;
				this.createDraft(text);
				added++;
			}
			if (added > 0) this.activate(this.drafts.length - 1);
		});
	}

	getDraftTexts() {
		return this.drafts.map((draft) => draft.editor.getText());
	}

	getActiveIndex() {
		return this.activeIndex;
	}

	getSnapshot(): DraftTabsSnapshot {
		return {
			texts: this.drafts.map((draft) => draft.editor.getExpandedText()),
			activeIndex: this.activeIndex,
		};
	}

	private replaceSnapshot(snapshot: DraftTabsSnapshot, ignoreTransferredText: boolean) {
		if (snapshot.texts.length === 0) return;
		for (const draft of this.drafts) draft.editor.focused = false;
		this.drafts = [];
		this.activeIndex = 0;
		for (const text of snapshot.texts) this.createDraft(text);
		this.activeIndex = Math.max(0, Math.min(snapshot.activeIndex, this.drafts.length - 1));
		this.ignoreNextTransferredText = ignoreTransferredText;
		this.syncActiveEditor();
		this.publishFooter();
		this.stateChanged();
		this.tui.requestRender();
	}

	restoreSnapshot(snapshot: DraftTabsSnapshot) {
		this.runMutation(() => this.replaceSnapshot(snapshot, true));
	}

	private handleFollowUp() {
		const draft = this.activeDraft();
		const text = draft.editor.getExpandedText().trim();
		if (!text) return;
		if (this.options.isIdle()) {
			draft.editor.setText("");
			if (!this.submitDraft(draft, text)) draft.editor.setText(text);
			return;
		}
		const handler = this.actionHandlers.get("app.message.followUp") as (() => unknown) | undefined;
		if (!handler) return;
		this.runSubmission(draft, text, handler);
	}

	private captureQueuedMessages(handler: () => unknown) {
		const capture: DequeueCapture = { currentText: this.getText() };
		this.dequeueCapture = capture;
		let result: unknown;
		try {
			result = handler();
		} finally {
			this.dequeueCapture = undefined;
		}
		this.after(result, () => {
			if (capture.combinedText === undefined) return;
			const actualQueuedText = queuedPart(capture.combinedText, capture.currentText);
			this.addRecalledDrafts(this.options.recall(actualQueuedText));
		});
	}

	private handleDequeue() {
		const handler = this.actionHandlers.get("app.message.dequeue") as (() => unknown) | undefined;
		if (handler) this.captureQueuedMessages(handler);
	}

	private handleInputMutation(data: string) {
		// Legacy terminals encode Option+[ and Option+] as bare ESC-prefixed
		// punctuation, which Pi cannot represent through registerShortcut.
		if (data === "\x1b[") {
			this.previousDraft();
			return;
		}
		if (data === "\x1b]") {
			this.nextDraft();
			return;
		}
		if (this.appKeybindings.matches(data, "app.interrupt") && !this.activeDraft().editor.isShowingAutocomplete() && !this.options.isIdle()) {
			if (this.onEscape) this.captureQueuedMessages(this.onEscape);
			return;
		}
		if (this.appKeybindings.matches(data, "app.exit") && !this.getText()) {
			for (let offset = 1; offset < this.drafts.length; offset++) {
				const index = (this.activeIndex + offset) % this.drafts.length;
				if (this.drafts[index]!.editor.getText()) {
					this.activate(index);
					return;
				}
			}
		}
		if (this.appKeybindings.matches(data, "app.message.followUp")) {
			this.handleFollowUp();
			return;
		}
		if (this.appKeybindings.matches(data, "app.message.dequeue")) {
			this.handleDequeue();
			return;
		}
		this.syncActiveEditor();
		this.activeDraft().editor.handleInput(data);
	}

	override handleInput(data: string): void {
		const snapshot = this.getSnapshot();
		this.runMutation(() => this.handleInputMutation(data), snapshot);
	}

	override getText() {
		return this.targetDraft().editor.getText();
	}

	override getExpandedText() {
		return this.targetDraft().editor.getExpandedText();
	}

	override getLines() {
		return this.targetDraft().editor.getLines();
	}

	override getCursor() {
		return this.targetDraft().editor.getCursor();
	}

	override setText(text: string): void {
		if (this.ignoreNextTransferredText) {
			this.ignoreNextTransferredText = false;
			return;
		}
		if (this.dequeueCapture) {
			this.dequeueCapture.combinedText = text;
			return;
		}
		this.targetDraft().editor.setText(text);
	}

	override insertTextAtCursor(text: string): void {
		this.targetDraft().editor.insertTextAtCursor(text);
	}

	override addToHistory(text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		if (this.sharedHistory[0] !== trimmed) {
			this.sharedHistory.unshift(trimmed);
			if (this.sharedHistory.length > 100) this.sharedHistory.pop();
		}
		for (const draft of this.drafts) draft.editor.addToHistory(trimmed);
	}

	override getPaddingX() {
		return this.editorPaddingX;
	}

	override setPaddingX(padding: number): void {
		this.editorPaddingX = padding;
		for (const draft of this.drafts) draft.editor.setPaddingX(padding);
	}

	override getAutocompleteMaxVisible() {
		return this.tabAutocompleteMaxVisible;
	}

	override setAutocompleteMaxVisible(maxVisible: number): void {
		this.tabAutocompleteMaxVisible = maxVisible;
		for (const draft of this.drafts) draft.editor.setAutocompleteMaxVisible(maxVisible);
	}

	override setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.autocomplete = provider;
		for (const draft of this.drafts) draft.editor.setAutocompleteProvider(provider);
	}

	override render(width: number): string[] {
		if (width <= 0) return [];
		this.syncActiveEditor();
		return this.activeDraft().editor.render(width).filter((line) => line !== "");
	}

	override invalidate(): void {
		super.invalidate();
		for (const draft of this.drafts) draft.editor.invalidate();
	}
}

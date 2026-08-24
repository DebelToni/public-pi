export type QueueBehavior = "steer" | "followUp";

export type QueuedDraft = {
	text: string;
	behavior: QueueBehavior;
};

export class QueuedDraftTracker {
	private entries: QueuedDraft[] = [];

	private orderedEntries() {
		return [
			...this.entries.filter((entry) => entry.behavior === "steer"),
			...this.entries.filter((entry) => entry.behavior === "followUp"),
		];
	}

	track(text: string, behavior: QueueBehavior) {
		const trimmed = text.trim();
		if (trimmed) this.entries.push({ text: trimmed, behavior });
	}

	consume(text: string) {
		let entry = this.entries.find((candidate) => candidate.text === text.trim());
		// Skill/template expansion changes the delivered text. Queue order still
		// identifies the consumed draft even when its serialized text differs.
		entry ??= this.orderedEntries()[0];
		if (!entry) return;
		const index = this.entries.indexOf(entry);
		this.entries.splice(index, 1);
	}

	recall(actualQueuedText: string): string[] {
		const actual = actualQueuedText.trim();
		const ordered = this.orderedEntries();
		this.entries = [];
		if (!actual) return [];
		const tracked = ordered.map((entry) => entry.text);
		if (tracked.join("\n\n") === actual) return tracked;
		// Pi expands /skill and /template only after the input hook. Restoring the
		// original invocations keeps those queued prompts separate and editable.
		if (tracked.some((text) => text.startsWith("/"))) return tracked;
		return [actual];
	}

	reset() {
		this.entries = [];
	}

	get size() {
		return this.entries.length;
	}
}

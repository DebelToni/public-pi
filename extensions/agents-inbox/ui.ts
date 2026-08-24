import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { AgentCategory, AgentInboxItem } from "./snapshot.js";
import type { Classification } from "./classifier.js";

const CATEGORIES: Array<{ key: AgentCategory; title: string; icon: string }> = [
	{ key: "working", title: "WORKING", icon: "●" },
	{ key: "ready", title: "READY", icon: "✓" },
	{ key: "attention", title: "NEEDS ATTENTION", icon: "!" },
];

type TuiHandle = { requestRender(): void; terminal?: { rows: number } };

function safeDisplay(value: string) {
	return value
		.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "")
		.replace(/[\r\n\t]+/g, " ");
}

function pad(value: string, width: number) {
	const truncated = truncateToWidth(value, width, "…");
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

export class AgentsInboxComponent {
	private categoryIndex = 0;
	private rowIndex = 0;
	private selectedPaneId?: string;
	private closed = false;

	constructor(
		private readonly tui: TuiHandle,
		private readonly theme: Theme,
		private readonly items: AgentInboxItem[],
		private readonly done: (item: AgentInboxItem | undefined) => void,
	) {
		this.ensureSelection();
	}

	private inCategory(category: AgentCategory) {
		return this.items.filter((item) => item.category === category);
	}

	private currentItems() {
		return this.inCategory(CATEGORIES[this.categoryIndex].key);
	}

	private ensureSelection(preferredPaneId = this.selectedPaneId) {
		if (preferredPaneId) {
			const item = this.items.find((candidate) => candidate.paneId === preferredPaneId);
			if (item) {
				const categoryIndex = CATEGORIES.findIndex((category) => category.key === item.category);
				const categoryItems = this.inCategory(item.category);
				this.categoryIndex = categoryIndex;
				this.rowIndex = Math.max(0, categoryItems.findIndex((candidate) => candidate.paneId === item.paneId));
				this.selectedPaneId = item.paneId;
				return;
			}
		}
		for (let offset = 0; offset < CATEGORIES.length; offset++) {
			const index = (this.categoryIndex + offset) % CATEGORIES.length;
			const candidates = this.inCategory(CATEGORIES[index].key);
			if (!candidates.length) continue;
			this.categoryIndex = index;
			this.rowIndex = Math.min(this.rowIndex, candidates.length - 1);
			this.selectedPaneId = candidates[this.rowIndex].paneId;
			return;
		}
		this.selectedPaneId = undefined;
		this.rowIndex = 0;
	}

	private moveCategory(delta: number) {
		for (let step = 1; step <= CATEGORIES.length; step++) {
			const index = (this.categoryIndex + delta * step + CATEGORIES.length * 4) % CATEGORIES.length;
			const candidates = this.inCategory(CATEGORIES[index].key);
			if (!candidates.length) continue;
			this.categoryIndex = index;
			this.rowIndex = Math.min(this.rowIndex, candidates.length - 1);
			this.selectedPaneId = candidates[this.rowIndex].paneId;
			return;
		}
	}

	private moveRow(delta: number) {
		const candidates = this.currentItems();
		if (!candidates.length) return;
		this.rowIndex = (this.rowIndex + delta + candidates.length) % candidates.length;
		this.selectedPaneId = candidates[this.rowIndex].paneId;
	}

	update(item: AgentInboxItem, result: Classification) {
		if (this.closed) return;
		const selected = this.selectedPaneId;
		item.category = result.category;
		item.status = result.status;
		item.pending = false;
		this.ensureSelection(selected);
		this.tui.requestRender();
	}

	handleInput(data: string) {
		if (matchesKey(data, "escape") || data === "q") {
			this.closed = true;
			this.done(undefined);
			return;
		}
		if (matchesKey(data, "return")) {
			const selected = this.currentItems()[this.rowIndex];
			if (selected) {
				this.closed = true;
				this.done(selected);
			}
			return;
		}
		if (data === "h" || matchesKey(data, "left")) this.moveCategory(-1);
		else if (data === "l" || matchesKey(data, "right")) this.moveCategory(1);
		else if (data === "j" || matchesKey(data, "down")) this.moveRow(1);
		else if (data === "k" || matchesKey(data, "up")) this.moveRow(-1);
		this.tui.requestRender();
	}

	private styleItemLine(value: string, width: number, selected: boolean) {
		const cell = pad(value, width);
		return selected ? this.theme.bg("selectedBg", this.theme.fg("text", cell)) : this.theme.fg("text", cell);
	}

	private itemLines(item: AgentInboxItem, width: number, selected: boolean) {
		const location = safeDisplay(`${item.tmuxSessionName}:${item.windowIndex}.${item.paneIndex}`);
		const title = safeDisplay(item.title);
		const heading = ` ${selected ? "›" : " "} ${location} — ${title}`;
		const progress = item.pending ? "… " : "";
		const status = `${progress}${safeDisplay(item.status)}`;
		const wrappedStatus = wrapTextWithAnsi(status, Math.max(1, width - 5));
		return [
			this.styleItemLine(heading, width, selected),
			...wrappedStatus.map((line) => this.styleItemLine(`     ${line}`, width, selected)),
		];
	}

	render(width: number) {
		const content: Array<{ text: string; selected?: boolean }> = [];
		let selectedLine = 0;
		for (let categoryIndex = 0; categoryIndex < CATEGORIES.length; categoryIndex++) {
			const category = CATEGORIES[categoryIndex];
			const categoryItems = this.inCategory(category.key);
			const active = categoryIndex === this.categoryIndex;
			const label = ` ${category.icon} ${category.title} (${categoryItems.length})`;
			content.push({
				text: pad(active ? this.theme.fg("accent", this.theme.bold(label)) : this.theme.fg("muted", label), width),
			});
			content.push({ text: this.theme.fg("border", "─".repeat(width)) });
			if (!categoryItems.length) content.push({ text: this.theme.fg("dim", pad("     (none)", width)) });
			for (let row = 0; row < categoryItems.length; row++) {
				const selected = active && row === this.rowIndex;
				const lines = this.itemLines(categoryItems[row], width, selected);
				if (selected) selectedLine = content.length;
				for (const text of lines) content.push({ text, selected });
			}
			if (categoryIndex < CATEGORIES.length - 1) content.push({ text: "" });
		}

		const terminalRows = Math.max(8, this.tui.terminal?.rows ?? 24);
		const pending = this.items.filter((item) => item.pending).length;
		const help = pending
			? `h/l category · j/k agent · Enter jump · Esc close · … Luna classifying ${pending}`
			: "h/l category · j/k agent · Enter jump · Esc close · Luna status ready";
		const header = this.theme.fg("accent", this.theme.bold(pad(" AGENTS", width)));
		const available = Math.max(1, terminalRows - 3);
		let start = Math.max(0, Math.min(selectedLine - Math.floor(available / 2), content.length - available));
		let visible = content.slice(start, start + available).map((line) => line.text);
		if (start > 0) visible[0] = this.theme.fg("dim", pad(` ↑ ${start} more lines`, width));
		if (start + available < content.length) visible[visible.length - 1] = this.theme.fg("dim", pad(` ↓ ${content.length - start - available} more lines`, width));
		while (visible.length < available) visible.push("");
		return [header, ...visible, this.theme.fg("border", "─".repeat(width)), this.theme.fg("dim", pad(help, width))];
	}

	invalidate() {}
	dispose() { this.closed = true; }
}

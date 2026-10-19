import { resultOutput, type ResultTranscript } from "./result-store.js";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { MonitorMessageRenderer } from "./monitor-messages.js";
import type { MonitorRun, MonitorSummary, MonitorStoreEvent, MonitorTranscriptEntry } from "./monitor.js";
import { SubagentMonitorStore } from "./monitor.js";

const MONITOR_SHORTCUT = "alt+a";
const MONITOR_RENDER_INTERVAL_MS = 200;

type RenderContext = {
	toolCallId: string;
	lastComponent?: Component;
	isError?: boolean;
};

type ResultLike = {
	agent?: string;
	task?: string;
	exitCode?: number;
	status?: string;
	stopReason?: string;
	errorMessage?: string;
	stderr?: string;
	model?: string;
	step?: number;
	messages?: any[];
	finalText?: string;
	transcript?: ResultTranscript;
};

type ToolResultLike = {
	content: Array<{ type: string; text?: string }>;
	details?: any;
};

function compact(value: unknown, max: number) {
	if (typeof value !== "string") return "";
	const text = value.replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

export function formatMonitorDuration(milliseconds: number) {
	const safeMilliseconds = Math.max(0, milliseconds);
	if (safeMilliseconds < 1000) return `${Math.round(safeMilliseconds)}ms`;
	if (safeMilliseconds < 10_000) return `${(safeMilliseconds / 1000).toFixed(1)}s`;
	const seconds = Math.floor(safeMilliseconds / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	if (minutes < 60) return `${minutes}:${String(remainder).padStart(2, "0")}`;
	const hours = Math.floor(minutes / 60);
	return `${hours}:${String(minutes % 60).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function phaseIcon(run: Pick<MonitorRun, "phase">) {
	switch (run.phase) {
		case "queued": return "○";
		case "completed": return "✓";
		case "failed": return "✗";
		case "interrupted": return "Ⅱ";
		default: return "●";
	}
}

function phaseColor(run: Pick<MonitorRun, "phase">): "success" | "error" | "warning" | "muted" | "accent" | "dim" {
	switch (run.phase) {
		case "completed": return "success";
		case "failed": return "error";
		case "interrupted": return "muted";
		case "queued": return "dim";
		default: return "warning";
	}
}

function isActive(run: MonitorRun) {
	return run.phase !== "queued" && run.phase !== "completed" && run.phase !== "failed" && run.phase !== "interrupted";
}

function runElapsed(run: MonitorRun, now = Date.now()) {
	return Math.max(0, (run.endedAt ?? now) - (run.startedAt ?? run.queuedAt));
}

function summaryText(summary: MonitorSummary) {
	const parts: string[] = [];
	if (summary.active) parts.push(`${summary.active} active`);
	if (summary.queued) parts.push(`${summary.queued} queued`);
	return parts.join(" · ") || "idle";
}

export function formatMonitorStatus(summary: MonitorSummary) {
	if (summary.total === 0) return undefined;
	return `agents ${summaryText(summary)} · Alt+A`;
}

function sortRuns(runs: MonitorRun[]) {
	return [...runs];
}

function fit(text: string, width: number) {
	if (width <= 0) return "";
	const clipped = truncateToWidth(text, width, "…");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function styledIcon(run: MonitorRun, theme: Theme) {
	return theme.fg(phaseColor(run), phaseIcon(run));
}

function shortModel(model?: string) {
	if (!model) return "";
	return model.replace(/^.*\//, "").replace(/:high$/, "");
}

type TranscriptView = {
	pageSize: number;
	width: number;
	followTail: boolean;
	followOnEnd: boolean;
	atEnd: boolean;
	anchor?: { id: number; line: number };
	entries: MonitorTranscriptEntry[];
};

export class SubagentMonitorComponent implements Component {
	private selectedRunId?: string;
	private tabStart = 0;
	private toolsExpanded = false;
	private notesOnly = false;
	private showThinking = true;
	private readonly views = new Map<string, TranscriptView>();
	private readonly messages = new MonitorMessageRenderer();
	private closing = false;
	private disposed = false;
	private renderTimer?: ReturnType<typeof setTimeout>;
	private tickTimer?: ReturnType<typeof setInterval>;
	private unsubscribe: () => void;
	private visibleRevision = 0;
	private pendingRevision = 0;
	private clockRevision = 0;
	private cacheKey?: string;
	private cachedLines?: string[];

	constructor(
		private readonly store: SubagentMonitorStore,
		private readonly sessionId: string,
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly close: () => void,
	) {
		this.visibleRevision = store.revision;
		this.pendingRevision = store.revision;
		this.unsubscribe = store.subscribe((event) => this.onStoreEvent(event));
		this.tickTimer = setInterval(() => {
			if (this.store.getSummary(this.sessionId).active > 0) {
				this.clockRevision++;
				this.clearCache();
				this.tui.requestRender();
			}
		}, 1000);
		this.tickTimer.unref?.();
		queueMicrotask(() => {
			if (!this.disposed && this.store.getSummary(this.sessionId).total === 0) this.closePanel();
		});
	}

	handleInput(data: string) {
		if (data === "q" || matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, MONITOR_SHORTCUT)) {
			this.closePanel();
			return;
		}
		const runs = this.visibleRuns();
		this.ensureSelection(runs);
		if (!this.selectedRunId) return;
		const view = this.viewFor(this.selectedRunId);
		const pageStep = Math.max(1, view.pageSize - 2);
		const selectedIndex = runs.findIndex((run) => run.id === this.selectedRunId);
		if (matchesKey(data, "ctrl+alt+o") || data === "\x1b\x0f") this.notesOnly = !this.notesOnly;
		else if (matchesKey(data, "ctrl+o")) this.toolsExpanded = !this.toolsExpanded;
		else if (matchesKey(data, "ctrl+t")) this.showThinking = !this.showThinking;
		else if (matchesKey(data, "right") || matchesKey(data, "tab")) this.selectRun(runs[(selectedIndex + 1) % runs.length]!.id);
		else if (matchesKey(data, "left") || matchesKey(data, "shift+tab")) this.selectRun(runs[(selectedIndex - 1 + runs.length) % runs.length]!.id);
		else if (matchesKey(data, "up")) this.scroll(runs[selectedIndex]!, view, -pageStep);
		else if (matchesKey(data, "down")) this.scroll(runs[selectedIndex]!, view, pageStep);
		else if (matchesKey(data, "alt+up") || data === "\x1b\x1b[A" || matchesKey(data, "pageUp")) this.scroll(runs[selectedIndex]!, view, -view.pageSize);
		else if (matchesKey(data, "alt+down") || data === "\x1b\x1b[B" || matchesKey(data, "pageDown")) this.scroll(runs[selectedIndex]!, view, view.pageSize);
		else if (matchesKey(data, "home")) this.scroll(runs[selectedIndex]!, view, -Infinity);
		else if (matchesKey(data, "end")) this.scroll(runs[selectedIndex]!, view, Infinity);
		else return;
		this.clearCache();
		this.tui.requestRender();
	}

	render(width: number) {
		const height = Math.max(1, this.tui.terminal.rows || 24);
		const runs = this.visibleRuns();
		this.prune(runs);
		this.ensureSelection(runs);
		const key = `${width}:${height}:${this.visibleRevision}:${this.clockRevision}:${this.selectedRunId}:${this.toolsExpanded}:${this.notesOnly}:${this.showThinking}`;
		if (this.cacheKey === key && this.cachedLines) return this.cachedLines;
		if (width < 8) return Array.from({ length: height }, () => " ".repeat(Math.max(0, width)));

		const lines = [fit(this.renderTabs(runs, width), width)];
		const selected = runs.find((run) => run.id === this.selectedRunId);
		if (height > 1) {
			if (selected) {
				lines.push(fit(` ${styledIcon(selected, this.theme)} ${this.theme.fg("accent", selected.agent)} ${this.theme.fg("dim", `· ${formatMonitorDuration(runElapsed(selected))} · ${shortModel(selected.model) || "model pending"} · ${selected.phase}${this.notesOnly ? " · notes only" : ""}`)}`, width));
				if (height >= 16) lines.push(fit(this.theme.fg("dim", ` ${selected.kind} · ${selected.cwd ?? "cwd pending"}`), width));
			} else lines.push(fit(" No current subagents.", width));
		}
		if (selected && lines.length < height) {
			const view = this.viewFor(selected.id);
			const history = this.renderHistory(selected, width, height - lines.length, view);
			for (const line of history) lines.push(fit(line, width));
		}
		while (lines.length < height) lines.push(" ".repeat(width));
		this.cacheKey = key;
		this.cachedLines = lines;
		return lines;
	}

	invalidate() {
		this.messages.clear();
		this.clearCache();
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe();
		if (this.renderTimer) clearTimeout(this.renderTimer);
		if (this.tickTimer) clearInterval(this.tickTimer);
		this.renderTimer = undefined;
		this.tickTimer = undefined;
		this.messages.clear();
		this.views.clear();
	}

	private visibleRuns() {
		return sortRuns(this.store.getRuns(this.sessionId));
	}

	private selectRun(runId: string) {
		this.selectedRunId = runId;
		const view = this.viewFor(runId);
		view.followTail = true;
		view.followOnEnd = false;
	}

	private ensureSelection(runs: MonitorRun[]) {
		if (runs.length === 0) {
			this.selectedRunId = undefined;
			return;
		}
		if (!this.selectedRunId || !runs.some((run) => run.id === this.selectedRunId)) {
			this.selectRun(runs[0]!.id);
		}
	}

	private onStoreEvent(event: MonitorStoreEvent) {
		this.pendingRevision = event.revision;
		if (event.summaryChanged) this.prune(this.visibleRuns());
		if (this.store.getSummary(this.sessionId).total === 0) {
			this.closePanel();
			return;
		}
		this.requestRender(event.urgent);
	}

	private closePanel() {
		if (this.closing) return;
		this.closing = true;
		this.close();
	}

	private requestRender(urgent: boolean) {
		if (this.disposed) return;
		if (urgent) {
			if (this.renderTimer) clearTimeout(this.renderTimer);
			this.renderTimer = undefined;
			this.visibleRevision = this.pendingRevision;
			this.clearCache();
			this.tui.requestRender();
			return;
		}
		if (this.renderTimer) return;
		this.renderTimer = setTimeout(() => {
			this.renderTimer = undefined;
			if (!this.disposed) {
				this.visibleRevision = this.pendingRevision;
				this.clearCache();
				this.tui.requestRender();
			}
		}, MONITOR_RENDER_INTERVAL_MS);
		this.renderTimer.unref?.();
	}

	private prune(runs: MonitorRun[]) {
		this.messages.prune(runs);
		const ids = new Set(runs.map((run) => run.id));
		for (const id of this.views.keys()) if (!ids.has(id)) this.views.delete(id);
		for (const run of runs) {
			const view = this.views.get(run.id);
			if (!view) continue;
			const entryIds = new Set(run.transcript.map((entry) => entry.id));
			view.entries = view.entries.filter((entry) => entry.id === -1 || entryIds.has(entry.id));
		}
	}

	private viewFor(runId: string) {
		let view = this.views.get(runId);
		if (!view) {
			view = { pageSize: 1, width: 80, followTail: true, followOnEnd: false, atEnd: true, entries: [] };
			this.views.set(runId, view);
		}
		return view;
	}

	private entryLines(entry: MonitorTranscriptEntry, run: MonitorRun, width: number) {
		const lines = entry.id === -1
			? wrapTextWithAnsi(this.theme.fg("dim", ` ${run.omittedEntries} older history entries no longer retained.`), width)
			: this.messages.render(entry, run, width, this.toolsExpanded, !this.showThinking);
		return lines.length ? [...lines, ""] : [];
	}

	private scroll(run: MonitorRun, view: TranscriptView, amount: number) {
		view.followOnEnd = amount > 0;
		if (amount === Infinity || amount > 0 && view.atEnd) {
			view.followTail = true;
			return;
		}
		view.followTail = false;
		if (amount === -Infinity) {
			view.anchor = view.entries[0] ? { id: view.entries[0].id, line: 0 } : undefined;
			return;
		}
		let index = Math.max(0, view.entries.findIndex((entry) => entry.id === view.anchor?.id));
		let line = view.anchor?.line ?? 0;
		let remaining = Math.abs(amount);
		while (remaining > 0 && view.entries[index]) {
			const count = this.entryLines(view.entries[index]!, run, view.width).length;
			line = Math.min(line, Math.max(0, count - 1));
			if (amount < 0) {
				if (remaining <= line) { line -= remaining; break; }
				if (index === 0) { line = 0; break; }
				remaining -= line + 1;
				do {
					index--;
					line = this.entryLines(view.entries[index]!, run, view.width).length - 1;
				} while (index > 0 && line < 0);
				line = Math.max(0, line);
			} else {
				if (remaining < count - line) { line += remaining; break; }
				if (index === view.entries.length - 1) { view.followTail = true; break; }
				remaining -= count - line;
				index++;
				line = 0;
			}
		}
		if (view.entries[index]) view.anchor = { id: view.entries[index]!.id, line };
	}

	private tailAnchor(run: MonitorRun, view: TranscriptView) {
		let needed = view.pageSize;
		for (let index = view.entries.length - 1; index >= 0; index--) {
			const entry = view.entries[index]!;
			const count = this.entryLines(entry, run, view.width).length;
			if (count >= needed) return { id: entry.id, line: count - needed };
			needed -= count;
		}
		return view.entries[0] ? { id: view.entries[0].id, line: 0 } : undefined;
	}

	private renderHistory(run: MonitorRun, width: number, pageSize: number, view: TranscriptView): string[] {
		view.entries = run.transcript.filter((entry) => !this.notesOnly || entry.type === "prompt" || entry.type === "text");
		if (run.omittedEntries) {
			const firstUnpinned = view.entries.findIndex((entry) => entry.type === "tool" || !entry.pinned);
			view.entries.splice(firstUnpinned < 0 ? view.entries.length : firstUnpinned, 0, { id: -1, revision: run.omittedEntries, type: "text", text: "" });
		}
		view.width = width;
		view.pageSize = pageSize;
		if (view.followTail) view.anchor = this.tailAnchor(run, view);
		let start = view.entries.findIndex((entry) => entry.id === view.anchor?.id);
		if (start < 0) {
			start = Math.max(0, view.entries.findIndex((entry) => entry.id > (view.anchor?.id ?? 0)));
			view.anchor = view.entries[start] ? { id: view.entries[start]!.id, line: 0 } : undefined;
		}
		const visible: string[] = [];
		view.atEnd = true;
		for (let index = start; index < view.entries.length; index++) {
			const entry = view.entries[index]!;
			const lines = this.entryLines(entry, run, width);
			const offset = index === start ? Math.min(view.anchor?.line ?? 0, Math.max(0, lines.length - 1)) : 0;
			if (index === start && view.anchor) view.anchor.line = offset;
			const count = Math.min(lines.length - offset, pageSize - visible.length);
			if (count > 0) visible.push(...lines.slice(offset, offset + count));
			if (visible.length >= pageSize) {
				view.atEnd = index === view.entries.length - 1 && offset + count === lines.length;
				break;
			}
		}
		if (view.atEnd && view.followOnEnd && !view.followTail) {
			view.followTail = true;
			view.followOnEnd = false;
			return this.renderHistory(run, width, pageSize, view);
		}
		view.followOnEnd = false;
		return visible;
	}

	private renderTabs(runs: MonitorRun[], width: number) {
		if (!runs.length) return "";
		const selectedIndex = runs.findIndex((run) => run.id === this.selectedRunId);
		const available = Math.max(1, width - 4);
		const labels = runs.map((run, index) => truncateToWidth(`${phaseIcon(run)} ${index + 1}:${compact(run.agent, 64)}`, Math.max(1, Math.min(30, available - 2)), "…"));
		this.tabStart = Math.max(0, Math.min(this.tabStart, selectedIndex));
		let end = this.tabStart;
		let used = 0;
		for (;;) {
			end = this.tabStart;
			used = 0;
			while (end < runs.length && used + visibleWidth(labels[end]!) + 2 <= available) {
				used += visibleWidth(labels[end]!) + 2;
				end++;
			}
			if (end > selectedIndex || this.tabStart === selectedIndex) break;
			this.tabStart++;
		}
		const tabs = labels.slice(this.tabStart, end).map((label, index) => {
			const selected = this.tabStart + index === selectedIndex;
			return selected ? this.theme.bg("selectedBg", this.theme.fg("accent", this.theme.bold(`[${label}]`))) : this.theme.fg("muted", ` ${label} `);
		}).join("");
		return `${this.theme.fg("accent", this.tabStart ? "‹ " : "  ")}${tabs}${" ".repeat(Math.max(0, available - used))}${this.theme.fg("accent", end < runs.length ? " ›" : "  ")}`;
	}

	private clearCache() {
		this.cacheKey = undefined;
		this.cachedLines = undefined;
	}
}

function updateText(lastComponent: Component | undefined, text: string) {
	const component = lastComponent instanceof Text ? lastComponent : new Text("", 0, 0);
	component.setText(text);
	return component;
}

function resultPhase(result: ResultLike) {
	if (result.status === "completed") return "completed";
	if (result.status === "failed") return "failed";
	if (result.status === "interrupted" || result.status === "pending" || result.stopReason === "aborted") return "interrupted";
	if (result.exitCode === -1 || result.status === "running") return "running";
	if (result.exitCode === 0 && result.stopReason !== "error") return "completed";
	return "failed";
}

function resultIcon(result: ResultLike, theme: Theme) {
	const phase = resultPhase(result);
	if (phase === "completed") return theme.fg("success", "✓");
	if (phase === "failed") return theme.fg("error", "✗");
	if (phase === "interrupted") return theme.fg("muted", "Ⅱ");
	return theme.fg("warning", "●");
}

function finalOutput(result: ResultLike) {
	const reference = result.transcript ? `\nTranscript: ${result.transcript.directory} (${result.transcript.messageCount} records)` : "";
	return resultOutput(result) + reference;
}

function detailsResults(details: any): ResultLike[] {
	if (Array.isArray(details?.results)) return details.results;
	if (Array.isArray(details?.child?.results)) return details.child.results;
	if (details?.result) return [details.result];
	return [];
}

function renderRunResult(
	label: string,
	result: ToolResultLike,
	expanded: boolean,
	theme: Theme,
	context: RenderContext,
	store?: SubagentMonitorStore,
) {
	const monitored = store ? sortRuns(store.getOrchestrationRuns(context.toolCallId)) : [];
	const fallback = detailsResults(result.details);
	const hasMonitoredRuns = monitored.length > 0;
	const running = hasMonitoredRuns ? monitored.filter(isActive).length : fallback.filter((item) => resultPhase(item) === "running").length;
	const queued = hasMonitoredRuns ? monitored.filter((run) => run.phase === "queued").length : 0;
	const completed = hasMonitoredRuns ? monitored.filter((run) => run.phase === "completed").length : fallback.filter((item) => resultPhase(item) === "completed").length;
	const failed = hasMonitoredRuns ? monitored.filter((run) => run.phase === "failed").length : fallback.filter((item) => resultPhase(item) === "failed").length;
	const interrupted = hasMonitoredRuns ? monitored.filter((run) => run.phase === "interrupted").length : fallback.filter((item) => resultPhase(item) === "interrupted").length;
	const total = hasMonitoredRuns ? monitored.length : fallback.length;
	const toolFailed = context.isError === true;
	const icon = toolFailed || failed
		? theme.fg("error", "✗")
		: running || queued
			? theme.fg("warning", "●")
			: interrupted
				? theme.fg("muted", "Ⅱ")
				: theme.fg("success", "✓");
	const statuses = toolFailed
		? "failed"
		: [
			running ? `${running} active` : "",
			queued ? `${queued} queued` : "",
			completed ? `${completed} done` : "",
			failed ? `${failed} failed` : "",
			interrupted ? `${interrupted} paused` : "",
		].filter(Boolean).join(" · ") || (total ? `${total} runs` : "finished");
	let text = `${icon} ${theme.fg("toolTitle", theme.bold(label))} ${theme.fg("accent", statuses)}`;
	if (running || queued) text += theme.fg("dim", " · Alt+A inspect");

	if (monitored.length) {
		const display = expanded ? monitored : monitored.slice(0, 5);
		const unmatchedFallback = [...fallback];
		for (const run of display) {
			text += `\n  ${styledIcon(run, theme)} ${theme.fg("accent", run.agent)} ${theme.fg("muted", run.currentLabel)} ${theme.fg("dim", formatMonitorDuration(runElapsed(run)))}`;
			if (expanded) {
				text += `\n    ${theme.fg("dim", compact(run.task, 180))}`;
				let matchIndex = unmatchedFallback.findIndex((item) =>
					typeof item.step === "number" && run.slot !== undefined
						? item.step - 1 === run.slot
						: item.agent === run.agent && item.task === run.task,
				);
				if (matchIndex < 0 && run.kind === "named") {
					matchIndex = unmatchedFallback.findIndex((item) => item.agent === run.agent);
				}
				const detail = matchIndex >= 0 ? unmatchedFallback.splice(matchIndex, 1)[0] : undefined;
				const output = detail ? finalOutput(detail) : run.latestText;
				if (output) text += `\n    ${theme.fg("toolOutput", output.replace(/\n/g, "\n    "))}`;
				const error = detail?.errorMessage || detail?.stderr || run.error;
				if (error) text += `\n    ${theme.fg("error", error)}`;
			}
		}
		if (!expanded && monitored.length > display.length) text += `\n  ${theme.fg("dim", `… ${monitored.length - display.length} more`)}`;
	} else if (fallback.length) {
		const display = expanded ? fallback : fallback.slice(0, 5);
		for (const item of display) {
			text += `\n  ${resultIcon(item, theme)} ${theme.fg("accent", item.agent || "agent")} ${theme.fg("muted", resultPhase(item))}`;
			if (expanded && item.task) text += `\n    ${theme.fg("dim", compact(item.task, 180))}`;
			const output = expanded ? finalOutput(item) : "";
			if (output) text += `\n    ${theme.fg("toolOutput", output.replace(/\n/g, "\n    "))}`;
			const error = item.errorMessage || item.stderr;
			if (expanded && error) text += `\n    ${theme.fg("error", error)}`;
		}
	}

	if (!total || toolFailed) {
		const content = result.content.find((part) => part.type === "text")?.text;
		if (content) text += `\n${theme.fg(toolFailed ? "error" : "muted", toolFailed ? content : compact(content, 240))}`;
	}
	return updateText(context.lastComponent, text);
}

export function renderSubagentCall(args: any, theme: Theme, context: RenderContext) {
	const mode = args.tasks?.length
		? args.then ? `fan-in · ${args.tasks.length} → 1` : `parallel · ${args.tasks.length}`
		: args.chain?.length ? `chain · ${args.chain.length}` : "single";
	const name = args.agent ?? args.tasks?.[0]?.agent ?? args.chain?.[0]?.agent ?? "agent";
	const extra = args.then
		? ` → ${args.then.agent}`
		: args.tasks?.length > 1 ? ` +${args.tasks.length - 1}` : args.chain?.length > 1 ? ` +${args.chain.length - 1}` : "";
	return updateText(context.lastComponent, `${theme.fg("toolTitle", theme.bold("agents "))}${theme.fg("accent", mode)} ${theme.fg("muted", `· ${name}${extra}`)}`);
}

export function renderSubagentResult(result: ToolResultLike, options: { expanded: boolean }, theme: Theme, context: RenderContext, store?: SubagentMonitorStore) {
	return renderRunResult("agents", result, options.expanded, theme, context, store);
}

export function renderNamedInvokeCall(args: any, theme: Theme, context: RenderContext) {
	return updateText(context.lastComponent, `${theme.fg("toolTitle", theme.bold("agent "))}${theme.fg("accent", args.name ?? "…")} ${theme.fg("muted", "· invoke")}`);
}

export function renderNamedInvokeResult(result: ToolResultLike, options: { expanded: boolean }, theme: Theme, context: RenderContext, store?: SubagentMonitorStore) {
	const name = result.details?.name ?? "agent";
	return renderRunResult(name, result, options.expanded, theme, context, store);
}

export function renderNamedCreateCall(args: any, theme: Theme, context: RenderContext) {
	return updateText(context.lastComponent, `${theme.fg("toolTitle", theme.bold("agent thread "))}${theme.fg("accent", args.name ?? "…")} ${theme.fg("muted", `· create from ${args.template ?? "general"}`)}`);
}

export function renderNamedCreateResult(result: ToolResultLike, _options: { expanded: boolean }, theme: Theme, context: RenderContext) {
	const details = result.details;
	const content = result.content.find((part) => part.type === "text")?.text ?? "";
	if (!details?.name) {
		const icon = context.isError ? theme.fg("error", "✗") : theme.fg("muted", "·");
		return updateText(context.lastComponent, `${icon} ${theme.fg(context.isError ? "error" : "muted", compact(content, 240))}`);
	}
	return updateText(
		context.lastComponent,
		`${theme.fg("success", "✓")} ${theme.fg("accent", details.name)} ${theme.fg("muted", `idle thread · ${details.size ?? "default"} · history=${details.history ?? "none"}`)}`,
	);
}

export function installSubagentMonitorUI(pi: ExtensionAPI, store: SubagentMonitorStore) {
	let closeOverlay: (() => void) | undefined;
	let opening = false;
	let sessionCleanup: (() => void) | undefined;

	const openMonitor = async (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("The subagent monitor requires interactive TUI mode.", "warning");
			return;
		}
		if (closeOverlay) {
			closeOverlay();
			return;
		}
		if (opening) return;
		const sessionId = ctx.sessionManager.getSessionId();
		if (store.getSummary(sessionId).total === 0) {
			ctx.ui.notify("No current subagents.", "info");
			return;
		}
		opening = true;
		try {
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					const close = () => done();
					closeOverlay = close;
					return new SubagentMonitorComponent(store, sessionId, tui, theme, close);
				},
				{
					overlay: true,
					overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 },
				},
			);
		} finally {
			closeOverlay = undefined;
			opening = false;
		}
	};

	pi.registerCommand("subagents", {
		description: "Open the current session's live subagent monitor",
		handler: async (_args, ctx) => openMonitor(ctx),
	});
	pi.registerShortcut(MONITOR_SHORTCUT, {
		description: "Open the live subagent monitor",
		handler: async (ctx) => openMonitor(ctx),
	});

	pi.on("session_start", (_event, ctx) => {
		sessionCleanup?.();
		const sessionId = ctx.sessionManager.getSessionId();
		let lastStatus: string | undefined;
		const updateStatus = () => {
			const next = formatMonitorStatus(store.getSummary(sessionId));
			if (next === lastStatus) return;
			lastStatus = next;
			ctx.ui.setStatus("subagents", next);
		};
		const unsubscribe = store.subscribe((event) => {
			if (event.summaryChanged) updateStatus();
		});
		updateStatus();
		sessionCleanup = () => {
			unsubscribe();
			ctx.ui.setStatus("subagents", undefined);
		};
	});

	pi.on("session_shutdown", () => {
		closeOverlay?.();
		closeOverlay = undefined;
		opening = false;
		sessionCleanup?.();
		sessionCleanup = undefined;
	});

	return {
		isOpen: () => opening || closeOverlay !== undefined,
	};
}

import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	UserMessageComponent,
	ToolExecutionComponent,
	createBashToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	createEditToolDefinition,
	createGrepToolDefinition,
	createFindToolDefinition,
	createLsToolDefinition,
	getMarkdownTheme,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import type { MonitorRun, MonitorToolSpan, MonitorTranscriptEntry } from "./monitor.js";

// Cooperates with tool-hide without changing the parent transcript's visibility.
export const LOCAL_TRANSCRIPT_VISIBILITY = Symbol.for("anton.pi.local-transcript-visibility");
type Renderers = Pick<ToolDefinition<any, any, any>, "renderCall" | "renderResult" | "renderShell">;

type ChildContainer = { addChild(child: Component): unknown; clear(): unknown };

function isChildContainer(value: unknown): value is ChildContainer {
	return !!value && typeof (value as ChildContainer).addChild === "function" && typeof (value as ChildContainer).clear === "function";
}

export function monitorToolRenderers(tool: MonitorToolSpan, cwd: string): Renderers {
	const factories = {
		bash: createBashToolDefinition,
		read: createReadToolDefinition,
		write: createWriteToolDefinition,
		edit: createEditToolDefinition,
		grep: createGrepToolDefinition,
		find: createFindToolDefinition,
		ls: createLsToolDefinition,
	};
	const factory = Object.hasOwn(factories, tool.name) ? factories[tool.name as keyof typeof factories] : undefined;
	if (!factory) {
		return {
			renderCall(args, theme, context) {
				const header = theme.fg("toolTitle", theme.bold(tool.name));
				const argumentsText = typeof args === "string" ? args : JSON.stringify(args ?? {}, null, 2);
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(`${header}\n${argumentsText}`);
				return text;
			},
		};
	}
	// Only renderer slots are retained; no tool is registered or executed here.
	const { renderCall, renderResult, renderShell }: Renderers = factory(cwd);
	return {
		renderShell,
		renderCall: renderCall && ((args, theme, context) => {
			const component = renderCall(args, theme, {
				...context,
				// Native edit previews read files; shell previews start their own clocks.
				argsComplete: tool.name === "edit" ? false : context.argsComplete,
				executionStarted: tool.name === "bash" ? false : context.executionStarted,
			});
			if (tool.name === "edit" && context.expanded && !tool.result && isChildContainer(component)) {
				component.addChild(new Text(theme.fg("toolOutput", JSON.stringify(args, null, 2)), 0, 0));
			}
			return component;
		}),
		renderResult: renderResult && ((result, options, theme, context) => {
			const component = renderResult(result, options, theme, context);
			if (tool.name === "edit" && options.expanded && (context.isError || !result.details?.diff) && isChildContainer(component)) {
				component.addChild(new Text(theme.fg("toolOutput", JSON.stringify(context.args, null, 2)), 0, 0));
			}
			if (tool.name === "bash" && tool.endedAt !== undefined && isChildContainer(component)) {
				component.addChild(new Text(theme.fg("muted", `Took ${((tool.endedAt - tool.startedAt) / 1000).toFixed(1)}s`), 0, 0));
			}
			return component;
		}),
	};
}

function assistantMessage(entry: Exclude<MonitorTranscriptEntry, { type: "tool" }>): AssistantMessage {
	return {
		role: "assistant",
		content: entry.type === "thinking" ? [{ type: "thinking", thinking: entry.text }] : [{ type: "text", text: entry.text }],
		api: "openai-responses",
		provider: "monitor",
		model: "monitor",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: 0,
	};
}

function viewportLines(lines: string[], width: number) {
	// Prompt-zone markers belong to the main transcript, not a clipped overlay.
	const clean = lines.flatMap((line) => {
		const text = line.replace(/\x1b\]133;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
		return visibleWidth(text) > width ? wrapTextWithAnsi(text, width) : [text];
	});
	// Match Anton's compact TUI without depending on a patched package instance.
	const blank = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "").trim().length === 0;
	while (clean.length && blank(clean[0]!)) clean.shift();
	while (clean.length && blank(clean[clean.length - 1]!)) clean.pop();
	return clean;
}

type CachedMessage = {
	component: Component;
	revision: number;
	width: number;
	expanded: boolean;
	hideThinking: boolean;
	cwd: string;
	lines: string[];
};

export class MonitorMessageRenderer {
	private readonly cache = new Map<number, CachedMessage>();
	// Native tool setters request renders synchronously. The monitor already owns
	// scheduling; none of its renderer adapters start async work.
	private readonly passiveTui = { requestRender() {} } as TUI;

	render(entry: MonitorTranscriptEntry, run: MonitorRun, width: number, expanded: boolean, hideThinking: boolean) {
		const tool = entry.type === "tool" ? run.tools.find((candidate) => candidate.id === entry.toolId) : undefined;
		if (entry.type === "tool" && !tool) return [];
		const cwd = run.cwd ?? process.cwd();
		const revision = tool?.revision ?? entry.revision;
		const toolExpanded = entry.type === "tool" && expanded;
		const thinkingHidden = entry.type === "thinking" && hideThinking;
		let cached = this.cache.get(entry.id);
		if (cached && cached.revision === revision && cached.width === width && cached.expanded === toolExpanded && cached.hideThinking === thinkingHidden && cached.cwd === cwd) return cached.lines;

		if (!cached || cached.cwd !== cwd || entry.type === "prompt" && cached.revision !== revision) {
			const component = tool
				? new ToolExecutionComponent(tool.name, tool.id, tool.args, { showImages: false }, monitorToolRenderers(tool, cwd) as ToolDefinition, this.passiveTui, cwd)
				: entry.type === "prompt"
					? new UserMessageComponent(entry.label ? `**${entry.label}**\n\n${entry.text}` : entry.text, getMarkdownTheme(), 1)
					: new AssistantMessageComponent(undefined, thinkingHidden, getMarkdownTheme(), "Thinking…", 1);
			Object.assign(component, { [LOCAL_TRANSCRIPT_VISIBILITY]: true });
			cached = { component, revision: -1, width: -1, expanded: false, hideThinking: thinkingHidden, cwd, lines: [] };
			this.cache.set(entry.id, cached);
		}
		const component = cached.component;
		if (tool && component instanceof ToolExecutionComponent) {
			if (cached.expanded !== toolExpanded) component.setExpanded(toolExpanded);
			if (cached.revision !== revision) {
				component.updateArgs(tool.args);
				if (tool.argsComplete) component.setArgsComplete();
				if (tool.executionStarted) component.markExecutionStarted();
				if (tool.result) component.updateResult(tool.result, tool.endedAt === undefined);
			}
		} else if (entry.type !== "tool" && component instanceof AssistantMessageComponent) {
			if (cached.hideThinking !== thinkingHidden) component.setHideThinkingBlock(thinkingHidden);
			if (cached.revision !== revision) component.updateContent(assistantMessage(entry), entry.streaming ?? false);
		}
		cached.revision = revision;
		cached.width = width;
		cached.expanded = toolExpanded;
		cached.hideThinking = thinkingHidden;
		cached.lines = viewportLines(component.render(width), width);
		return cached.lines;
	}

	prune(runs: MonitorRun[]) {
		const liveIds = new Set(runs.flatMap((run) => run.transcript.map((entry) => entry.id)));
		for (const id of this.cache.keys()) if (!liveIds.has(id)) this.cache.delete(id);
	}

	clear() {
		this.cache.clear();
	}
}

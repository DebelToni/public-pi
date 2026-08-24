import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { stripAnsi } from "../modes/shared.js";

function codingAgentInternal(relativePath: string) {
	return new URL(relativePath, import.meta.resolve("@earendil-works/pi-coding-agent")).href;
}

let compactPatchesInstalled = false;
let compactResumeHintInstalled = false;

export function compactResumeHint(output: string) {
	return output.replace(
		/^(?:\x1b\[[0-?]*[ -/]*[@-~])*To resume this session:(?:\x1b\[[0-?]*[ -/]*[@-~])*[ \t]+/,
		"",
	);
}

function installCompactResumeHint() {
	if (compactResumeHintInstalled) return;
	compactResumeHintInstalled = true;
	const stdout = process.stdout as typeof process.stdout & { __piCompactResumeHint?: boolean };
	if (stdout.__piCompactResumeHint) return;
	const original = stdout.write;
	stdout.write = function (chunk: any, ...args: any[]) {
		const output = typeof chunk === "string" ? compactResumeHint(chunk) : chunk;
		return (original as any).call(this, output, ...args);
	} as typeof stdout.write;
	stdout.__piCompactResumeHint = true;
}

function isVisuallyBlank(line: string) {
	return stripAnsi(line).trim().length === 0;
}

function compactOuterPadding(lines: string[]) {
	let out = [...lines];
	while (out.length > 0 && isVisuallyBlank(out[0])) out.shift();
	while (out.length > 0 && isVisuallyBlank(out[out.length - 1])) out.pop();
	const compact: string[] = [];
	let previousBlank = false;
	for (const line of out) {
		const blank = isVisuallyBlank(line);
		if (blank && previousBlank) continue;
		compact.push(line);
		previousBlank = blank;
	}
	return compact;
}

function looksLikeBorder(line: string) {
	const plain = stripAnsi(line).trim();
	if (!plain) return true;
	return /^[╭╮╰╯┌┐└┘╔╗╚╝+\-|│║═─━┬┴┼├┤\s]+$/.test(plain);
}

function compactPromptLines(lines: string[]) {
	let out = compactOuterPadding(lines);
	if (out.length > 1 && looksLikeBorder(out[0])) out = out.slice(1);
	if (out.length > 1 && looksLikeBorder(out[out.length - 1])) out = out.slice(0, -1);
	return compactOuterPadding(out);
}

function visibleLen(text: string) {
	return stripAnsi(text).length;
}

function truncatePlain(text: string, maxWidth: number) {
	if (maxWidth <= 0) return "";
	let out = "";
	for (const ch of text) {
		if (visibleLen(out + ch) > maxWidth) break;
		out += ch;
	}
	return out;
}

function inlineAutocompleteLine(editor: any, width: number) {
	const list = editor.autocompleteList;
	if (!editor.autocompleteState || !list) return undefined;
	const items = list.filteredItems ?? [];
	if (items.length === 0) return undefined;
	const selectedIndex = Math.max(0, Math.min(list.selectedIndex ?? 0, items.length - 1));
	const ordered = [items[selectedIndex], ...items.filter((_: any, index: number) => index !== selectedIndex)];
	let line = "↹ ";
	for (const item of ordered) {
		const label = String(item?.label || item?.value || "");
		if (!label) continue;
		const piece = `${line.length > 2 ? ", " : ""}${item === items[selectedIndex] ? "→ " : ""}${label}`;
		if (visibleLen(line + piece) > width) {
			const remaining = width - visibleLen(line) - (line.length > 2 ? 2 : 0);
			if (remaining > 4) line += `${line.length > 2 ? ", " : ""}${truncatePlain(label, remaining - 1)}…`;
			break;
		}
		line += piece;
	}
	return truncatePlain(line, width);
}

async function installCompactPatches() {
	if (compactPatchesInstalled) return;
	compactPatchesInstalled = true;
	try {
		const tool = await import(codingAgentInternal("modes/interactive/components/tool-execution.js"));
		const proto = tool.ToolExecutionComponent?.prototype;
		if (proto?.render && !proto.__piCustomCompact) {
			const original = proto.render;
			proto.render = function (width: number) { return compactOuterPadding(original.call(this, width)); };
			proto.__piCustomCompact = true;
		}
	} catch {}
	try {
		const bash = await import(codingAgentInternal("modes/interactive/components/bash-execution.js"));
		const proto = bash.BashExecutionComponent?.prototype;
		if (proto?.render && !proto.__piCustomCompact) {
			const original = proto.render;
			proto.render = function (width: number) { return compactOuterPadding(original.call(this, width)); };
			proto.__piCustomCompact = true;
		}
	} catch {}
	try {
		const interactive = await import(codingAgentInternal("modes/interactive/interactive-mode.js"));
		const proto = interactive.InteractiveMode?.prototype;
		if (proto?.renderWidgetContainer && !proto.__piCustomCompactWidgets) {
			const original = proto.renderWidgetContainer;
			proto.renderWidgetContainer = function (container: any, widgets: Map<string, any>, _spacerWhenEmpty: boolean, _leadingSpacer: boolean) {
				return original.call(this, container, widgets, false, false);
			};
			proto.__piCustomCompactWidgets = true;
		}
		if (proto?.checkTmuxKeyboardSetup && !proto.__piCustomSuppressTmuxWarning) {
			proto.checkTmuxKeyboardSetup = async function () { return undefined; };
			proto.__piCustomSuppressTmuxWarning = true;
		}
	} catch {}
	try {
		const proto = Markdown.prototype as any;
		if (proto?.renderToken && !proto.__piCustomNoFenceLines) {
			const original = proto.renderToken;
			proto.renderToken = function (token: any, width: number, nextTokenType?: string, styleContext?: any) {
				if (token?.type !== "code") return original.call(this, token, width, nextTokenType, styleContext);
				const lines: string[] = [];
				const indent = this.theme.codeBlockIndent ?? "  ";
				if (this.theme.highlightCode) {
					for (const hlLine of this.theme.highlightCode(token.text, token.lang)) lines.push(`${indent}${hlLine}`);
				} else {
					for (const codeLine of String(token.text ?? "").split("\n")) lines.push(`${indent}${this.theme.codeBlock(codeLine)}`);
				}
				if (nextTokenType && nextTokenType !== "space") lines.push("");
				return lines;
			};
			proto.__piCustomNoFenceLines = true;
		}
	} catch {}
	for (const [file, exportName] of [
		["user-message.js", "UserMessageComponent"],
		["assistant-message.js", "AssistantMessageComponent"],
		["custom-message.js", "CustomMessageComponent"],
		["branch-summary-message.js", "BranchSummaryMessageComponent"],
	] as const) {
		try {
			const mod = await import(codingAgentInternal(`modes/interactive/components/${file}`));
			const proto = mod[exportName]?.prototype;
			if (proto?.render && !proto.__piCustomCompact) {
				const original = proto.render;
				proto.render = function (width: number) { return compactOuterPadding(original.call(this, width)); };
				proto.__piCustomCompact = true;
			}
		} catch {}
	}
}

class HackEditor extends CustomEditor {
	render(width: number): string[] {
		const hasAutocomplete = Boolean((this as any).autocompleteState && (this as any).autocompleteList);
		let inlineSuggestion: string | undefined;
		let savedState: any;
		let savedList: any;
		if (hasAutocomplete) {
			inlineSuggestion = inlineAutocompleteLine(this, width);
			savedState = (this as any).autocompleteState;
			savedList = (this as any).autocompleteList;
			(this as any).autocompleteState = null;
			(this as any).autocompleteList = undefined;
		}
		try {
			const lines = compactPromptLines(super.render(width));
			if (inlineSuggestion) lines.push(inlineSuggestion);
			return lines;
		} finally {
			if (hasAutocomplete) {
				(this as any).autocompleteState = savedState;
				(this as any).autocompleteList = savedList;
			}
		}
	}

}

export default async function (_pi: ExtensionAPI) {
	await installCompactPatches();

	_pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWorkingVisible(false);
		ctx.ui.setWorkingIndicator({ frames: [] });
		ctx.ui.setStatus("mode", undefined);
		ctx.ui.setEditorComponent((tui, theme, kb) => new HackEditor(tui, theme, kb));
	});

	_pi.on("session_shutdown", (event) => {
		if (event.reason === "quit") installCompactResumeHint();
	});
}

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { AgentCategory, PaneContext, TmuxAgentPane } from "./snapshot.js";

type SessionEntry = {
	type: string;
	id: string;
	parentId: string | null;
	message?: any;
};

function clip(value: string, limit: number) {
	const text = value.replace(/\0/g, "").trim();
	if (text.length <= limit) return text;
	const head = Math.ceil(limit * 0.58);
	const tail = Math.floor(limit * 0.38);
	return `${text.slice(0, head)}\n…[truncated]…\n${text.slice(-tail)}`;
}

function contentText(content: unknown) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part: any) => part?.type === "text" && typeof part.text === "string" ? part.text : "")
		.filter(Boolean)
		.join("\n");
}

function compactArgumentPreview(value: unknown) {
	let text: string;
	try { text = JSON.stringify(value); } catch { text = String(value); }
	return text.replace(/\s+/g, " ").slice(0, 120);
}

function summarizeSubagentDetails(details: any) {
	if (!Array.isArray(details?.results)) return "subagent ran; child history omitted";
	return details.results.map((result: any) => {
		const tools: Array<{ id: string; name: string; args: string; outcome?: string }> = [];
		const byId = new Map<string, { id: string; name: string; args: string; outcome?: string }>();
		for (const message of Array.isArray(result?.messages) ? result.messages : []) {
			if (message?.role === "assistant" && Array.isArray(message.content)) {
				for (const part of message.content) {
					if (part?.type !== "toolCall") continue;
					const tool = {
						id: String(part.id ?? ""),
						name: String(part.name ?? "tool"),
						args: compactArgumentPreview(part.arguments ?? {}),
					};
					tools.push(tool);
					if (tool.id) byId.set(tool.id, tool);
				}
			}
			if (message?.role === "toolResult") {
				const tool = byId.get(String(message.toolCallId ?? ""));
				if (!tool) continue;
				const error = message.isError ? contentText(message.content).replace(/\s+/g, " ").slice(0, 100) : "";
				tool.outcome = message.isError ? `error${error ? `: ${error}` : ""}` : "ok";
			}
		}
		const tail = tools.slice(-3).map((tool) => `${tool.name}(${tool.args}) ${tool.outcome ?? "pending"}`).join(" → ");
		const agent = String(result?.agent ?? "subagent");
		const status = String(result?.status ?? (result?.exitCode === 0 ? "completed" : "failed"));
		return `${agent} ${status}; last tools: ${tail || "none"}`;
	}).join("\n");
}

function compactSubagentEntry(entry: SessionEntry) {
	const message = entry.message;
	if (message?.role !== "toolResult" || message.toolName !== "subagent") return entry;
	message.subagentSummary = summarizeSubagentDetails(message.details);
	message.content = [{ type: "text", text: "Subagent child history omitted from inbox classification." }];
	delete message.details;
	return entry;
}

function envelope(line: string): SessionEntry | undefined {
	const typeMatch = line.match(/^\{"type":("(?:\\.|[^"\\])*")/);
	const baseMatch = line.match(/^\{"type":"[^"]+","id":("(?:\\.|[^"\\])*"),"parentId":(null|"(?:\\.|[^"\\])*")/)
		?? line.match(/,"id":("(?:\\.|[^"\\])*"),"parentId":(null|"(?:\\.|[^"\\])*"),"timestamp":"[^"]+"\}$/);
	if (!typeMatch || !baseMatch) return undefined;
	try {
		return {
			type: JSON.parse(typeMatch[1]),
			id: JSON.parse(baseMatch[1]),
			parentId: baseMatch[2] === "null" ? null : JSON.parse(baseMatch[2]),
		};
	} catch {
		return undefined;
	}
}

function parseLine(line: string): SessionEntry | undefined {
	const shell = envelope(line);
	if (!shell) return undefined;
	if (shell.type !== "message") return shell;
	try {
		const sanitized = line.replace(/("data"\s*:\s*")[^"]*(")/g, "$1[image omitted]$2");
		return compactSubagentEntry(JSON.parse(sanitized));
	} catch {
		return shell;
	}
}

const REVERSE_SCAN_BLOCK_BYTES = 1024 * 1024;
const MAX_FULL_LINE_BYTES = 1024 * 1024;
const LARGE_LINE_PREFIX_BYTES = 256 * 1024;
const LARGE_LINE_SUFFIX_BYTES = 64 * 1024;

function readRange(descriptor: number, start: number, length: number) {
	const buffer = Buffer.allocUnsafe(length);
	readSync(descriptor, buffer, 0, length, start);
	return buffer;
}

function previousNewline(descriptor: number, before: number) {
	let end = before;
	while (end > 0) {
		const start = Math.max(0, end - REVERSE_SCAN_BLOCK_BYTES);
		const buffer = readRange(descriptor, start, end - start);
		const index = buffer.lastIndexOf(0x0a);
		if (index !== -1) return start + index;
		end = start;
	}
	return -1;
}

function stringField(source: string, name: string, last = false) {
	const expression = new RegExp(`"${name}":("(?:\\\\.|[^"\\\\])*")`, "g");
	let value: string | undefined;
	for (const match of source.matchAll(expression)) {
		try { value = JSON.parse(match[1]); } catch {}
		if (!last && value !== undefined) return value;
	}
	return value;
}

function textParts(source: string) {
	const output: Array<{ type: "text"; text: string }> = [];
	const expression = /"type":"text","text":("(?:\\.|[^"\\])*")/g;
	for (const match of source.matchAll(expression)) {
		try { output.push({ type: "text", text: JSON.parse(match[1]) }); } catch {}
	}
	return output;
}

function parseLargeLine(prefix: string, suffix: string): SessionEntry | undefined {
	const source = `${prefix}${suffix}`;
	const shell = envelope(source);
	if (!shell || shell.type !== "message") return shell;
	const role = stringField(prefix, "role");
	if (!role) return shell;
	const message: any = { role, content: textParts(prefix) };
	if (role === "assistant") message.stopReason = stringField(source, "stopReason", true);
	if (role === "toolResult") {
		message.toolCallId = stringField(prefix, "toolCallId");
		message.toolName = stringField(prefix, "toolName");
		const errors = [...source.matchAll(/"isError":(true|false)/g)];
		message.isError = errors.at(-1)?.[1] === "true";
	}
	return { ...shell, message };
}

function parseEntrySpan(descriptor: number, start: number, end: number) {
	const length = end - start;
	if (length <= 0) return undefined;
	if (length <= MAX_FULL_LINE_BYTES) return parseLine(readRange(descriptor, start, length).toString("utf8"));
	const prefixLength = Math.min(LARGE_LINE_PREFIX_BYTES, length);
	const prefix = readRange(descriptor, start, prefixLength).toString("utf8");
	if (prefix.includes('"role":"toolResult"') && prefix.includes('"toolName":"subagent"')) {
		return parseLine(readRange(descriptor, start, length).toString("utf8"));
	}
	const suffixLength = Math.min(LARGE_LINE_SUFFIX_BYTES, length - prefixLength);
	const suffix = suffixLength > 0 ? readRange(descriptor, end - suffixLength, suffixLength).toString("utf8") : "";
	return parseLargeLine(prefix, suffix);
}

function activeBranch(path: string) {
	const descriptor = openSync(path, "r");
	try {
		const size = fstatSync(descriptor).size;
		let cursor = size;
		if (cursor > 0 && readRange(descriptor, cursor - 1, 1)[0] === 0x0a) cursor--;
		const reverse: SessionEntry[] = [];
		let wantedId: string | null | undefined;
		let foundLeaf = false;
		let foundUser = false;
		let foundPrecedingAssistant = false;
		let reachedRoot = false;

		while (cursor > 0) {
			const boundary = previousNewline(descriptor, cursor);
			const start = boundary + 1;
			const entry = parseEntrySpan(descriptor, start, cursor);
			cursor = Math.max(0, boundary);
			if (!entry) continue;
			if (!foundLeaf) foundLeaf = true;
			else if (entry.id !== wantedId) continue;
			reverse.push(entry);
			wantedId = entry.parentId;
			if (entry.message?.role === "user") foundUser = true;
			else if (foundUser && entry.message?.role === "assistant" && contentText(entry.message.content)) foundPrecedingAssistant = true;
			if (entry.parentId === null) {
				reachedRoot = true;
				break;
			}
			if (foundUser && foundPrecedingAssistant) break;
		}

		if (!foundLeaf) return { entries: [], contextUnavailable: false };
		const enoughContext = foundUser && (foundPrecedingAssistant || reachedRoot);
		return {
			entries: reverse.reverse(),
			contextUnavailable: !enoughContext && !reachedRoot,
		};
	} finally {
		closeSync(descriptor);
	}
}

function compactJson(value: unknown, limit = 700) {
	let raw: string;
	try { raw = JSON.stringify(value); } catch { raw = String(value); }
	return clip(raw, limit).replace(/\s+/g, " ");
}

function toolResultSummary(message: any) {
	const text = clip(contentText(message?.content), 900).replace(/\s+/g, " ");
	return `${message?.isError ? "error" : "ok"}: ${text || "(no text output)"}`;
}

function latestPromptIndex(entries: SessionEntry[]) {
	for (let index = entries.length - 1; index >= 0; index--) {
		if (entries[index].message?.role === "user") return index;
	}
	return -1;
}

function precedingAssistant(entries: SessionEntry[], promptIndex: number) {
	for (let index = promptIndex - 1; index >= 0; index--) {
		const message = entries[index].message;
		if (message?.role !== "assistant") continue;
		const text = contentText(message.content);
		if (text) return clip(text, 3200);
	}
	return "(none)";
}

function contextAfterPrompt(entries: SessionEntry[], promptIndex: number, activeToolCallId?: string) {
	const toolLines: string[] = [];
	const subagentLines: string[] = [];
	let current = "";
	let hasFinalOutput = false;
	let finalStopReason: string | undefined;
	let lastToolTimeoutMs: number | undefined;
	let unmatchedToolCall = false;
	let lastToolError = false;
	const pending = new Map<string, { name: string; rendered: string }>();

	for (const entry of entries.slice(promptIndex + 1)) {
		const message = entry.message;
		if (!message) continue;
		if (message.role === "assistant") {
			finalStopReason = typeof message.stopReason === "string" ? message.stopReason : finalStopReason;
			const text = contentText(message.content);
			hasFinalOutput = message.stopReason === "stop" && Boolean(text.trim());
			if (text) current = clip(text, 4200);
			for (const part of Array.isArray(message.content) ? message.content : []) {
				if (part?.type !== "toolCall") continue;
				const rendered = `${part.name} ${compactJson(part.arguments)}`;
				pending.set(String(part.id), { name: String(part.name), rendered });
				toolLines.push(`→ ${rendered}`);
				current = rendered;
				if (part.name === "bash" && String(part.id) === activeToolCallId && Number.isFinite(part.arguments?.timeout)) {
					lastToolTimeoutMs = Number(part.arguments.timeout) * 1000;
				}
			}
		}
		if (message.role === "toolResult") {
			hasFinalOutput = false;
			const isSubagent = message.toolName === "subagent" && typeof message.subagentSummary === "string";
			const result = isSubagent
				? `subagent ran; child history omitted\n${message.subagentSummary}`
				: toolResultSummary(message);
			(isSubagent ? subagentLines : toolLines).push(`← ${message.toolName}: ${result}`);
			current = `${message.toolName}: ${result}`;
			lastToolError = Boolean(message.isError);
			pending.delete(String(message.toolCallId));
		}
	}
	unmatchedToolCall = pending.size > 0;
	const selectedSubagents = subagentLines.slice(-4);
	const selectedTools = toolLines.slice(-(28 - selectedSubagents.length));
	const omitted = toolLines.length + subagentLines.length - selectedTools.length - selectedSubagents.length;
	const compactTools = [
		...(omitted > 0 ? [`(${omitted} earlier tool events omitted)`] : []),
		...selectedSubagents,
		...selectedTools,
	];
	return {
		tools: clip(compactTools.join("\n") || "(none)", 14_000),
		current: current || "(no response yet)",
		hasFinalOutput,
		finalStopReason,
		lastToolTimeoutMs,
		unmatchedToolCall,
		lastToolError,
	};
}

export function readPaneContext(pane: TmuxAgentPane): PaneContext {
	if (!pane.sessionFile) {
		return {
			previousAssistant: "(session file unavailable)",
			lastPrompt: "(session file unavailable)",
			tools: "(session file unavailable)",
			current: "(session file unavailable)",
			hasFinalOutput: false,
			unmatchedToolCall: false,
			lastToolError: false,
		};
	}
	const active = activeBranch(pane.sessionFile);
	if (active.contextUnavailable) {
		return {
			previousAssistant: "(recent session context unavailable)",
			lastPrompt: "(recent session context unavailable)",
			tools: "(recent session context unavailable)",
			current: "(recent session context unavailable)",
			hasFinalOutput: false,
			unmatchedToolCall: false,
			lastToolError: false,
			contextUnavailable: true,
		};
	}
	const branch = active.entries;
	const promptIndex = latestPromptIndex(branch);
	if (promptIndex < 0) {
		return {
			previousAssistant: "(none)",
			lastPrompt: "(no prompt yet)",
			tools: "(none)",
			current: "(idle session)",
			hasFinalOutput: false,
			unmatchedToolCall: false,
			lastToolError: false,
		};
	}
	const prompt = branch[promptIndex].message;
	return {
		previousAssistant: precedingAssistant(branch, promptIndex),
		lastPrompt: clip(contentText(prompt.content) || "(image-only prompt)", 6000),
		...contextAfterPrompt(branch, promptIndex, pane.runtime.activeTool?.id),
	};
}

function fallbackStatus(context: PaneContext) {
	const text = context.lastPrompt
		.replace(/https?:\/\/\S+/g, "link")
		.replace(/[`*_#>\[\](){}]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!text || text.startsWith("(")) return "idle session";
	const words = text.split(" ").slice(0, 8).join(" ");
	return words.length < text.length ? `${words}…` : words;
}

export function provisionalClassification(pane: TmuxAgentPane, context: PaneContext, now = Date.now()): { category: AgentCategory; status: string } {
	if (!pane.sessionFile) return { category: "attention", status: "session file unavailable" };
	if (context.contextUnavailable) return { category: "attention", status: "recent context unavailable" };
	const incompleteStop = context.finalStopReason && ["error", "aborted", "length"].includes(context.finalStopReason);
	const activeToolTimedOut = pane.runtime.running
		&& pane.runtime.activeTool?.startedAt
		&& context.lastToolTimeoutMs
		&& now - pane.runtime.activeTool.startedAt > context.lastToolTimeoutMs + 5000;
	const terminalToolError = context.lastToolError && context.finalStopReason !== "stop";
	const missingFinalOutput = !pane.runtime.running && !context.hasFinalOutput;
	if ((!pane.runtime.running && (context.unmatchedToolCall || incompleteStop || terminalToolError || missingFinalOutput)) || activeToolTimedOut) {
		const status = activeToolTimedOut
			? "command exceeded its timeout"
			: missingFinalOutput
				? "final response missing"
				: "conversation stopped incomplete";
		return { category: "attention", status };
	}
	return { category: pane.runtime.running ? "working" : "ready", status: fallbackStatus(context) };
}

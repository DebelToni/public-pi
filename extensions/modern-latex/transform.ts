import { lexer } from "marked";

export interface MarkdownTransformContext {
	messageType: "user" | "assistant" | "assistant-thinking";
	isStreaming: boolean;
	availableWidth: number;
}

interface BalancedGroup {
	content: string;
	end: number;
}

interface ArrowRewrite {
	command: string;
	baseArrow: string;
}

interface MarkdownToken {
	type?: string;
	raw?: string;
	[key: string]: unknown;
}

const ARROW_REWRITES: readonly ArrowRewrite[] = [
	{ command: "\\xtwoheadrightarrow", baseArrow: "twoheadrightarrow" },
	{ command: "\\xtwoheadleftarrow", baseArrow: "twoheadleftarrow" },
	{ command: "\\xhookrightarrow", baseArrow: "hookrightarrow" },
	{ command: "\\xhookleftarrow", baseArrow: "hookleftarrow" },
	{ command: "\\xleftrightarrow", baseArrow: "longleftrightarrow" },
	{ command: "\\xLeftrightarrow", baseArrow: "Longleftrightarrow" },
	{ command: "\\xrightarrow", baseArrow: "longrightarrow" },
	{ command: "\\xleftarrow", baseArrow: "longleftarrow" },
	{ command: "\\xRightarrow", baseArrow: "Longrightarrow" },
	{ command: "\\xLeftarrow", baseArrow: "Longleftarrow" },
	{ command: "\\xmapsto", baseArrow: "longmapsto" },
];

const PROTECTED_TOKEN_TYPES = new Set(["code", "codespan", "def", "html", "image", "link"]);
const MAX_MARKDOWN_LENGTH = 32 * 1024;
const MAX_EXTENDED_ARROW_COMMANDS = 256;
const MAX_BACKSLASH_RUN = 1024;
const MAX_DANGEROUS_MARKER_COUNT = 32;
const MAX_LINES = 256;
const DANGEROUS_MARKERS = new Set(["!", "*", "<", ">", "[", "]", "_", "`"]);

function isWithinTransformBudget(markdown: string): boolean {
	if (markdown.length > MAX_MARKDOWN_LENGTH) return false;
	let commands = 0;
	let backslashRun = 0;
	const markerCounts = new Map<string, number>();
	let lines = 1;
	for (let index = 0; index < markdown.length; index++) {
		const character = markdown[index]!;
		if (character === "\n" && ++lines > MAX_LINES) return false;
		if (DANGEROUS_MARKERS.has(character)) {
			const count = (markerCounts.get(character) ?? 0) + 1;
			if (count > MAX_DANGEROUS_MARKER_COUNT) return false;
			markerCounts.set(character, count);
		}
		if (character === "\\") {
			backslashRun++;
			if (backslashRun > MAX_BACKSLASH_RUN) return false;
			if (markdown[index + 1] === "x" && ++commands > MAX_EXTENDED_ARROW_COMMANDS) return false;
		} else {
			backslashRun = 0;
		}
	}
	return true;
}

function escapedMap(source: string): Uint8Array {
	const escaped = new Uint8Array(source.length);
	let backslashes = 0;
	for (let index = 0; index < source.length; index++) {
		escaped[index] = backslashes % 2;
		backslashes = source[index] === "\\" ? backslashes + 1 : 0;
	}
	return escaped;
}

function skipWhitespace(source: string, start: number): number {
	let index = start;
	while (index < source.length && /\s/.test(source[index]!)) index++;
	return index;
}

function readBalancedGroup(
	source: string,
	escaped: Uint8Array,
	start: number,
	opening: string,
	closing: string,
): BalancedGroup | undefined {
	if (source[start] !== opening) return undefined;
	let depth = 0;
	for (let index = start; index < source.length; index++) {
		if (escaped[index]) continue;
		if (source[index] === opening) depth++;
		else if (source[index] === closing && --depth === 0) {
			return { content: source.slice(start + 1, index), end: index + 1 };
		}
	}
	return undefined;
}

export function transformExtendedArrows(math: string): string {
	if (!math.includes("\\x")) return math;
	const escaped = escapedMap(math);
	let output = "";
	let unchangedStart = 0;
	let index = 0;

	while (index < math.length) {
		if (math[index] !== "\\" || escaped[index]) {
			index++;
			continue;
		}
		const rewrite = ARROW_REWRITES.find(({ command }) => {
			if (!math.startsWith(command, index)) return false;
			const next = math[index + command.length];
			return next === undefined || !/[A-Za-z]/.test(next);
		});
		if (!rewrite) {
			index++;
			continue;
		}

		let cursor = skipWhitespace(math, index + rewrite.command.length);
		let below: string | undefined;
		if (math[cursor] === "[") {
			const optional = readBalancedGroup(math, escaped, cursor, "[", "]");
			if (!optional) break;
			below = optional.content;
			cursor = skipWhitespace(math, optional.end);
		}
		const required = readBalancedGroup(math, escaped, cursor, "{", "}");
		if (!required) {
			if (math[cursor] === "{") break;
			index += rewrite.command.length;
			continue;
		}

		let arrow = `\\${rewrite.baseArrow}`;
		if (below !== undefined) arrow = `\\underset{${below}}{${arrow}}`;
		output += math.slice(unchangedStart, index) + `\\overset{${required.content}}{${arrow}}`;
		index = required.end;
		unchangedStart = index;
	}
	return unchangedStart === 0 ? math : output + math.slice(unchangedStart);
}

function frontmatterEnd(markdown: string): number {
	const start = markdown.charCodeAt(0) === 0xfeff ? 1 : 0;
	const firstEnd = markdown.indexOf("\n", start);
	if (firstEnd < 0) return 0;
	const marker = markdown.slice(start, firstEnd).replace(/\r$/, "");
	if (marker !== "---" && marker !== "+++") return 0;
	let lineStart = firstEnd + 1;
	while (lineStart < markdown.length) {
		const newline = markdown.indexOf("\n", lineStart);
		const end = newline < 0 ? markdown.length : newline;
		const line = markdown.slice(lineStart, end).replace(/\r$/, "");
		if (line === marker || (marker === "---" && line === "...")) return newline < 0 ? markdown.length : newline + 1;
		lineStart = newline < 0 ? markdown.length : newline + 1;
	}
	return 0;
}

function containsProtectedToken(value: unknown, seen = new WeakSet<object>()): boolean {
	if (!value || typeof value !== "object") return false;
	if (seen.has(value)) return false;
	seen.add(value);
	if (Array.isArray(value)) return value.some((item) => containsProtectedToken(item, seen));
	const token = value as MarkdownToken;
	if (token.type && PROTECTED_TOKEN_TYPES.has(token.type)) return true;
	for (const [key, child] of Object.entries(token)) {
		if (key === "raw" || key === "text" || key === "href" || key === "title" || key === "url") continue;
		if (containsProtectedToken(child, seen)) return true;
	}
	return false;
}

function findClosingDelimiter(
	source: string,
	escaped: Uint8Array,
	delimiter: string,
	start: number,
	allowNewline: boolean,
): number {
	for (let index = start; index < source.length; index++) {
		if (!allowNewline && source[index] === "\n") return -1;
		if (!escaped[index] && source.startsWith(delimiter, index)) return index;
	}
	return -1;
}

function transformDelimitedMath(
	source: string,
	escaped: Uint8Array,
	openingStart: number,
	opening: string,
	closing: string,
	allowNewline: boolean,
): { text: string; end: number; originalBody: string } | undefined {
	const bodyStart = openingStart + opening.length;
	const closingStart = findClosingDelimiter(source, escaped, closing, bodyStart, allowNewline);
	if (closingStart < 0) return undefined;
	const body = source.slice(bodyStart, closingStart);
	return {
		text: opening + transformExtendedArrows(body) + closing,
		end: closingStart + closing.length,
		originalBody: body,
	};
}

function transformMathSegment(source: string): string {
	if (!source.includes("\\x")) return source;
	const escaped = escapedMap(source);
	let output = "";
	let unchangedStart = 0;
	let index = 0;
	const commit = (replacement: string, end: number) => {
		output += source.slice(unchangedStart, index) + replacement;
		index = end;
		unchangedStart = end;
	};

	while (index < source.length) {
		let transformed: ReturnType<typeof transformDelimitedMath>;
		if (source.startsWith("$$", index) && !escaped[index]) {
			transformed = transformDelimitedMath(source, escaped, index, "$$", "$$", true);
			if (!transformed) break;
			commit(transformed.text, transformed.end);
			continue;
		}
		if (source.startsWith("\\[", index) && !escaped[index]) {
			transformed = transformDelimitedMath(source, escaped, index, "\\[", "\\]", true);
			if (!transformed) break;
			commit(transformed.text, transformed.end);
			continue;
		}
		if (source.startsWith("\\(", index) && !escaped[index]) {
			transformed = transformDelimitedMath(source, escaped, index, "\\(", "\\)", false);
			if (!transformed) break;
			commit(transformed.text, transformed.end);
			continue;
		}
		if (source[index] === "$" && !escaped[index] && !/\s/.test(source[index + 1] ?? "")) {
			transformed = transformDelimitedMath(source, escaped, index, "$", "$", false);
			if (!transformed) break;
			const next = source[transformed.end];
			if (transformed.originalBody && !/\s$/.test(transformed.originalBody) && !/\d/.test(next ?? "")) {
				commit(transformed.text, transformed.end);
				continue;
			}
			index = transformed.end;
			continue;
		}
		index++;
	}
	return unchangedStart === 0 ? source : output + source.slice(unchangedStart);
}

function childTokens(token: MarkdownToken): MarkdownToken[] {
	if (Array.isArray(token.items)) return token.items as MarkdownToken[];
	if (Array.isArray(token.tokens)) return token.tokens as MarkdownToken[];
	return [];
}

function transformTokenRaw(token: MarkdownToken): string {
	if (typeof token.raw !== "string" || PROTECTED_TOKEN_TYPES.has(token.type ?? "")) return token.raw ?? "";
	if (!containsProtectedToken(token)) return transformMathSegment(token.raw);
	const children = childTokens(token);
	if (children.length === 0) return token.raw;

	let output = "";
	let cursor = 0;
	for (const child of children) {
		if (typeof child.raw !== "string") return token.raw;
		const start = token.raw.indexOf(child.raw, cursor);
		if (start < 0) return token.raw;
		output += transformMathSegment(token.raw.slice(cursor, start));
		output += transformTokenRaw(child);
		cursor = start + child.raw.length;
	}
	return output + transformMathSegment(token.raw.slice(cursor));
}

function transformTokenizedMarkdown(markdown: string): string {
	let output = "";
	let cursor = 0;
	for (const token of lexer(markdown) as unknown as MarkdownToken[]) {
		if (typeof token.raw !== "string") continue;
		let start = cursor;
		if (!markdown.startsWith(token.raw, start)) {
			start = markdown.indexOf(token.raw, cursor);
			if (start < 0) return markdown;
		}
		output += markdown.slice(cursor, start);
		output += transformTokenRaw(token);
		cursor = start + token.raw.length;
	}
	return output + markdown.slice(cursor);
}

export function transformModernLatex(markdown: string): string {
	if (!markdown.includes("\\x") || !isWithinTransformBudget(markdown)) return markdown;
	const bodyStart = frontmatterEnd(markdown);
	return markdown.slice(0, bodyStart) + transformTokenizedMarkdown(markdown.slice(bodyStart));
}

export function modernLatexMarkdownTransformer(markdown: string, context: MarkdownTransformContext): string {
	if (context.isStreaming || context.messageType === "assistant-thinking") return markdown;
	return transformModernLatex(markdown);
}

/** Shared, dependency-free Markdown widget format. Titles are plain text. */
export function widgetInfo(lang) {
	if (typeof lang !== "string") return undefined;
	const match = /^html-widget(?:[ \t]+([\s\S]*))?$/.exec(lang.trim());
	if (!match) return undefined;
	const title = Array.from((match[1] ?? "")
		.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, "")
		.trim()).slice(0, 120).join("");
	return { title: title || "Interactive HTML" };
}

/** A code token alone does not establish top-level placement. */
export function widgetTokenInfo(token) {
	if (token?.type !== "code" || token.codeBlockStyle === "indented") return undefined;
	if (!widgetInfo(token.lang) || typeof token.raw !== "string") return undefined;
	const raw = token.raw.replace(/\r\n?/g, "\n");
	const opening = /^ {0,3}(`{3,}|~{3,})([^\n]*)\n/.exec(raw);
	const info = opening && widgetInfo(opening[2]);
	if (!info) return undefined;
	const closing = /(?:^|\n) {0,3}(`{3,}|~{3,})[ \t]*\n?$/.exec(raw.slice(opening[0].length));
	return closing && closing[1][0] === opening[1][0] && closing[1].length >= opening[1].length
		? info : undefined;
}

export const MAX_HTML_WIDGETS = 32;
export const MAX_LEXER_CALLS = 64;
export const MAX_LEXED_CHARS = 16 * 1024 * 1024;

/** Grouped full-context masks identify openings without per-false-candidate probes. */
export function splitHtmlWidgets(text, lexer) {
	const normalized = text.replace(/\r\n?/g, "\n");
	let calls = 0, chars = 0;
	function limit(reason) {
		throw Object.assign(new Error(`HTML widget parser limit exceeded: ${reason}`), { code: "HTML_WIDGET_LIMIT", status: 413 });
	}
	function lex(source) {
		if (calls >= MAX_LEXER_CALLS) limit(`${MAX_LEXER_CALLS} lexer invocations per message`);
		if (chars + source.length > MAX_LEXED_CHARS) limit(`${MAX_LEXED_CHARS} cumulative UTF-16 lexer input characters`);
		calls++; chars += source.length;
		return lexer(source).filter(token => widgetTokenInfo(token));
	}
	const root = lex(normalized);
	if (!root.length) return text ? [{ type: "markdown", text }] : [];
	if (root.length > MAX_HTML_WIDGETS) limit(`${MAX_HTML_WIDGETS} widget frames per message`);
	const fail = () => { throw new Error("Declared root widget has no proven source boundary"); };
	const candidates = [], selected = [];
	for (const match of normalized.matchAll(/^ {0,3}(`{3,}|~{3,})([^\n]*)\n/gm)) {
		if (widgetInfo(match[2])) candidates.push({ start: match.index, body: match.index + match[0].length,
			marker: match[1], at: match.index + match[0].indexOf("html-widget") });
	}
	function positives(lo, hi) {
		const chunks = [];
		let cursor = 0;
		for (let i = lo; i < hi; i++) {
			const at = candidates[i].at;
			chunks.push(normalized.slice(cursor, at), "x"); cursor = at + 1;
		}
		chunks.push(normalized.slice(cursor));
		const count = root.length - lex(chunks.join("")).length;
		if (count < 0 || count > hi - lo) fail();
		return count;
	}
	function select(lo, hi, count) {
		if (count < 0 || count > hi - lo) fail();
		if (!count) return;
		if (count === hi - lo) { selected.push(...candidates.slice(lo, hi)); return; }
		const mid = Math.floor((lo + hi) / 2), left = positives(lo, mid);
		select(lo, mid, left); select(mid, hi, count - left);
	}
	if (positives(0, candidates.length) !== root.length) fail();
	select(0, candidates.length, root.length);
	const parts = [], core = raw => raw.replace(/[ \t\n]+$/, "");
	let proseStart = 0, normalizedOffset = 0, originalOffset = 0;
	function originalBoundary(target) {
		while (normalizedOffset < target) {
			originalOffset += text[originalOffset] === "\r" && text[originalOffset + 1] === "\n" ? 2 : 1;
			normalizedOffset++;
		}
		return originalOffset;
	}
	function markdown(end) {
		if (end > proseStart) parts.push({ type: "markdown", text: text.slice(proseStart, end) });
	}
	for (const [index, opening] of selected.entries()) {
		const closing = new RegExp(`^ {0,3}(${opening.marker[0]}{${opening.marker.length},})[ \t]*$`, "gm");
		closing.lastIndex = opening.body;
		const close = closing.exec(normalized);
		if (!close || opening.start < normalizedOffset) fail();
		const fence = normalized.slice(opening.start, close.index + close[0].length), span = core(fence);
		if (core(root[index].raw) !== span) fail();
		// Only selected frames need body validation; ordinary context is never re-lexed as a suffix.
		const probe = lex(fence);
		if (probe.length !== 1 || core(probe[0].raw) !== span || probe[0].text !== root[index].text) fail();
		markdown(originalBoundary(opening.start));
		proseStart = originalBoundary(opening.start + span.length);
		parts.push({ type: "widget", source: root[index].text, title: widgetTokenInfo(root[index]).title, index });
	}
	markdown(text.length);
	return parts;
}

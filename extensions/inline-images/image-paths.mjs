// Pure shared grammar. Offsets are JS string indices; end is exclusive.
const SUFFIX = /\.(?:png|jpe?g|webp|gif|heic|heif|avif|bmp|tiff?|svg|ico)$/i;
const REMOTE = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i;

function localPath(value, wrapped) {
	const path = value.replace(/\\([\\ ()\[\]<>"'`])/g, "$1");
	if (!path || /[\x00-\x1f\x7f]/.test(path) || REMOTE.test(path) || path.includes("://") || !SUFFIX.test(path)) return;
	// Bare filenames are prose, but an explicit wrapper makes intent unambiguous.
	if (!wrapped && !/^(?:\/(?!\/)|~\/|\.\.?\/)/.test(path) && !/^[\w.-]+\//u.test(path)) return;
	return path;
}

function closingDelimiter(text, start, open, close) {
	let depth = 1, quote = "";
	for (let i = start + 1; i < text.length; i++) {
		const char = text[i];
		if (char === "\r" || char === "\n") return -1;
		if (char === "\\") { i++; continue; }
		if (quote) { if (char === quote) quote = ""; continue; }
		if (open === "(" && (char === "<" || ((char === '"' || char === "'") && (i === start + 1 || /\s/.test(text[i - 1]))))) {
			quote = char === "<" ? ">" : char; continue;
		}
		if (char === open) depth++;
		if (char === close && --depth === 0) return i;
	}
	return -1;
}

/**
 * Return first occurrence of each local image path, in source order.
 * path: unwrapped, Markdown-backslash-unescaped spelling, no filesystem/URL resolution.
 * start/end: full removable reference (including quotes, angle brackets or Markdown).
 * No text mutation, Node APIs, URL decoding, filesystem checks or tilde expansion.
 */
export function findImageReferences(text) {
	const found = [], occupied = [];
	const add = (value, start, end, wrapped) => {
		occupied.push([start, end]);
		const path = localPath(value, wrapped);
		if (path) found.push({ path, start, end });
	};
	const overlaps = (start, end) => occupied.some(([a, b]) => start < b && end > a);
	// URLs may contain parentheses/quotes that otherwise look like local boundaries.
	for (const match of text.matchAll(/(?:^|[\s("'`<])((?:[a-z][a-z\d+.-]*:|\/\/)[^\s<>]+)/gi)) {
		occupied.push([match.index + match[0].length - match[1].length, match.index + match[0].length]);
	}
	// Consume remote Markdown too, so its inner URL cannot become a local suffix.
	const markdown = /!?\[/g;
	let match;
	while ((match = markdown.exec(text))) {
		if (occupied.some(([a, b]) => a <= match.index && match.index < b)) continue;
		const bracket = match.index + match[0].length - 1;
		const bracketEnd = closingDelimiter(text, bracket, "[", "]");
		if (bracketEnd < 0 || text[bracketEnd + 1] !== "(") continue;
		const end = closingDelimiter(text, bracketEnd + 1, "(", ")");
		if (end < 0) continue;
		let value = text.slice(bracketEnd + 2, end).trim();
		value = value.replace(/\s+(?:"[^"\r\n]*"|'[^'\r\n]*')\s*$/, "");
		if (/^<.*>$|^".*"$|^'.*'$/.test(value)) value = value.slice(1, -1);
		add(value, match.index, end + 1, true);
		markdown.lastIndex = end + 1;
	}
	const wrappers = /"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|<[^<>\r\n]*>|`[^`\r\n]*`/g;
	for (const match of text.matchAll(wrappers)) {
		const start = match.index, end = start + match[0].length;
		if (!overlaps(start, end)) add(match[0].slice(1, -1), start, end, true);
	}
	// Whole tokens prevent partial matches inside URLs, identifiers and prose.
	const tokens = /[^\s<>"'`()\[\]{}]+/g;
	for (const match of text.matchAll(tokens)) {
		const start = match.index, raw = match[0], value = raw.replace(/[.,;!?]+$/, "");
		const end = start + value.length;
		if (overlaps(start, start + raw.length)) continue;
		// A token after ':' or a slash is part of a larger reference, never a suffix.
		if (start > 0 && /[:\w/\\]/u.test(text[start - 1])) continue;
		add(value, start, end, false);
	}
	const seen = new Set();
	return found.sort((a, b) => a.start - b.start).filter(({ path }) => {
		if (seen.has(path)) return false;
		seen.add(path); return true;
	});
}

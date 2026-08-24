import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const DANGEROUS_RM_RF_SOURCE = String.raw`\brm\s+-rf\s+(\*|\/|~|\.\.?\/?\s*$)`;

type Quote = "'" | '"' | "`";

type ParsedWord = {
	value: string;
	dynamic: boolean;
	glob: boolean;
	next: number;
};

type RmRfPolicyOptions = {
	tempRoots?: readonly string[];
};

function quoteAt(text: string, end: number): Quote | undefined {
	let quote: Quote | undefined;
	for (let i = 0; i < end; i++) {
		const ch = text[i];
		if (ch === "\\" && quote !== "'") {
			i++;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === "`") quote = ch;
	}
	return quote;
}

function parseWord(text: string, start: number, outerQuote?: Quote): ParsedWord | undefined {
	let value = "";
	let dynamic = false;
	let glob = false;
	let quote: Quote | undefined;
	let i = start;

	for (; i < text.length; i++) {
		const ch = text[i];
		if (!quote) {
			if (outerQuote && ch === outerQuote) break;
			if (/\s/.test(ch) || ";&|<>()".includes(ch)) break;
			if (ch === "'" || ch === '"') {
				quote = ch;
				continue;
			}
			if (ch === "\\") {
				if (text[i + 1] === "\n") {
					i++;
					continue;
				}
				if (i + 1 >= text.length) return undefined;
				value += text[++i];
				continue;
			}
			if (ch === "$" || ch === "`" || ch === "{" || ch === "}") dynamic = true;
			if (ch === "*" || ch === "?" || ch === "[") glob = true;
			value += ch;
			continue;
		}

		if (ch === quote) {
			quote = undefined;
			continue;
		}
		if (ch === "\\" && quote === '"') {
			if (i + 1 >= text.length) return undefined;
			value += text[++i];
			continue;
		}
		if (quote === '"' && (ch === "$" || ch === "`")) dynamic = true;
		value += ch;
	}

	if (quote || value.length === 0) return undefined;
	return { value, dynamic, glob, next: i };
}

function redirectEnd(text: string, start: number) {
	let i = start;
	while (/\d/.test(text[i] ?? "")) i++;
	if (text[i] !== ">" && text[i] !== "<") return undefined;
	const operatorStart = i;
	while (text[i] === ">" || text[i] === "<" || text[i] === "&" || text[i] === "|") i++;
	return { next: i, hereDoc: text.slice(operatorStart, i).startsWith("<<") };
}

// Unknown shell syntax never earns an exemption: parsing failures return undefined.
function rmTargets(text: string, rmStart: number, targetStart: number) {
	const outerQuote = quoteAt(text, rmStart);
	if (outerQuote === "`") return undefined;

	const targets: ParsedWord[] = [];
	let optionsEnded = false;
	let i = targetStart;
	while (i < text.length) {
		while (text[i] === " " || text[i] === "\t" || text[i] === "\r") i++;
		const ch = text[i];
		if (!ch || ch === "\n" || ";&|()".includes(ch) || (outerQuote && ch === outerQuote)) break;
		if (ch === "#") break;

		const redirect = redirectEnd(text, i);
		if (redirect) {
			if (redirect.hereDoc) return undefined;
			i = redirect.next;
			while (text[i] === " " || text[i] === "\t") i++;
			const destination = parseWord(text, i, outerQuote);
			if (!destination || destination.dynamic) return undefined;
			i = destination.next;
			continue;
		}

		const word = parseWord(text, i, outerQuote);
		if (!word) return undefined;
		i = word.next;
		if (!optionsEnded && word.value === "--") {
			optionsEnded = true;
			continue;
		}
		if (!optionsEnded && word.value.startsWith("-")) continue;
		targets.push(word);
	}
	return { targets, direct: outerQuote === undefined && isDirectRm(text, rmStart) };
}

function isDirectRm(text: string, rmStart: number) {
	const prefix = text.slice(0, rmStart);
	const boundary = Math.max(prefix.lastIndexOf("\n"), prefix.lastIndexOf(";"), prefix.lastIndexOf("&"), prefix.lastIndexOf("|"));
	return /^(?:sudo(?:\s+-\S+)*)?\s*$/.test(prefix.slice(boundary + 1).trimStart());
}

function isStrictlyWithin(root: string, candidate: string) {
	const rel = relative(root, candidate);
	return rel.length > 0 && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function nearestExisting(path: string) {
	let current = path;
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
	return current;
}

// Resolve the nearest existing ancestor so a temp-looking path cannot traverse a local symlink.
function canonicalCandidate(path: string) {
	const globIndex = path.search(/[?*\[]/);
	let probe = path;
	if (globIndex >= 0) {
		const prefix = path.slice(0, globIndex);
		probe = prefix.endsWith(sep) ? prefix.slice(0, -1) : dirname(prefix);
	}
	const existing = nearestExisting(probe);
	if (!existing) return undefined;
	try {
		return resolve(realpathSync.native(existing), relative(existing, path));
	} catch {
		return undefined;
	}
}

function canonicalRoots(roots: readonly string[]) {
	const result: string[] = [];
	for (const root of roots) {
		try { result.push(realpathSync.native(resolve(root))); } catch {}
	}
	return [...new Set(result)];
}

function isUnderTemp(target: ParsedWord, cwd: string, roots: readonly string[]) {
	if (target.dynamic || target.value.includes("**")) return false;
	const globIndex = target.value.search(/[?*\[]/);
	if (globIndex >= 0 && /[\\/]/.test(target.value.slice(globIndex))) return false;
	const canonical = canonicalCandidate(resolve(cwd, target.value));
	return canonical !== undefined && roots.some((root) => isStrictlyWithin(root, canonical));
}

function isProtectedTempRoot(target: ParsedWord, cwd: string, roots: readonly string[]) {
	if (target.dynamic || target.glob) return false;
	const canonical = canonicalCandidate(resolve(cwd, target.value));
	return canonical !== undefined && roots.includes(canonical);
}

export function isExistingEmptyDirectory(path: string, cwd: string) {
	try {
		const stat = lstatSync(resolve(cwd, path));
		return stat.isDirectory() && !stat.isSymbolicLink() && readdirSync(resolve(cwd, path)).length === 0;
	} catch {
		return false;
	}
}

export function shouldBlockDangerousRmRf(
	command: string,
	cwd: string,
	options: RmRfPolicyOptions = {},
) {
	const matches = [...command.matchAll(new RegExp(DANGEROUS_RM_RF_SOURCE, "g"))];
	if (matches.length === 0) return false;
	const roots = canonicalRoots(options.tempRoots ?? ["/tmp", "/private/tmp", tmpdir()]);

	for (const match of matches) {
		const rmStart = match.index;
		const prefix = /\brm\s+-rf\s+/y;
		prefix.lastIndex = rmStart;
		if (!prefix.exec(command)) return true;
		const parsed = rmTargets(command, rmStart, prefix.lastIndex);
		if (!parsed || parsed.targets.length === 0) return true;
		if (!parsed.targets.every((target) =>
			isUnderTemp(target, cwd, roots)
			|| (parsed.direct
				&& !isProtectedTempRoot(target, cwd, roots)
				&& !target.dynamic
				&& !target.glob
				&& isExistingEmptyDirectory(target.value, cwd)))) {
			return true;
		}
	}
	return false;
}

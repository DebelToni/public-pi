import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	SESSION_SOURCE_PATH_ENV,
	SessionStoreClient,
	type CatalogEntry,
	type CatalogMatch,
	type CatalogSession,
	type EntryRef,
} from "../lib/session-store-client.js";
import { resolveSessionReference } from "../lib/upstream-session-refs.js";
import {
	exactMatchKey,
	MAX_LINEAGE_DEPTH,
	nextLineageSource,
	validateLineageBoundary,
	type LineageSource,
} from "./lineage.js";

const TOOL_OUTPUT_BYTES = 45 * 1024;
const TRUNCATION_MARKER = "[Output stopped at the tool budget; narrow the query or lower the match count.]";
const PARTIAL_WARNING = "WARNING: Session catalog coverage is partial; failed or stale sources were excluded, so these results are incomplete.";

type ToolContext = {
	cwd: string;
	sessionManager: {
		getSessionFile(): string | undefined;
		getLeafId(): string | null;
	};
};

type SessionTarget = {
	path: string;
	id?: string;
	leaf: string | null | undefined;
	current: boolean;
};

function restrictedSourcePath() {
	const value = process.env[SESSION_SOURCE_PATH_ENV]?.trim();
	return value ? canonical(value) : undefined;
}

function targetSession(reference: string | undefined, ctx: ToolContext): SessionTarget {
	const restriction = restrictedSourcePath();
	const requested = reference?.trim();
	if (restriction && (!requested || requested === "current")) {
		throw new Error(`This helper is restricted to one source; pass session=${restriction}.`);
	}
	const currentFile = ctx.sessionManager.getSessionFile();
	if (requested && requested !== "current") {
		if (restriction) {
			const expanded = requested === "~" ? homedir() : requested.startsWith("~/") ? join(homedir(), requested.slice(2)) : requested;
			if (canonical(expanded) !== restriction) throw new Error("This helper cannot access a session outside its restricted source.");
		}
		const target = resolveSessionReference(requested);
		const current = Boolean(currentFile && canonical(currentFile) === canonical(target.filePath));
		return {
			path: target.filePath,
			id: target.sessionId,
			leaf: current ? ctx.sessionManager.getLeafId() : undefined,
			current,
		};
	}
	if (!currentFile) throw new Error("The current session is ephemeral and has no catalog source path.");
	return { path: resolve(currentFile), leaf: ctx.sessionManager.getLeafId(), current: true };
}

function truncateUtf8(value: string, maxBytes: number) {
	if (maxBytes <= 0) return "";
	const source = Buffer.from(value);
	if (source.length <= maxBytes) return value;
	let end = maxBytes;
	while (end > 0 && (source[end] & 0b1100_0000) === 0b1000_0000) end--;
	return source.subarray(0, end).toString("utf8");
}

function boundedJoin(blocks: string[], maxBytes = TOOL_OUTPUT_BYTES) {
	const full = blocks.join("\n\n");
	if (Buffer.byteLength(full) <= maxBytes) return full;
	const separator = "\n\n";
	const reserved = Buffer.byteLength(separator) + Buffer.byteLength(TRUNCATION_MARKER);
	if (reserved >= maxBytes) return truncateUtf8(TRUNCATION_MARKER, maxBytes);
	return `${truncateUtf8(full, maxBytes - reserved)}${separator}${TRUNCATION_MARKER}`;
}

function coverageNote(coverage: unknown) {
	if (coverage === undefined) return undefined;
	return `Coverage: ${JSON.stringify(coverage)}`;
}

function formatRef(ref: EntryRef | undefined, fallbackId?: string) {
	return JSON.stringify(ref ?? { id: fallbackId ?? null });
}

function imageReferences(entry: CatalogEntry) {
	return (entry.parts ?? []).flatMap((part) => {
		if (!part.image) return [];
		const fields = [
			`part=${part.part}`,
			part.image.mime ? `mime=${part.image.mime}` : undefined,
			part.image.bytes !== undefined ? `bytes=${part.image.bytes}` : undefined,
			part.image.sha256 ? `sha256=${part.image.sha256}` : undefined,
		].filter(Boolean).join(" ");
		const byteStart = entry.entryRef?.byteStart ?? entry.byteStart;
		return [`[image ${fields}; entryRef=${formatRef(entry.entryRef, entry.id)}; extract with read_session entry=${entry.id}${byteStart === undefined ? "" : ` byteStart=${byteStart}`} imagePart=${part.part}]`];
	});
}

function formatEntry(entry: CatalogEntry) {
	const heading = `[entryRef=${formatRef(entry.entryRef, entry.id)}] ${entry.type}${entry.role ? ` ${entry.role}` : ""}`;
	return [heading, entry.text, ...imageReferences(entry)].filter(Boolean).join("\n");
}

type LineageMatch = CatalogMatch & { sourcePath?: string; lineageDepth?: number };

function formatMatch(match: LineageMatch) {
	const source = match.sourcePath ? ` source=${JSON.stringify(match.sourcePath)} depth=${match.lineageDepth ?? 0}` : "";
	return `[matchedEntryRef=${formatRef(match.matchedEntryRef, match.matchedEntryId)}${source}]${match.matchedRole ? ` ${match.matchedRole}` : ""}\n${match.excerpt}`;
}

function resultMatches(result: CatalogSession | undefined): CatalogMatch[] {
	if (!result) return [];
	if (Array.isArray(result.matches) && result.matches.length) return result.matches;
	if (!result.matchedEntryId || !result.excerpt) return [];
	return [{ matchedEntryId: result.matchedEntryId, matchedEntryRef: result.matchedEntryRef, matchedRole: result.matchedRole, excerpt: result.excerpt }];
}

function formatSessionResult(result: CatalogSession, index: number) {
	const title = result.name || result.firstMessage || result.id || result.path;
	const metadata = [
		`${index + 1}. ${title}`,
		`session: ${result.id || "(unknown)"}`,
		`path: ${result.path}`,
		`cwd: ${result.cwd}`,
	].join("\n");
	const matches = resultMatches(result);
	return matches.length ? `${metadata}\n${matches.map(formatMatch).join("\n\n")}` : metadata;
}

function roleIncludesTools(role: string) {
	return role === "toolResult" || role === "bashExecution" || role === "tool";
}

function emptyLiveBranch(target: SessionTarget, explicitLeaf: string | undefined) {
	return target.current && target.leaf === null && explicitLeaf === undefined;
}

function isPartial(value: any) {
	return value?.scopeComplete === false;
}

const CurrentSearchParams = Type.Object({
	query: Type.String({ description: "Search this conversation's active history, including pre-compaction entries." }),
	mode: Type.Optional(StringEnum(["bm25", "phrase", "regex"] as const)),
	maxMatches: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
	role: Type.Optional(Type.String()),
	includeTools: Type.Optional(Type.Boolean()),
});

const BankSearchParams = Type.Object({
	query: Type.String({ description: "Text or regular expression to search for." }),
	session: Type.Optional(Type.String({ description: "Upstream session ID supplied by a fan-in handoff, or an exact session file path." })),
	leaf: Type.Optional(Type.String({ description: "Branch leaf ID for an exact session search." })),
	leafByteStart: Type.Optional(Type.Integer({ minimum: 0, description: "Exact byteStart locator for a duplicate leaf ID." })),
	global: Type.Optional(Type.Boolean({ description: "Search every cataloged session (also the default if session and cwd are omitted)." })),
	cwd: Type.Optional(Type.String({ description: "Restrict search to sessions in this cwd; tree=true includes descendants." })),
	tree: Type.Optional(Type.Boolean({ description: "With cwd, include descendant project directories." })),
	mode: Type.Optional(StringEnum(["bm25", "phrase", "regex"] as const)),
	regex: Type.Optional(Type.Boolean({ description: "Compatibility alias for mode=regex." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Maximum session results for cwd/global search. Ignored for one-session search. Default: 10." })),
	maxMatches: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Maximum entry excerpts per matched session in every scope. Default: 10." })),
	role: Type.Optional(Type.String({ description: "Role filter. Defaults to conversation (user and assistant); tool roles automatically include tool evidence." })),
	includeTools: Type.Optional(Type.Boolean({ description: "Explicitly include bounded tool-call/result evidence, independently of role." })),
});

const ReadParams = Type.Object({
	session: Type.Optional(Type.String({ description: '"current" (default), an upstream fan-in session ID, or an exact session file path.' })),
	entry: Type.Optional(Type.String({ description: "Entry ID to center the read around." })),
	byteStart: Type.Optional(Type.Integer({ minimum: 0, description: "Exact byteStart locator for a duplicate entry ID." })),
	leaf: Type.Optional(Type.String({ description: "Branch leaf ID. Current live leaf is used automatically only for the current session." })),
	leafByteStart: Type.Optional(Type.Integer({ minimum: 0, description: "Exact byteStart locator for a duplicate leaf ID." })),
	before: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000 })),
	after: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000 })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
	maxChars: Type.Optional(Type.Integer({ minimum: 1000, maximum: 50_000 })),
	imagePart: Type.Optional(Type.Integer({ minimum: 0, description: "Extract and return this image part from entry; a private ~/tmp artifact is also retained." })),
});


function canonical(path: string) {
	try { return realpathSync.native(path); } catch { return resolve(path); }
}

function canFollowLineage(target: SessionTarget) {
	// PI_SESSION_SOURCE_PATH is an authorization boundary for evidence-oracle children.
	// It always remains exactly one physical JSONL, even when that file records ancestry.
	return target.current && !restrictedSourcePath() && existsSync(target.path);
}

async function lineageSearch(
	client: SessionStoreClient,
	target: SessionTarget,
	params: any,
	options: { mode: "bm25" | "phrase" | "regex"; role: string; includeTools: boolean; maxMatches: number },
	signal?: AbortSignal,
) {
	const rootLeaf = params.leaf ?? target.leaf ?? undefined;
	let source: LineageSource = { path: canonical(target.path), depth: 0, leaf: rootLeaf, suppress: new Set() };
	const seen = new Set<string>();
	const matches: LineageMatch[] = [];
	const sources: any[] = [];
	const freshness: any[] = [];
	for (let depth = 0; depth < MAX_LINEAGE_DEPTH; depth++) {
		if (seen.has(source.path)) throw new Error("Cyclic flatten-session lineage.");
		seen.add(source.path);
		freshness.push(await client.reconcile({ path: source.path }, signal));
		if (source.depth > 0) await validateLineageBoundary(client, source, signal);
		const response = await client.search(params.query, {
			path: source.path,
			leaf: source.leaf ?? undefined,
			leafByteStart: source.depth > 0 ? source.leafRef?.byteStart : params.leafByteStart,
			limit: 1,
			matches: options.maxMatches,
			mode: options.mode,
			role: options.role,
			includeTools: options.includeTools,
		}, signal);
		if (source.depth > 0 && !source.leafRef) throw new Error("Lineage ancestor has no exact leaf locator.");
		const raw = resultMatches(response.results[0]);
		const accepted = raw.filter((match) => !source.suppress.has(exactMatchKey(match.matchedEntryRef)));
		for (const match of accepted) {
			if (matches.length >= options.maxMatches) break;
			matches.push({ ...match, sourcePath: source.path, lineageDepth: source.depth });
		}
		sources.push({
			path: source.path,
			depth: source.depth,
			leaf: source.leaf ?? null,
			leafRef: source.leafRef,
			rawMatches: raw.length,
			acceptedMatches: accepted.length,
		});
		if (matches.length >= options.maxMatches) break;
		const next = nextLineageSource(source);
		if (!next) return { matches, sources, freshness, coverage: response.coverage };
		source = next;
	}
	if (nextLineageSource(source)) throw new Error(`Flatten-session lineage exceeds ${MAX_LINEAGE_DEPTH} generations.`);
	return { matches, sources, freshness };
}

function missingEntryError(error: unknown) {
	return /entry not found/i.test(error instanceof Error ? error.message : String(error));
}

async function readLineageEntry(
	client: SessionStoreClient,
	target: SessionTarget,
	params: any,
	signal?: AbortSignal,
) {
	let source: LineageSource = { path: canonical(target.path), depth: 0, leaf: params.leaf ?? target.leaf ?? undefined, suppress: new Set() };
	const seen = new Set<string>();
	const sources: any[] = [];
	for (let depth = 0; depth < MAX_LINEAGE_DEPTH; depth++) {
		if (seen.has(source.path)) throw new Error("Cyclic flatten-session lineage.");
		seen.add(source.path);
		const freshness = await client.reconcile({ path: source.path }, signal);
		if (source.depth > 0) await validateLineageBoundary(client, source, signal);
		try {
			const response = await client.read({
				path: source.path,
				entry: params.entry,
				entryByteStart: params.byteStart,
				leaf: source.leaf ?? undefined,
				leafByteStart: source.depth > 0 ? source.leafRef?.byteStart : params.leafByteStart,
				before: params.before,
				after: params.after,
				limit: params.limit,
				maxChars: params.maxChars,
			}, signal);
			sources.push({ path: source.path, depth: source.depth, found: true });
			return { response, source, freshness, sources };
		} catch (error) {
			if (!missingEntryError(error)) throw error;
			sources.push({ path: source.path, depth: source.depth, found: false });
		}
		const next = nextLineageSource(source);
		if (!next) return { source, sources };
		source = next;
	}
	throw new Error(`Flatten-session lineage exceeds ${MAX_LINEAGE_DEPTH} generations.`);
}

export default function (pi: ExtensionAPI) {
	const client = new SessionStoreClient();

	pi.registerTool({
		name: "read_session",
		label: "Read Session",
		description: "Read normalized entries from a session branch. Exact entry reads on the current session follow validated flatten ancestry; source-restricted helpers remain one-file-only. Bounded to 50,000 characters. imagePart returns the actual image plus a private ~/tmp artifact.",
		parameters: ReadParams,
		async execute(_id, params, signal, onUpdate, ctx) {
			if (params.imagePart !== undefined && !params.entry) throw new Error("read_session imagePart requires entry.");
			if (params.leafByteStart !== undefined && !params.leaf) throw new Error("leafByteStart requires leaf.");
			const target = targetSession(params.session, ctx as ToolContext);
			onUpdate?.({ content: [{ type: "text", text: `Checking session catalog freshness for ${target.path}...` }], details: {} });
			const emptyFreshness = emptyLiveBranch(target, params.leaf) ? await client.reconcile({ path: target.path }, signal) : undefined;
			if (emptyLiveBranch(target, params.leaf)) {
				return {
					content: [{ type: "text", text: "The current live branch is empty; no entries returned." }],
					details: { path: target.path, sessionId: target.id, requestedLeaf: null, entryCount: 0, leafSelection: "live-empty", freshness: emptyFreshness },
				};
			}
			const requestedLeaf = params.leaf ?? target.leaf ?? undefined;
			let selectedPath = target.path;
			let lineageDepth = 0;
			let lineageSources: any[] | undefined;
			let freshness: any;
			let response;
			if (params.entry && canFollowLineage(target)) {
				const found = await readLineageEntry(client, target, params, signal);
				lineageSources = found.sources;
				if (!found.response) {
					return {
						content: [{ type: "text", text: "Entry was not found on the current session or any validated flatten ancestor." }],
						details: { path: target.path, sessionId: target.id, requestedLeaf, entryCount: 0, lineageSources },
					};
				}
				response = found.response;
				selectedPath = found.source.path;
				lineageDepth = found.source.depth;
				freshness = found.freshness;
			} else {
				freshness = await client.reconcile({ path: target.path }, signal);
				response = await client.read({
					path: target.path,
					entry: params.entry,
					byteStart: params.byteStart,
					leaf: requestedLeaf,
					leafByteStart: params.leafByteStart,
					before: params.before,
					after: params.after,
					limit: params.limit,
					maxChars: params.maxChars,
				}, signal);
			}
			const blocks = response.entries.map(formatEntry);
			let image;
			if (params.imagePart !== undefined) {
				const tempRoot = join(homedir(), "tmp");
				mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
				const tempDir = mkdtempSync(join(tempRoot, "pi-session-image-"));
				image = await client.image({
					path: selectedPath,
					entry: params.entry!,
					byteStart: params.byteStart,
					part: params.imagePart,
					output: join(tempDir, "image"),
				}, signal);
				blocks.push(`Extracted image [entryRef=${formatRef(image.entryRef, params.entry)} part=${params.imagePart}] to ${image.output}.`);
			}
			const note = coverageNote(response.coverage);
			if (note) blocks.push(note);
			const content: any[] = [{ type: "text", text: boundedJoin(blocks) || "No entries returned." }];
			if (image) content.push({ type: "image", data: readFileSync(image.output).toString("base64"), mimeType: image.mime || "image/png" });
			return {
				content,
				details: {
					path: selectedPath,
					rootPath: target.path,
					lineageDepth,
					lineageSources,
					sessionId: response.id || target.id,
					requestedLeaf,
					leafId: response.leafId,
					leafRef: response.leafRef,
					leafSelection: response.leafSelection,
					entryCount: response.entries.length,
					coverage: response.coverage,
					freshness,
					image,
				},
			};
		},
	});

	pi.registerTool({
		name: "grep_current_session",
		label: "Grep Current Session",
		description: "Search the current session's active branch including pre-compaction history and validated flatten ancestors. Phrase (default), BM25 or regex. Returns bounded excerpts and exact entry refs, no model call; use grep_session_bank for other sessions.",
		parameters: CurrentSearchParams,
		async execute(_id, params, signal, onUpdate, ctx) {
			if (!params.query.trim()) throw new Error("Search query cannot be empty.");
			if (["session", "cwd", "global", "tree", "limit", "leaf", "leafByteStart"].some((key) => Object.hasOwn(params, key))) throw new Error("grep_current_session has only the current session scope; use grep_session_bank for other scopes.");
			if (restrictedSourcePath()) throw new Error("This child is restricted to one source; use grep_session_bank with the exact source path.");
			const role = params.role?.trim() || "conversation";
			const maxMatches = Math.max(1, Math.min(50, params.maxMatches ?? 10));
			const includeTools = params.includeTools ?? roleIncludesTools(role);

			{
				const target = targetSession(undefined, ctx as ToolContext);
				const mode = params.mode ?? "phrase";
				onUpdate?.({ content: [{ type: "text", text: `Checking session catalog freshness for ${target.path}...` }], details: {} });
				if (emptyLiveBranch(target, undefined)) {
					const freshness = await client.reconcile({ path: target.path }, signal);
					return {
						content: [{ type: "text", text: "The current live branch is empty; no matches." }],
						details: { count: 0, matchCount: 0, path: target.path, sessionId: target.id, requestedLeaf: null, leafSelection: "live-empty", freshness },
					};
				}
				const requestedLeaf = target.leaf ?? undefined;
				if (canFollowLineage(target)) {
					const lineage = await lineageSearch(client, target, params, { mode, role, includeTools, maxMatches }, signal);
					return {
						content: [{ type: "text", text: lineage.matches.length ? boundedJoin(lineage.matches.map(formatMatch)) : "No matches on the current session or its validated flatten ancestors." }],
						details: {
							count: lineage.matches.length,
							matchCount: lineage.matches.length,
							matches: lineage.matches,
							path: target.path,
							sessionId: target.id,
							requestedLeaf,
							lineageSources: lineage.sources,
							coverage: lineage.coverage,
							freshness: lineage.freshness,
						},
					};
				}
				const freshness = await client.reconcile({ path: target.path }, signal);
				const response = await client.search(params.query, {
					path: target.path,
					leaf: requestedLeaf,
					limit: 1,
					matches: maxMatches,
					mode,
					role,
					includeTools,
				}, signal);
				const result = response.results[0];
				const matches = resultMatches(result);
				return {
					content: [{ type: "text", text: matches.length ? boundedJoin(matches.map(formatMatch)) : "No matches on the selected session branch." }],
					details: {
						count: matches.length,
						matchCount: matches.length,
						matches,
						path: target.path,
						sessionId: target.id || result?.id,
						requestedLeaf,
						leafRef: response.coverage?.leafRef,
						coverage: response.coverage,
						freshness,
					},
				};
			}


		},
	});

	pi.registerTool({
		name: "grep_session_bank",
		label: "Grep Session Bank",
		description: "Search stored Pi sessions with BM25 (default), phrase or regex. Global phrase/regex scans eligible entries and can time out; scope them to a known exact session when possible. Scope by physical session, cwd/tree, or global bank. Returns bounded excerpts and entry refs; expand with read_session. No model call. Output limited to 45 KiB.",
		promptGuidelines: ["Use grep_session_bank with two or three distinctive BM25 terms for broad past-session discovery."],
		parameters: BankSearchParams,
		async execute(_id, params, signal, onUpdate, ctx) {
			if (!params.query.trim()) throw new Error("Search query cannot be empty.");
			if (params.session && (params.cwd || params.global || params.tree)) throw new Error("An exact session cannot be combined with cwd, tree, or global.");
			if (params.cwd && params.global) throw new Error("cwd cannot be combined with global.");
			if (params.tree && !params.cwd) throw new Error("tree=true requires cwd.");
			if (params.leafByteStart !== undefined && !params.leaf) throw new Error("leafByteStart requires leaf.");
			const restriction = restrictedSourcePath();
			if (restriction && (!params.session || params.cwd || params.global)) throw new Error("This helper is restricted to one source; specify its exact session path.");
			const role = params.role?.trim() || "conversation";
			const maxMatches = Math.max(1, Math.min(50, params.maxMatches ?? 10));
			const includeTools = params.includeTools ?? roleIncludesTools(role);
			const mode = params.mode ?? "bm25";
			if (params.session) {
				const target = targetSession(params.session, ctx as ToolContext);
				onUpdate?.({ content: [{ type: "text", text: `Checking session catalog freshness for ${target.path}...` }], details: {} });
				const freshness = await client.reconcile({ path: target.path }, signal);
				const response = await client.search(params.query, {
					path: target.path, leaf: params.leaf, leafByteStart: params.leafByteStart,
					limit: 1, matches: maxMatches, mode, role, includeTools,
				}, signal);
				const result = response.results[0];
				const matches = resultMatches(result);
				return {
					content: [{ type: "text", text: matches.length ? boundedJoin(matches.map(formatMatch)) : "No matches in the selected session." }],
					details: { count: matches.length, matchCount: matches.length, matches, path: target.path, sessionId: target.id || result?.id, coverage: response.coverage, freshness },
				};
			}
			if (params.leaf || params.leafByteStart !== undefined) throw new Error("leaf requires an exact session.");
			const cwd = params.cwd ? resolve(params.cwd) : undefined;
			const sessionLimit = Math.max(1, Math.min(100, params.limit ?? 10));
			onUpdate?.({ content: [{ type: "text", text: `Checking ${cwd ? "project-tree" : "global"} session catalog freshness...` }], details: {} });
			const freshness = await client.reconcile(cwd ? { cwd, tree: Boolean(params.tree) } : { all: true }, signal, { allowIncomplete: true });
			const partial = isPartial(freshness);
			const response = await client.search(params.query, {
				cwd, tree: Boolean(params.tree), limit: sessionLimit, matches: maxMatches,
				mode, role, includeTools, allowPartial: true,
			}, signal);
			const incomplete = partial || isPartial(response.coverage);
			const sessionBlocks = response.results.map(formatSessionResult);
			const text = response.results.length
				? boundedJoin(incomplete ? [PARTIAL_WARNING, ...sessionBlocks] : sessionBlocks)
				: incomplete ? `${PARTIAL_WARNING}\n\nNo matches among fresh indexed session sources.` : "No matching sessions.";
			const matchCount = response.results.reduce((total, result) => total + resultMatches(result).length, 0);
			return {
				content: [{ type: "text", text }],
				details: { count: response.results.length, sessionCount: response.results.length, matchCount, results: response.results, scope: cwd ?? "global", coverage: response.coverage, freshness, partial: incomplete },
			};
		},
	});
}

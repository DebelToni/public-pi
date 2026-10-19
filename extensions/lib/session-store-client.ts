import { spawn } from "node:child_process";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_STDOUT_BYTES = 1024 * 1024;
const DEFAULT_STDERR_BYTES = 64 * 1024;
const READ_ENTRY_METADATA_BYTES = 64 * 1024;
const READ_RESPONSE_METADATA_BYTES = 128 * 1024;
const LIST_RESULT_BYTES = 4 * 1024;
const SEARCH_RESULT_BASE_BYTES = 4 * 1024;
// Excerpts are character-bounded, but JSON control escapes need up to six bytes.
// Include the entry ref and duplicate top-level first match in the base budget.
const SEARCH_MATCH_BYTES = 4 * 1024;
const RESPONSE_OVERHEAD_BYTES = 128 * 1024;

export const SESSION_SOURCE_PATH_ENV = "PI_SESSION_SOURCE_PATH";

export type EntryRef = {
	id: string | null;
	ordinal: number;
	byteStart: number;
	byteEnd: number;
	sourceSha256: string;
};

export type CatalogMatch = {
	excerpt: string;
	matchedEntryId: string;
	matchedEntryRef?: EntryRef;
	matchedRole?: string;
};

export type CatalogCoverage = {
	scopeComplete?: boolean;
	[key: string]: unknown;
};

export type CatalogSession = {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	created?: string | number;
	modified?: string | number;
	messageCount?: number;
	firstMessage?: string;
	excerpt?: string;
	matchedEntryId?: string;
	matchedEntryRef?: EntryRef;
	matchedRole?: string;
	matches?: CatalogMatch[];
	coverage?: CatalogCoverage;
	[key: string]: unknown;
};

export type CatalogPart = {
	part: number;
	kind: string;
	text?: string;
	metadata?: unknown;
	image?: { mime?: string; sha256?: string; bytes?: number };
	[key: string]: unknown;
};

export type CatalogEntry = {
	id: string;
	parentId?: string | null;
	type: string;
	role?: string;
	text?: string;
	parts?: CatalogPart[];
	metadata?: unknown;
	entryRef?: EntryRef;
	byteStart?: number;
	[key: string]: unknown;
};

export type CatalogReadResponse = {
	entries: CatalogEntry[];
	coverage?: CatalogCoverage;
	leafId?: string;
	leafRef?: EntryRef;
	leafSelection?: string;
	[key: string]: unknown;
};

export type CatalogImageResponse = {
	path: string;
	entry: string;
	entryRef?: EntryRef;
	part: number;
	output: string;
	imageSource?: unknown;
	mime?: string;
	sha256?: string;
	bytes?: number;
	[key: string]: unknown;
};

export type CatalogSearchResponse = {
	results: CatalogSession[];
	coverage?: CatalogCoverage;
	[key: string]: unknown;
};

export type BoundedProcessOptions = {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	timeoutMs?: number;
	maxStdoutBytes?: number;
	maxStderrBytes?: number;
};

type ProcessDiagnostics = {
	pid?: number;
	elapsedMs: number;
	stdoutBytes: number;
	stderrBytes: number;
};

export type BoundedProcessResult = ProcessDiagnostics & {
	code: number;
	stdout: string;
	stderr: string;
};

function logCatalogRequest(record: Record<string, unknown>) {
	// Diagnostics must never turn a successful search into an error. Keep two
	// bounded, owner-only files; concurrent append/rotation is best effort.
	try {
		const path = process.env.PI_SESSION_SEARCH_LOG_PATH || join(getAgentDir(), "cache", "session-search-diagnostics.jsonl");
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		try { if (statSync(path).size >= 2 * 1024 * 1024) renameSync(path, `${path}.1`); } catch {}
		appendFileSync(path, JSON.stringify({ time: new Date().toISOString(), parentPid: process.pid, ...record }) + "\n", { mode: 0o600 });
	} catch {}
}

export function runBoundedProcess(command: string, args: string[], options: BoundedProcessOptions = {}): Promise<BoundedProcessResult> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_STDOUT_BYTES;
	const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_STDERR_BYTES;
	return new Promise((resolve, reject) => {
		const started = performance.now();
		const detached = process.platform !== "win32";
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			detached,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let failure: Error | undefined;
		let settled = false;
		let killTimer: NodeJS.Timeout | undefined;

		const kill = (signal: NodeJS.Signals) => {
			if (detached && child.pid) {
				try { process.kill(-child.pid, signal); return; } catch {}
			}
			if (child.exitCode === null && child.signalCode === null) child.kill(signal);
		};
		const terminate = (error: Error) => {
			if (!failure) failure = error;
			kill("SIGTERM");
			killTimer ??= setTimeout(() => kill("SIGKILL"), 1_000);
			killTimer.unref?.();
		};
		const append = (target: Buffer[], chunk: Buffer, kind: "stdout" | "stderr") => {
			if (failure) return;
			if (kind === "stdout") stdoutBytes += chunk.length;
			else stderrBytes += chunk.length;
			const size = kind === "stdout" ? stdoutBytes : stderrBytes;
			const limit = kind === "stdout" ? maxStdoutBytes : maxStderrBytes;
			if (size > limit) {
				terminate(new Error(`${command} exceeded the ${kind} limit (${limit} bytes).`));
				return;
			}
			target.push(chunk);
		};
		child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk, "stdout"));
		child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk, "stderr"));

		const onAbort = () => terminate(new Error(`${command} was aborted.`));
		if (options.signal?.aborted) onAbort();
		else options.signal?.addEventListener("abort", onAbort, { once: true });
		const timeout = setTimeout(() => terminate(new Error(`${command} timed out after ${timeoutMs}ms.`)), timeoutMs);
		timeout.unref?.();

		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			// The leader may exit and close its pipes before a descendant responds
			// to SIGTERM. Do not cancel escalation while leaving that group alive.
			if (failure) kill("SIGKILL");
			if (killTimer) clearTimeout(killTimer);
			options.signal?.removeEventListener("abort", onAbort);
			callback();
		};
		child.on("error", (error) => finish(() => reject(error)));
		child.on("close", (code) => finish(() => {
			const diagnostics = { pid: child.pid, elapsedMs: Math.round(performance.now() - started), stdoutBytes, stderrBytes };
			if (failure) return reject(Object.assign(failure, diagnostics));
			resolve({
				...diagnostics,
				code: code ?? 1,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
			});
		}));
	});
}

function integer(value: number | undefined, fallback: number, min: number, max: number) {
	return Math.max(min, Math.min(max, Math.trunc(value ?? fallback)));
}

function incompleteFreshness(response: any) {
	if (response?.scopeComplete !== false) return undefined;
	const failures = Array.isArray(response.failures) ? response.failures : [];
	const detail = failures.length ? `: ${JSON.stringify(failures).slice(0, 1000)}` : "";
	return new Error(`Session catalog freshness is incomplete${detail}`);
}

export class SessionStoreClient {
	readonly cli: string;

	constructor(cli = process.env.PI_SESSION_CATALOG_CLI || join(getAgentDir(), "bin", "pi-session-catalog")) {
		this.cli = cli;
	}

	private async json(args: string[], options: BoundedProcessOptions = {}, allowIncomplete = false) {
		const separator = args.indexOf("--");
		const invocation = separator < 0
			? [...args, "--compact"]
			: [...args.slice(0, separator), "--compact", ...args.slice(separator)];
		const started = performance.now();
		const flag = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
		const request = {
			operation: args[0], mode: flag("--mode"),
			scope: args.includes("--path") ? "path" : args.includes("--cwd") ? "cwd" : "all",
			limit: flag("--limit"), matches: flag("--matches"),
			queryChars: separator < 0 ? undefined : args[separator + 1]?.length,
		};
		let result: BoundedProcessResult | undefined;
		let response: any;
		let failure: unknown;
		try {
			result = await runBoundedProcess(this.cli, invocation, options);
			try {
				response = JSON.parse(result.stdout);
			} catch (error) {
				if (result.code === 0) throw new Error(`Session catalog returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
			}
			// Accept only the CLI's documented partial receipts, with explicit opt-in.
			const partialReceipt = allowIncomplete && !result.stderr.trim() && (
				args[0] === "reconcile" && result.code === 2 && response?.scopeComplete === false && Array.isArray(response.failures)
				|| ["list", "search"].includes(args[0]) && result.code === 1 && Array.isArray(response?.results) && response?.coverage?.scopeComplete === false
			);
			if (result.code !== 0 && !partialReceipt) {
				const detail = (result.stderr.trim() || (Array.isArray(response?.failures) && response.failures.length ? JSON.stringify(response.failures) : result.stdout))
					.replace(/\s+/g, " ").trim().slice(0, 1000) || "no diagnostic output";
				throw new Error(`Session catalog command failed (exit ${result.code}): ${detail}`);
			}
			return response;
		} catch (error) {
			failure = error;
			if (error instanceof Error) error.message += ` [catalog ${request.operation}; mode=${request.mode || "default"}; scope=${request.scope}]`;
			throw error;
		} finally {
			const processInfo = (result || failure) as Partial<ProcessDiagnostics> | undefined;
			logCatalogRequest({ ...request, pid: processInfo?.pid, elapsedMs: Math.round(performance.now() - started),
				stdoutBytes: processInfo?.stdoutBytes, stderrBytes: processInfo?.stderrBytes, exitCode: result?.code,
				status: failure ? "error" : response?.scopeComplete === false || response?.coverage?.scopeComplete === false ? "partial" : "ok",
					// Backend error strings can embed a query (for example invalid regex).
				// Preserve the full error in the tool result, never in this log.
				errorCategory: !failure ? undefined : result ? result.code !== 0 ? "nonzero_exit" : "invalid_response"
					: failure instanceof Error && failure.message.includes("timed out") ? "timeout"
						: failure instanceof Error && failure.message.includes("was aborted") ? "aborted"
							: failure instanceof Error && failure.message.includes("exceeded the") ? "output_limit" : "process_error",
				performance: response?.performance, backendDurationMs: response?.durationMs,
				failureCount: Array.isArray(response?.failures) ? response.failures.length : response?.coverage?.failureCount });
		}
	}

	async reconcile(scope: { all?: boolean; cwd?: string; path?: string; tree?: boolean }, signal?: AbortSignal, options: { allowIncomplete?: boolean } = {}) {
		const selected = Number(Boolean(scope.all)) + Number(Boolean(scope.cwd)) + Number(Boolean(scope.path));
		if (selected !== 1) throw new Error("Catalog reconcile requires exactly one of all, cwd, or path.");
		const args = ["reconcile"];
		if (scope.all) args.push("--all");
		else if (scope.cwd) args.push("--cwd", scope.cwd);
		else args.push("--path", scope.path!);
		if (scope.tree) args.push("--tree");
		const response = await this.json(args, { signal, timeoutMs: 30_000 }, Boolean(options.allowIncomplete));
		const incomplete = incompleteFreshness(response);
		if (incomplete && !options.allowIncomplete) throw incomplete;
		return response;
	}

	async list(options: { cwd?: string; tree?: boolean; limit?: number; allowPartial?: boolean } = {}, signal?: AbortSignal): Promise<{ results: CatalogSession[]; coverage?: CatalogCoverage }> {
		const limit = integer(options.limit, 100, 1, 1000);
		const args = ["list", "--limit", String(limit)];
		if (options.cwd) args.push("--cwd", options.cwd);
		if (options.tree) args.push("--tree");
		if (options.allowPartial) args.push("--allow-partial");
		const response = await this.json(args, { signal, maxStdoutBytes: RESPONSE_OVERHEAD_BYTES + limit * LIST_RESULT_BYTES }, Boolean(options.allowPartial));
		if (!response || !Array.isArray(response.results)) throw new Error("Session catalog list response is missing results.");
		return response;
	}

	async search(query: string, options: {
		cwd?: string;
		tree?: boolean;
		path?: string;
		leaf?: string;
		byteStart?: number;
		leafByteStart?: number;
		limit?: number;
		matches?: number;
		mode?: "bm25" | "phrase" | "regex";
		role?: string;
		includeTools?: boolean;
		sinceHours?: number;
		allowPartial?: boolean;
	} = {}, signal?: AbortSignal): Promise<CatalogSearchResponse> {
		if (!query.trim()) throw new Error("Session search query cannot be empty.");
		const limit = integer(options.limit, 10, 1, 100);
		const matches = integer(options.matches, 1, 1, 50);
		const args = ["search", "--limit", String(limit)];
		if (options.cwd) args.push("--cwd", options.cwd);
		if (options.tree) args.push("--tree");
		if (options.path) args.push("--path", options.path);
		if (options.leaf) args.push("--leaf", options.leaf);
		if (options.leafByteStart !== undefined) args.push("--leaf-byte-start", String(integer(options.leafByteStart, 0, 0, Number.MAX_SAFE_INTEGER)));
		else if (options.byteStart !== undefined) args.push("--byte-start", String(integer(options.byteStart, 0, 0, Number.MAX_SAFE_INTEGER)));
		if (options.matches !== undefined) args.push("--matches", String(matches));
		if (options.mode) args.push("--mode", options.mode);
		if (options.role && options.role !== "conversation") args.push("--role", options.role);
		if (options.includeTools) args.push("--include-tools");
		if (options.sinceHours !== undefined) args.push("--since-hours", String(Math.max(0, options.sinceHours)));
		if (options.allowPartial) args.push("--allow-partial");
		args.push("--", query);
		const maxStdoutBytes = RESPONSE_OVERHEAD_BYTES + limit * (SEARCH_RESULT_BASE_BYTES + matches * SEARCH_MATCH_BYTES);
		const response = await this.json(args, { signal, maxStdoutBytes }, Boolean(options.allowPartial));
		if (!response || !Array.isArray(response.results)) throw new Error("Session catalog search response is missing results.");
		return response;
	}

	async read(options: { path: string; entry?: string; leaf?: string; byteStart?: number; entryByteStart?: number; leafByteStart?: number; before?: number; after?: number; limit?: number; maxChars?: number }, signal?: AbortSignal): Promise<CatalogReadResponse> {
		if (!options.path) throw new Error("Session read requires a path.");
		const maxChars = integer(options.maxChars, 40_000, 1_000, 200_000);
		const limit = integer(options.limit, 64, 1, 2000);
		const args = [
			"read", "--path", options.path,
			"--before", String(integer(options.before, 12, 0, 1000)),
			"--after", String(integer(options.after, 24, 0, 1000)),
			"--limit", String(limit),
			"--max-chars", String(maxChars),
		];
		if (options.entry) args.push("--entry", options.entry);
		if (options.leaf) args.push("--leaf", options.leaf);
		if (options.entryByteStart !== undefined) args.push("--entry-byte-start", String(integer(options.entryByteStart, 0, 0, Number.MAX_SAFE_INTEGER)));
		if (options.leafByteStart !== undefined) args.push("--leaf-byte-start", String(integer(options.leafByteStart, 0, 0, Number.MAX_SAFE_INTEGER)));
		if (options.byteStart !== undefined && options.entryByteStart === undefined && options.leafByteStart === undefined) args.push("--byte-start", String(integer(options.byteStart, 0, 0, Number.MAX_SAFE_INTEGER)));
		const response = await this.json(args, {
			signal,
			maxStdoutBytes: maxChars * 4 + limit * READ_ENTRY_METADATA_BYTES + READ_RESPONSE_METADATA_BYTES,
		});
		if (!response || !Array.isArray(response.entries)) throw new Error("Session catalog read response is missing entries.");
		return response;
	}

	async image(options: { path: string; entry: string; byteStart?: number; part: number; output: string }, signal?: AbortSignal): Promise<CatalogImageResponse> {
		if (!options.path || !options.entry || !options.output) throw new Error("Session image extraction requires path, entry, part, and output.");
		const args = [
			"image", "--path", options.path,
			"--entry", options.entry,
			"--part", String(integer(options.part, 0, 0, 100_000)),
			"--output", options.output,
		];
		if (options.byteStart !== undefined) args.push("--byte-start", String(integer(options.byteStart, 0, 0, Number.MAX_SAFE_INTEGER)));
		const response = await this.json(args, { signal });
		if (!response || typeof response.output !== "string") throw new Error("Session catalog image response is missing output.");
		return response;
	}
}

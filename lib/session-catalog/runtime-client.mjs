import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";

export const SESSION_CATALOG_CLIENT_VERSION = 1;
const MAX_CATALOG_OUTPUT_BYTES = 64 * 1024 * 1024;

function agentDir() {
	return process.env.PI_AGENT_DIR ? path.resolve(process.env.PI_AGENT_DIR) : path.join(homedir(), ".pi", "agent");
}

function catalogCommand() {
	return process.env.PI_SESSION_CATALOG_CLI
		? path.resolve(process.env.PI_SESSION_CATALOG_CLI)
		: path.join(agentDir(), "bin", "pi-session-catalog");
}

function abortError() {
	return Object.assign(new Error("session catalog request aborted"), { name: "AbortError" });
}

function runCatalog(args, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError());
			return;
		}
		const separator = args.indexOf("--");
		const commandArgs = separator === -1
			? [...args, "--compact"]
			: [...args.slice(0, separator), "--compact", ...args.slice(separator)];
		const child = spawn(catalogCommand(), commandArgs, {
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
		});
		let stdout = "";
		let stderr = "";
		let outputBytes = 0;
		let settled = false;
		const finish = (error, value) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			if (error) reject(error);
			else resolve(value);
		};
		const append = (target, chunk) => {
			outputBytes += chunk.length;
			if (outputBytes > MAX_CATALOG_OUTPUT_BYTES) {
				child.kill("SIGTERM");
				finish(new Error("session catalog output exceeded 64 MiB"));
				return target;
			}
			return target + chunk.toString("utf8");
		};
		const onAbort = () => {
			child.kill("SIGTERM");
			finish(abortError());
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
		child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
		child.on("error", (error) => finish(error));
		child.on("close", (code) => {
			if (settled) return;
			if (code !== 0) {
				finish(new Error(`session catalog exited ${code}: ${(stderr || stdout).trim()}`));
				return;
			}
			try {
				finish(undefined, JSON.parse(stdout));
			} catch (error) {
				finish(new Error(`invalid session catalog response: ${error instanceof Error ? error.message : String(error)}`));
			}
		});
	});
}

function sessionInfo(item, searched = false) {
	return {
		path: item.path,
		id: item.id,
		cwd: item.cwd ?? "",
		name: item.name,
		parentSessionPath: item.parentSessionPath,
		created: new Date(item.created),
		modified: new Date(item.modified),
		messageCount: item.messageCount ?? 0,
		firstMessage: item.firstMessage ?? "(no messages)",
		allMessagesText: searched ? (item.excerpt ?? "") : "",
		...(searched && item.excerpt ? { searchExcerpt: item.excerpt } : {}),
		...(typeof item.score === "number" ? { searchScore: item.score } : {}),
		...(item.matchedEntryId ? { matchedEntryId: item.matchedEntryId } : {}),
	};
}

function inTree(session, cwd) {
	if (!session.cwd) return false;
	const current = path.resolve(cwd);
	const candidate = path.resolve(session.cwd);
	const prefix = current.endsWith(path.sep) ? current : `${current}${path.sep}`;
	return candidate === current || candidate.startsWith(prefix);
}

function catalogSearchMode(rawQuery) {
	const query = rawQuery.trim();
	if (query.startsWith("fuzzy:")) return { mode: "legacy", query: query.slice(6).trim() };
	if (query.startsWith("re:")) return { mode: "regex", query: query.slice(3).trim() };
	const phrase = /^"([\s\S]*)"$/u.exec(query);
	if (phrase) return { mode: "phrase", query: phrase[1] };
	if (query.includes('"')) return undefined;
	return { mode: "bm25", query };
}

function isAbort(error) {
	return error?.name === "AbortError";
}

function waitFor(promise, signal) {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(abortError());
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(abortError());
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

export function createSessionCatalogBoundary({ cwd, useCatalog, fallbackCurrent, fallbackAll }) {
	let catalogHealthy = Boolean(useCatalog);
	let fallbackGeneration = 0;
	const reconciledScopes = new Set();
	const fallbackCache = new Map();
	const fallbackInFlight = new Map();

	const reconcile = async (scope, signal) => {
		const all = scope !== "current";
		await runCatalog(["reconcile", ...(all ? ["--all"] : ["--cwd", cwd])], signal);
		reconciledScopes.add(all ? "all" : "current");
	};

	const listCatalog = async (scope, onProgress) => {
		await reconcile(scope);
		const args = ["list", "--limit", "100000"];
		if (scope === "current") args.push("--cwd", cwd);
		else if (scope === "subtree") args.push("--cwd", cwd, "--tree");
		const response = await runCatalog(args);
		const sessions = (response.results ?? []).map((item) => sessionInfo(item));
		onProgress?.(sessions.length, sessions.length, sessions);
		return sessions;
	};

	const fallbackLoad = async (scope, onProgress) => {
		const baseScope = scope === "current" ? "current" : "all";
		const generation = fallbackGeneration;
		const cached = fallbackCache.get(baseScope);
		let sessions = cached?.generation === generation ? cached.sessions : undefined;
		if (!sessions) {
			let request = fallbackInFlight.get(baseScope);
			if (!request || request.generation !== generation) {
				const reportProgress = scope === "subtree" && onProgress
					? (loaded, total, available) => onProgress(loaded, total, available?.filter((session) => inTree(session, cwd)))
					: onProgress;
				request = {
					generation,
					promise: Promise.resolve(baseScope === "current" ? fallbackCurrent(reportProgress) : fallbackAll(reportProgress)),
				};
				fallbackInFlight.set(baseScope, request);
			}
			try {
				sessions = await request.promise;
				if (fallbackGeneration === generation) fallbackCache.set(baseScope, { generation, sessions });
			} finally {
				if (fallbackInFlight.get(baseScope) === request) fallbackInFlight.delete(baseScope);
			}
		}
		return scope === "subtree" ? sessions.filter((session) => inTree(session, cwd)) : sessions;
	};

	const load = async (scope, onProgress) => {
		fallbackGeneration++;
		fallbackCache.clear();
		if (!catalogHealthy) return fallbackLoad(scope, onProgress);
		try {
			return await listCatalog(scope, onProgress);
		} catch {
			catalogHealthy = false;
			return fallbackLoad(scope, onProgress);
		}
	};

	const legacySearch = async (query, options) => {
		const sessions = await waitFor(fallbackLoad(options.scope), options.signal);
		const { filterAndSortSessions } = await waitFor(import("../modes/interactive/components/session-selector-search.js"), options.signal);
		if (options.signal?.aborted) throw abortError();
		return filterAndSortSessions(sessions, query, options.sortMode, options.nameFilter);
	};

	const search = async (rawQuery, options) => {
		const parsed = catalogSearchMode(rawQuery);
		if (parsed?.mode === "legacy") return legacySearch(parsed.query, options);
		if (!catalogHealthy || !parsed || !parsed.query) return legacySearch(rawQuery, options);
		try {
			const reconcileScope = options.scope === "current" ? "current" : "all";
			if (!reconciledScopes.has(reconcileScope)) await reconcile(options.scope, options.signal);
			const args = ["search", "--mode", parsed.mode, "--limit", "1000"];
			if (options.nameFilter === "named") args.push("--named-only");
			if (options.sortMode === "recent") args.push("--sort", "recent");
			if (options.scope === "current") args.push("--cwd", cwd);
			else if (options.scope === "subtree") args.push("--cwd", cwd, "--tree");
			args.push("--", parsed.query);
			const response = await runCatalog(args, options.signal);
			const sessions = (response.results ?? []).map((item) => sessionInfo(item, true));
			const filtered = options.nameFilter === "named"
				? sessions.filter((session) => typeof session.name === "string" && session.name.trim())
				: sessions;
			if (options.sortMode === "recent") {
				filtered.sort((a, b) => b.modified.getTime() - a.modified.getTime() || a.path.localeCompare(b.path));
			}
			return filtered;
		} catch (error) {
			if (isAbort(error)) throw error;
			return legacySearch(rawQuery, options);
		}
	};

	return {
		loadCurrent: (onProgress) => load("current", onProgress),
		loadSubtree: (onProgress) => load("subtree", onProgress),
		loadAll: (onProgress) => load("all", onProgress),
		search,
	};
}

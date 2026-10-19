import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const release = process.env.PI_CODEX_ULTRA_RELEASE_ROOT;
if (!release) throw new Error("Anton catalog adapter requires PI_CODEX_ULTRA_RELEASE_ROOT");
const { runSessionCatalog, toSessionInfo, parseCatalogQuery } = await import(pathToFileURL(resolve(release, "suite/runtime/session-catalog-client.mjs")).href);

function sessions(response, searched = false) {
	const coverage = response.coverage;
	if (typeof coverage?.scopeComplete !== "boolean") throw new Error("Session catalog response has no coverage");
	const rows = response.results.map((row) => toSessionInfo(row, searched));
	const warning = coverage.scopeComplete ? undefined
		: `Catalog incomplete: showing fresh sessions; skipped ${coverage.excludedFiles ?? coverage.failureCount} file(s), ${coverage.failedScopes ?? 0} failed reconciliation scope(s).`;
	Object.defineProperty(rows, "catalogWarning", { value: warning, configurable: true });
	Object.defineProperty(rows, "catalogCoverage", { value: coverage });
	return rows;
}

export function createSessionCatalogBoundary({ cwd, enabled = true, command, env = process.env }) {
	if (!enabled) return undefined;
	const run = (args, signal) => runSessionCatalog(args, { signal, command, env });
	const refreshing = new Map();
	const reconciled = new Set();
	const argsForList = (scope) => ["list", "--limit", "100000", "--allow-partial", ...(scope === "current" ? ["--cwd", cwd] : [])];
	const reconcile = async (scope, signal) => {
		await run(scope === "current" ? ["reconcile", "--cwd", cwd] : ["reconcile", "--all"], signal);
		reconciled.add(scope);
	};
	const load = async (scope, onProgress, signal) => {
		let snapshot, refresh;
		try {
			try {
				const result = await run(argsForList(scope), signal);
				snapshot = sessions(result).filter((session) => existsSync(session.path));
				Object.defineProperty(snapshot, "catalogWarning", { value: "Catalog snapshot: checking for newer sessions…", configurable: true });
				onProgress?.(0, 1, snapshot);
			} catch (error) {
				if (signal?.aborted || error?.name === "AbortError") throw error;
				// A missing or incompatible catalog has no snapshot; reconciliation may create it.
			}
			refresh = reconcile(scope, signal);
			refreshing.set(scope, refresh);
			await refresh;
			const fresh = sessions(await run(argsForList(scope), signal));
			onProgress?.(fresh.length, fresh.length, fresh);
			return fresh;
		} catch (error) {
			if (signal?.aborted || error?.name === "AbortError" || !snapshot) throw error;
			Object.defineProperty(snapshot, "catalogWarning", {
				value: `Catalog refresh failed; showing an unverified snapshot: ${error instanceof Error ? error.message : String(error)}`,
				configurable: true,
			});
			return snapshot;
		} finally {
			if (refreshing.get(scope) === refresh) refreshing.delete(scope);
		}
	};
	const search = async (raw, options) => {
		const scope = options.scope === "current" ? "current" : "all";
		if (refreshing.has(scope)) await refreshing.get(scope);
		else if (!reconciled.has(scope)) await reconcile(scope, options.signal);
		options.signal?.throwIfAborted();
		const parsed = parseCatalogQuery(raw);
		if (!parsed.query) throw new Error(`Session catalog ${parsed.mode} query is empty.`);
		const args = ["search", "--mode", parsed.mode, "--limit", "1000", "--allow-partial"];
		if (parsed.mode === "bm25") args.push("--title-first");
		if (scope === "current") args.push("--cwd", cwd);
		if (options.nameFilter === "named") args.push("--named-only");
		if (options.sortMode === "recent") args.push("--sort", "recent");
		args.push("--", parsed.query);
		return sessions(await run(args, options.signal), true);
	};
	return { loadCurrent: (progress, signal) => load("current", progress, signal),
		loadAll: (progress, signal) => load("all", progress, signal), search };
}

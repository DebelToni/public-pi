#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { encodeSessionBucket } from "../lib/session-catalog/index.mjs";
import { createSessionCatalogBoundary } from "../lib/session-catalog/runtime-client.mjs";

const AGENT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CATALOG_CLI = path.join(AGENT_ROOT, "bin", "pi-session-catalog");
const PI_ROOT = process.env.PI_CODING_AGENT_ROOT ?? "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";

function writeSession(filePath, { id, cwd, text, name, timestamp = Date.now() }) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const rows = [
		{ type: "session", version: 3, id, timestamp: new Date(timestamp - 1_000).toISOString(), cwd },
		{
			type: "message",
			id: `${id}-user`,
			parentId: null,
			timestamp: new Date(timestamp).toISOString(),
			message: { role: "user", content: text, timestamp },
		},
		...(name ? [{ type: "session_info", id: `${id}-name`, parentId: `${id}-user`, timestamp: new Date(timestamp + 1).toISOString(), name }] : []),
	];
	fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-catalog-resume-"));
	const agentDir = path.join(root, "agent");
	const sessionsRoot = path.join(agentDir, "sessions");
	const cwd = path.join(root, "wiki");
	const childCwd = path.join(cwd, "child");
	const currentFile = path.join(sessionsRoot, encodeSessionBucket(cwd), "current.jsonl");
	const childFile = path.join(sessionsRoot, encodeSessionBucket(childCwd), "child.jsonl");
	const timestamp = Date.now();
	writeSession(currentFile, { id: "current", cwd, text: "catalog needle current", timestamp: timestamp - 60_000 });
	writeSession(childFile, { id: "child", cwd: childCwd, text: "catalog needle child", name: "Named child", timestamp });
	return { root, agentDir, cwd, childCwd, currentFile, childFile };
}

function withCatalogEnvironment(agentDir, callback) {
	const previousAgentDir = process.env.PI_AGENT_DIR;
	const previousCli = process.env.PI_SESSION_CATALOG_CLI;
	process.env.PI_AGENT_DIR = agentDir;
	process.env.PI_SESSION_CATALOG_CLI = CATALOG_CLI;
	return Promise.resolve()
		.then(callback)
		.finally(() => {
			if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
			else process.env.PI_AGENT_DIR = previousAgentDir;
			if (previousCli === undefined) delete process.env.PI_SESSION_CATALOG_CLI;
			else process.env.PI_SESSION_CATALOG_CLI = previousCli;
		});
}

function fallbackSession(id, cwd) {
	return {
		path: `/tmp/${id}.jsonl`,
		id,
		cwd,
		created: new Date(0),
		modified: new Date(0),
		messageCount: 1,
		firstMessage: id,
		allMessagesText: id,
	};
}

test("catalog boundary reconciles, filters scopes, and returns excerpts", async (t) => {
	const f = fixture();
	t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	await withCatalogEnvironment(f.agentDir, async () => {
		let fallbackCalls = 0;
		const boundary = createSessionCatalogBoundary({
			cwd: f.cwd,
			useCatalog: true,
			fallbackCurrent: async () => { fallbackCalls++; return []; },
			fallbackAll: async () => { fallbackCalls++; return []; },
		});
		const progress = [];
		const current = await boundary.loadCurrent((loaded, total, available) => progress.push([loaded, total, available?.length]));
		assert.deepEqual(current.map((session) => session.id), ["current"]);
		assert.equal(current[0].allMessagesText, "");
		assert.deepEqual(progress.at(-1), [1, 1, 1]);
		assert.deepEqual((await boundary.loadSubtree()).map((session) => session.id).sort(), ["child", "current"]);
		assert.equal((await boundary.loadAll()).length, 2);

		const searched = await boundary.search("catalog needle", {
			scope: "current",
			sortMode: "relevance",
			nameFilter: "all",
			signal: new AbortController().signal,
		});
		assert.equal(searched.length, 1);
		assert.equal(searched[0].path, f.currentFile);
		assert.match(searched[0].searchExcerpt, /catalog needle current/i);
		assert.equal(searched[0].matchedEntryId, "current-user");

		const phrase = await boundary.search('"catalog needle child"', {
			scope: "all", sortMode: "relevance", nameFilter: "all", signal: new AbortController().signal,
		});
		assert.deepEqual(phrase.map((session) => session.id), ["child"]);
		const regex = await boundary.search("re:needle\\s+child", {
			scope: "all", sortMode: "relevance", nameFilter: "all", signal: new AbortController().signal,
		});
		assert.deepEqual(regex.map((session) => session.id), ["child"]);
		const named = await boundary.search("catalog needle", {
			scope: "all", sortMode: "relevance", nameFilter: "named", signal: new AbortController().signal,
		});
		assert.deepEqual(named.map((session) => session.id), ["child"]);
		const recent = await boundary.search("catalog needle", {
			scope: "all", sortMode: "recent", nameFilter: "all", signal: new AbortController().signal,
		});
		assert.deepEqual(recent.map((session) => session.id), ["child", "current"]);
		assert.equal(fallbackCalls, 0);
	});
});

test("catalog failure and custom session directories use the authoritative fallback", async (t) => {
	const f = fixture();
	t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	await withCatalogEnvironment(f.agentDir, async () => {
		const expected = [fallbackSession("fallback", f.cwd)];
		process.env.PI_SESSION_CATALOG_CLI = path.join(f.root, "missing-command");
		let calls = 0;
		const failed = createSessionCatalogBoundary({
			cwd: f.cwd,
			useCatalog: true,
			fallbackCurrent: async () => { calls++; return expected; },
			fallbackAll: async () => { calls++; return expected; },
		});
		assert.deepEqual(await failed.loadCurrent(), expected);
		assert.equal(calls, 1);

		const outside = fallbackSession("outside", path.join(f.root, "elsewhere"));
		const refreshed = [fallbackSession("refreshed", f.cwd)];
		let currentFallback = expected;
		const custom = createSessionCatalogBoundary({
			cwd: f.cwd,
			useCatalog: false,
			fallbackCurrent: async () => currentFallback,
			fallbackAll: async (onProgress) => {
				onProgress?.(2, 2, [...expected, outside]);
				return [...expected, outside];
			},
		});
		assert.deepEqual(await custom.loadCurrent(), expected);
		currentFallback = refreshed;
		assert.deepEqual(await custom.loadCurrent(), refreshed);
		const progress = [];
		assert.deepEqual(await custom.loadSubtree((_loaded, _total, available) => progress.push(available)), expected);
		assert.deepEqual(progress, [expected]);
	});
});

test("installed catalog boundary preserves built-in search when fallback is active", async () => {
	const { createSessionCatalogBoundary: createInstalledBoundary } = await import(
		pathToFileURL(path.join(PI_ROOT, "dist/core/session-catalog-client.js")).href
	);
	const cwd = "/tmp/project";
	const sessions = [
		{ ...fallbackSession("matching", cwd), allMessagesText: "legacy fuzzy needle" },
		{ ...fallbackSession("other", cwd), allMessagesText: "unrelated" },
	];
	let fallbackCalls = 0;
	const boundary = createInstalledBoundary({
		cwd,
		useCatalog: true,
		fallbackCurrent: async () => { fallbackCalls++; return sessions; },
		fallbackAll: async () => { fallbackCalls++; return sessions; },
	});
	const found = await boundary.search("fuzzy:needle", {
		scope: "current",
		sortMode: "relevance",
		nameFilter: "all",
		signal: new AbortController().signal,
	});
	assert.deepEqual(found.map((session) => session.id), ["matching"]);
	await assert.doesNotReject(boundary.search('legacy "needle"', {
		scope: "current",
		sortMode: "relevance",
		nameFilter: "all",
		signal: new AbortController().signal,
	}));
	assert.equal(fallbackCalls, 1);
});

test("legacy fallback search aborts stale callers and coalesces the authoritative scan", async () => {
	const { createSessionCatalogBoundary: createInstalledBoundary } = await import(
		pathToFileURL(path.join(PI_ROOT, "dist/core/session-catalog-client.js")).href
	);
	const cwd = "/tmp/project";
	let scans = 0;
	const sessions = [{ ...fallbackSession("matching", cwd), allMessagesText: "shared needle" }];
	const boundary = createInstalledBoundary({
		cwd,
		useCatalog: false,
		fallbackCurrent: async () => {
			scans++;
			await new Promise((resolve) => setTimeout(resolve, 80));
			return sessions;
		},
		fallbackAll: async () => sessions,
	});
	const firstController = new AbortController();
	const options = { scope: "current", sortMode: "relevance", nameFilter: "all" };
	const first = boundary.search("fuzzy:missing", { ...options, signal: firstController.signal });
	const second = boundary.search("fuzzy:needle", { ...options, signal: new AbortController().signal });
	setTimeout(() => firstController.abort(), 10);
	await assert.rejects(first, (error) => error?.name === "AbortError");
	assert.deepEqual((await second).map((session) => session.id), ["matching"]);
	assert.equal(scans, 1);
});

test("catalog search subprocess is abortable", async (t) => {
	const f = fixture();
	t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
	await withCatalogEnvironment(f.agentDir, async () => {
		const sleeper = path.join(f.root, "slow-catalog");
		fs.writeFileSync(sleeper, "#!/usr/bin/env node\nsetTimeout(() => console.log('{}'), 5000);\n", { mode: 0o755 });
		process.env.PI_SESSION_CATALOG_CLI = sleeper;
		const boundary = createSessionCatalogBoundary({
			cwd: f.cwd,
			useCatalog: true,
			fallbackCurrent: async () => [],
			fallbackAll: async () => [],
		});
		const controller = new AbortController();
		const started = performance.now();
		const request = boundary.search("needle", {
			scope: "current",
			sortMode: "relevance",
			nameFilter: "all",
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 50);
		await assert.rejects(request, (error) => error?.name === "AbortError");
		assert.ok(performance.now() - started < 1_000);
	});
});

test("patched selector debounces search, cancels stale work, and renders catalog excerpts", async () => {
	const [{ SessionSelectorComponent }, { initTheme }] = await Promise.all([
		import(pathToFileURL(path.join(PI_ROOT, "dist/modes/interactive/components/session-selector.js")).href),
		import(pathToFileURL(path.join(PI_ROOT, "dist/modes/interactive/theme/theme.js")).href),
	]);
	initTheme("dark");
	const base = fallbackSession("base", "/tmp/project");
	let firstAborted = false;
	let deletionAborted = false;
	const calls = [];
	const search = (query, options) => new Promise((resolve, reject) => {
		calls.push({ query, scope: options.scope });
		const occurrence = calls.filter((call) => call.query === query).length;
		const slow = query === "a" || (query === "ab c" && occurrence === 1);
		const timer = setTimeout(() => resolve([{ ...base, path: `/tmp/${query}.jsonl`, id: query, firstMessage: "ignored", searchExcerpt: `excerpt ${query}` }]), slow ? 300 : 20);
		options.signal.addEventListener("abort", () => {
			clearTimeout(timer);
			if (query === "a") firstAborted = true;
			if (query === "ab c") deletionAborted = true;
			reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
		}, { once: true });
	});
	const loader = async () => [base];
	const selector = new SessionSelectorComponent(loader, loader, loader, () => {}, () => {}, () => {}, () => {}, {
		showRenameHint: false,
		searchSessions: search,
	});
	await new Promise((resolve) => setTimeout(resolve, 20));
	const list = selector.getSessionList();
	list.handleInput("a");
	await new Promise((resolve) => setTimeout(resolve, 150));
	list.handleInput("b");
	await new Promise((resolve) => setTimeout(resolve, 180));
	assert.equal(firstAborted, true);
	assert.deepEqual(calls.map((call) => call.query), ["a", "ab"]);
	assert.match(list.render(100).join("\n"), /excerpt ab/);
	list.handleInput(" ");
	list.handleInput("c");
	await new Promise((resolve) => setTimeout(resolve, 150));
	list.handleInput("\x1b[127;5u");
	await new Promise((resolve) => setTimeout(resolve, 180));
	assert.equal(deletionAborted, true);
	assert.deepEqual(calls.map((call) => call.query), ["a", "ab", "ab c", "ab c"]);
	assert.match(list.render(100).join("\n"), /excerpt ab c/);
	const selectorSource = fs.readFileSync(path.join(PI_ROOT, "dist/modes/interactive/components/session-selector.js"), "utf8");
	assert.match(selectorSource, /this\.catalogSearch \? "BM25"/);
	assert.match(selectorSource, /fuzzy:<text> legacy/);
});

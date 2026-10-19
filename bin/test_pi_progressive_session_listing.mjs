#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const ROOT = process.env.PI_CODING_AGENT_ROOT
	?? "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";

async function load(relativePath) {
	return import(pathToFileURL(join(ROOT, relativePath)).href);
}

const [{ SessionManager }, { SessionSelectorComponent }, { initTheme }] = await Promise.all([
	load("dist/core/session-manager.js"),
	load("dist/modes/interactive/components/session-selector.js"),
	load("dist/modes/interactive/theme/theme.js"),
]);
initTheme("dark");

function sessionInfo(path, id, modified, firstMessage = id) {
	return {
		path,
		id,
		cwd: "/tmp/project",
		created: new Date(modified - 1_000),
		modified: new Date(modified),
		messageCount: 1,
		firstMessage,
		allMessagesText: firstMessage,
	};
}

function writeSession(directory, { id, cwd, messageTime, mtime, padding = 0 }) {
	const path = join(directory, `${id}.jsonl`);
	const headerTime = new Date(messageTime - 1_000).toISOString();
	const rows = [
		{ type: "session", version: 3, id, timestamp: headerTime, cwd },
		{
			type: "message",
			id: `${id}-message`,
			parentId: null,
			timestamp: new Date(messageTime).toISOString(),
			message: { role: "user", content: `${id}${"x".repeat(padding)}`, timestamp: messageTime },
		},
	];
	writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
	const physicalTime = new Date(mtime);
	utimesSync(path, physicalTime, physicalTime);
	return path;
}

function nextTurn() {
	return new Promise((resolve) => setImmediate(resolve));
}

test("session listing publishes a newest-physical-first prefix before completion", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-progressive-list-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	const sessions = join(root, "sessions");
	mkdirSync(cwd);
	mkdirSync(sessions);
	const now = Date.now();
	const physicalOrder = Array.from({ length: 12 }, (_, index) => `physical-${String(index).padStart(2, "0")}`);
	for (let index = 0; index < physicalOrder.length; index++) {
		writeSession(sessions, {
			id: physicalOrder[index],
			cwd,
			messageTime: now - (physicalOrder.length - index) * 1_000,
			mtime: now - index * 1_000,
			padding: index === 0 ? 8_000_000 : 0,
		});
	}

	const published = [];
	const previewed = [];
	const progress = [];
	let firstPublishedAt;
	const result = await SessionManager.list(cwd, sessions, (loaded, total, available) => {
		progress.push([loaded, total]);
		if (available?.length && firstPublishedAt === undefined) firstPublishedAt = loaded;
		for (const session of available ?? []) {
			if (session.partial) previewed.push(session.id);
			else published.push(session.id);
		}
	});

	assert.deepEqual(previewed, physicalOrder);
	assert.deepEqual(published, physicalOrder);
	assert.deepEqual(result.map((session) => session.id), [...physicalOrder].reverse());
	assert.equal(firstPublishedAt, 0, "lightweight previews must appear before full indexing starts");
	assert.equal(progress.at(-1)?.[0], physicalOrder.length);
	assert.equal(progress.at(-1)?.[1], physicalOrder.length);
});

test("progressive batches honor custom-directory cwd filtering", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-progressive-filter-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const wantedCwd = join(root, "wanted");
	const otherCwd = join(root, "other");
	const sessions = join(root, "sessions");
	mkdirSync(wantedCwd);
	mkdirSync(otherCwd);
	mkdirSync(sessions);
	const now = Date.now();
	for (let index = 0; index < 10; index++) {
		writeSession(sessions, {
			id: `other-${index}`,
			cwd: index === 2 ? "" : otherCwd,
			messageTime: now - index * 1_000,
			mtime: now - index * 1_000,
			padding: index === 0 ? 5_000_000 : 0,
		});
	}
	writeSession(sessions, { id: "wanted", cwd: wantedCwd, messageTime: now - 10_000, mtime: now - 10_000 });
	writeSession(sessions, { id: "other-tail", cwd: otherCwd, messageTime: now - 11_000, mtime: now - 11_000 });

	const published = [];
	let wantedPublishedAt;
	const result = await SessionManager.list(wantedCwd, sessions, (loaded, total, available) => {
		for (const session of available ?? []) {
			published.push(session.id);
			if (session.id === "wanted" && wantedPublishedAt === undefined) wantedPublishedAt = [loaded, total];
		}
	});
	assert(published.length >= 2);
	assert(published.every((id) => id === "wanted"));
	assert.deepEqual(result.map((session) => session.id), ["wanted"]);
	assert.equal(wantedPublishedAt?.[0], 0);
});

test("the selector renders and remains selectable while older sessions load", async () => {
	const now = Date.now();
	const first = sessionInfo("/tmp/first.jsonl", "first", now - 2_000, "first visible");
	const selected = sessionInfo("/tmp/selected.jsonl", "selected", now - 3_000, "selected visible");
	const laterTop = sessionInfo("/tmp/later-top.jsonl", "later-top", now - 1_000, "later top");
	let reportProgress;
	let finishLoad;
	const result = new Promise((resolve) => {
		finishLoad = resolve;
	});
	const loader = (onProgress) => {
		reportProgress = onProgress;
		return result;
	};
	let chosen;
	let renders = 0;
	const selector = new SessionSelectorComponent(
		loader,
		loader,
		loader,
		(path) => { chosen = path; },
		() => {},
		() => {},
		() => { renders++; },
		{ showRenameHint: false },
	);
	await nextTurn();
	assert.equal(typeof reportProgress, "function");

	reportProgress(2, 3, [first, selected]);
	await nextTurn();
	const list = selector.getSessionList();
	assert.match(list.render(100).join("\n"), /first visible/);
	assert.equal(list.getSelectedSessionPath(), first.path);

	list.handleInput("\u001b[B");
	assert.equal(list.getSelectedSessionPath(), selected.path);
	reportProgress(3, 3, [laterTop]);
	await nextTurn();
	assert.equal(list.getSelectedSessionPath(), selected.path, "backfill must preserve the selected session path");
	const rendered = list.render(100).join("\n");
	assert(rendered.indexOf("later top") < rendered.indexOf("first visible"));

	list.handleInput("\r");
	assert.equal(chosen, selected.path, "a progressively loaded item must be immediately selectable");
	finishLoad([laterTop, first, selected]);
	await nextTurn();
	assert(renders > 0);
});

test("the first filtered batch renders even when it contains more than the backfill chunk", async () => {
	const now = Date.now();
	const batch = Array.from({ length: 11 }, (_, index) =>
		sessionInfo(`/tmp/filtered-${index}.jsonl`, `filtered-${index}`, now - index, `filtered ${index}`));
	let reportProgress;
	let finishLoad;
	const result = new Promise((resolve) => { finishLoad = resolve; });
	const loader = (onProgress) => {
		reportProgress = onProgress;
		return result;
	};
	const selector = new SessionSelectorComponent(loader, loader, loader, () => {}, () => {}, () => {}, () => {}, { showRenameHint: false });
	await nextTurn();
	reportProgress(29, 30, batch);
	await nextTurn();
	assert.match(selector.getSessionList().render(100).join("\n"), /filtered 0/);
	finishLoad(batch);
	await nextTurn();
});

test("backfill expands a collapsed chain rather than changing the selected session", async () => {
	const now = Date.now();
	const parent = sessionInfo("/tmp/parent.jsonl", "parent", now, "parent visible");
	const child = { ...sessionInfo("/tmp/child.jsonl", "child", now - 1_000, "child visible"), parentSessionPath: parent.path };
	let reportProgress;
	let finishLoad;
	const result = new Promise((resolve) => { finishLoad = resolve; });
	const loader = (onProgress) => {
		reportProgress = onProgress;
		return result;
	};
	const selector = new SessionSelectorComponent(loader, loader, loader, () => {}, () => {}, () => {}, () => {}, { showRenameHint: false });
	await nextTurn();
	reportProgress(1, 2, [parent]);
	await nextTurn();
	const list = selector.getSessionList();
	assert.equal(list.getSelectedSessionPath(), parent.path);

	reportProgress(2, 2, [child]);
	await nextTurn();
	assert.equal(list.getSelectedSessionPath(), parent.path);
	assert.match(list.render(100).join("\n"), /parent visible/);
	assert.match(list.render(100).join("\n"), /child visible/);
	finishLoad([parent, child]);
	await nextTurn();
});

test("a stale load generation cannot replace a newer refresh", async () => {
	const now = Date.now();
	const stale = sessionInfo("/tmp/stale.jsonl", "stale", now - 1_000, "stale result");
	const fresh = sessionInfo("/tmp/fresh.jsonl", "fresh", now, "fresh result");
	const loads = [];
	const loader = (onProgress) => new Promise((resolve) => loads.push({ onProgress, resolve }));
	const selector = new SessionSelectorComponent(loader, loader, loader, () => {}, () => {}, () => {}, () => {}, { showRenameHint: false });
	await nextTurn();
	assert.equal(loads.length, 1);
	loads[0].onProgress(1, 2, [stale]);
	await nextTurn();
	assert.match(selector.getSessionList().render(100).join("\n"), /stale result/);

	const refresh = selector.refreshSessionsAfterMutation();
	await nextTurn();
	assert.equal(loads.length, 2);
	loads[1].onProgress(1, 2, [fresh]);
	await nextTurn();
	let rendered = selector.getSessionList().render(100).join("\n");
	assert.match(rendered, /fresh result/);
	assert.doesNotMatch(rendered, /stale result/);

	loads[1].resolve([fresh]);
	await refresh;
	loads[0].resolve([stale]);
	await nextTurn();
	rendered = selector.getSessionList().render(100).join("\n");
	assert.match(rendered, /fresh result/);
	assert.doesNotMatch(rendered, /stale result/);
});

test("selector sorting avoids JSONL rereads and subtree predicates reject missing cwd", () => {
	const managerSource = readFileSync(join(ROOT, "dist/core/session-manager.js"), "utf8");
	const selectorSource = readFileSync(join(ROOT, "dist/modes/interactive/components/session-selector.js"), "utf8");
	const pickerSource = readFileSync(join(ROOT, "dist/cli/session-picker.js"), "utf8");
	const interactiveSource = readFileSync(join(ROOT, "dist/modes/interactive/interactive-mode.js"), "utf8");
	const catalogClientSource = readFileSync(join(ROOT, "dist/core/session-catalog-client.js"), "utf8");
	assert.match(managerSource, /async function buildSessionPreview\(filePath\)/);
	assert.match(managerSource, /MAX_CONCURRENT_SESSION_PREVIEW_LOADS = 16/);
	assert.match(managerSource, /MAX_CONCURRENT_SESSION_METADATA_LOADS = 32/);
	assert.equal(selectorSource.includes('readFileSync(session.path, "utf8")'), false);
	assert.match(selectorSource, /const canonicalPathCache = new Map\(\);/);
	assert.match(selectorSource, /mergeProgressSessions\(scope, available\) \{/);
	assert.match(pickerSource, /if \(!session\.cwd\)\s+return false;/);
	assert.match(pickerSource, /currentCwd\.endsWith\(sep\)/);
	assert.match(interactiveSource, /createSessionCatalogBoundary\(\{/);
	assert.match(catalogClientSource, /if \(!session\.cwd\) return false;/);
	assert.match(catalogClientSource, /current\.endsWith\(path\.sep\)/);
});

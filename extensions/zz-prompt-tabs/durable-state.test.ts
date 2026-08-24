import assert from "node:assert/strict";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import {
	atomicWritePromptTabsState,
	DurablePromptTabsStore,
	type DurablePromptTabsState,
} from "./durable-state.ts";
import type { DraftTabsSnapshot } from "./tabbed-editor.ts";

function fixture(t: test.TestContext) {
	const root = mkdtempSync("/tmp/pi-prompt-tabs-");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return {
		root,
		stateRoot: join(root, "state"),
		sessionPath(name: string) {
			return join(root, "sessions", `${name}.jsonl`);
		},
	};
}

function writeSession(path: string, sessionId: string) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date(0).toISOString(), cwd: "/tmp" })}\n`);
}

function onlyStateFile(stateRoot: string) {
	const directory = join(stateRoot, readdirSync(stateRoot)[0]!);
	const files = readdirSync(directory).filter((name) => name.endsWith(".json"));
	assert.equal(files.length, 1);
	return { directory, path: join(directory, files[0]!) };
}

const exactSnapshot: DraftTabsSnapshot = {
	texts: ["draft one", "draft two", ""],
	activeIndex: 2,
};

test("restores tab text, order, and a selected empty tab exactly", (t) => {
	const { stateRoot, sessionPath } = fixture(t);
	const sessionFile = sessionPath("exact");
	writeSession(sessionFile, "session-exact");
	new DurablePromptTabsStore("session-exact", sessionFile, stateRoot).save(exactSnapshot);

	const restored = new DurablePromptTabsStore("session-exact", sessionFile, stateRoot).load();
	assert.deepEqual(restored.snapshot, exactSnapshot);
	assert.deepEqual(restored.diagnostics, []);

	const location = onlyStateFile(stateRoot);
	assert.equal(statSync(stateRoot).mode & 0o777, 0o700);
	assert.equal(statSync(location.directory).mode & 0o777, 0o700);
	assert.equal(statSync(location.path).mode & 0o777, 0o600);
});

test("a synchronously saved edit survives abrupt teardown without lifecycle callbacks", (t) => {
	const { stateRoot, sessionPath } = fixture(t);
	const sessionFile = sessionPath("abrupt");
	writeSession(sessionFile, "session-abrupt");
	const liveStore = new DurablePromptTabsStore("session-abrupt", sessionFile, stateRoot);
	liveStore.save({ texts: ["last keystroke"], activeIndex: 0 });

	const restartedStore = new DurablePromptTabsStore("session-abrupt", sessionFile, stateRoot);
	assert.deepEqual(restartedStore.load().snapshot, { texts: ["last keystroke"], activeIndex: 0 });
});

test("session identity prevents another session from restoring the tabs", (t) => {
	const { stateRoot, sessionPath } = fixture(t);
	const sessionA = sessionPath("a");
	const sessionB = sessionPath("b");
	writeSession(sessionA, "session-a");
	writeSession(sessionB, "session-b");
	new DurablePromptTabsStore("session-a", sessionA, stateRoot).save(exactSnapshot);

	assert.equal(new DurablePromptTabsStore("session-b", sessionB, stateRoot).load().snapshot, undefined);
});

test("a copied same-ID session cannot steal or overwrite the source tabs", (t) => {
	const { stateRoot, sessionPath } = fixture(t);
	const source = sessionPath("source");
	const copy = sessionPath("copy");
	writeSession(source, "copied-id");
	copyFileSync(source, copy);
	new DurablePromptTabsStore("copied-id", source, stateRoot).save({ texts: ["source draft"], activeIndex: 0 });

	const copyStore = new DurablePromptTabsStore("copied-id", copy, stateRoot);
	assert.equal(copyStore.load().snapshot, undefined);
	copyStore.save({ texts: ["copy draft"], activeIndex: 0 });

	assert.deepEqual(
		new DurablePromptTabsStore("copied-id", source, stateRoot).load().snapshot,
		{ texts: ["source draft"], activeIndex: 0 },
	);
	assert.deepEqual(
		new DurablePromptTabsStore("copied-id", copy, stateRoot).load().snapshot,
		{ texts: ["copy draft"], activeIndex: 0 },
	);
});

test("a moved session recovers when the old physical path vanished", (t) => {
	const { stateRoot, sessionPath } = fixture(t);
	const oldPath = sessionPath("old");
	const movedPath = sessionPath("moved");
	writeSession(oldPath, "moved-id");
	new DurablePromptTabsStore("moved-id", oldPath, stateRoot).save(exactSnapshot);
	renameSync(oldPath, movedPath);

	const movedStore = new DurablePromptTabsStore("moved-id", movedPath, stateRoot);
	assert.deepEqual(movedStore.load().snapshot, exactSnapshot);
	movedStore.save(exactSnapshot);
	assert.deepEqual(new DurablePromptTabsStore("moved-id", movedPath, stateRoot).load().snapshot, exactSnapshot);
});

test("malformed state is retained and reported without blocking valid recovery", (t) => {
	const { stateRoot, sessionPath } = fixture(t);
	const sessionFile = sessionPath("malformed");
	writeSession(sessionFile, "malformed-id");
	new DurablePromptTabsStore("malformed-id", sessionFile, stateRoot).save(exactSnapshot);
	const { directory } = onlyStateFile(stateRoot);
	const malformedPath = join(directory, "malformed.json");
	writeFileSync(malformedPath, "{broken\n");

	const loaded = new DurablePromptTabsStore("malformed-id", sessionFile, stateRoot).load();
	assert.deepEqual(loaded.snapshot, exactSnapshot);
	assert.deepEqual(loaded.diagnostics, ["Retained 1 malformed prompt-tab state record."]);
	assert.equal(readFileSync(malformedPath, "utf8"), "{broken\n");
});

test("an interrupted atomic replacement leaves the last complete state usable", (t) => {
	const { stateRoot, sessionPath } = fixture(t);
	const sessionFile = sessionPath("atomic");
	writeSession(sessionFile, "atomic-id");
	new DurablePromptTabsStore("atomic-id", sessionFile, stateRoot).save({ texts: ["complete"], activeIndex: 0 });
	const location = onlyStateFile(stateRoot);
	const previous = JSON.parse(readFileSync(location.path, "utf8")) as DurablePromptTabsState;
	const replacement: DurablePromptTabsState = {
		...previous,
		updatedAt: previous.updatedAt + 1,
		tabs: [{ text: "incomplete" }],
	};

	assert.throws(
		() => atomicWritePromptTabsState(location.path, replacement, { beforeRename: () => { throw new Error("simulated crash"); } }),
		/simulated crash/,
	);
	assert.deepEqual(
		new DurablePromptTabsStore("atomic-id", sessionFile, stateRoot).load().snapshot,
		{ texts: ["complete"], activeIndex: 0 },
	);
	assert.equal(readdirSync(location.directory).some((name) => name.endsWith(".tmp")), false);
});

test("a deferred new-session path persists before its JSONL exists", (t) => {
	const { stateRoot, sessionPath } = fixture(t);
	const deferredPath = sessionPath("deferred");
	assert.equal(existsSync(deferredPath), false);
	new DurablePromptTabsStore("deferred-id", deferredPath, stateRoot).save({ texts: ["first-session draft", ""], activeIndex: 1 });

	assert.deepEqual(
		new DurablePromptTabsStore("deferred-id", deferredPath, stateRoot).load().snapshot,
		{ texts: ["first-session draft", ""], activeIndex: 1 },
	);
});

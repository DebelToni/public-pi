import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import sessionRecency from "./index.ts";

test("bubbling descendant recency preserves each session's own activity time", async () => {
	const manager = SessionManager as any;
	const originalList = manager.list;
	const originalListAll = manager.listAll;
	const originalMarker = manager.__piCustomSessionRecency;
	type TestSession = { path: string; parentSessionPath?: string; modified: Date; __piOwnModified?: Date };
	const parent: TestSession = { path: "/tmp/parent.jsonl", modified: new Date(1_000) };
	const child: TestSession = { path: "/tmp/child.jsonl", parentSessionPath: parent.path, modified: new Date(2_000) };
	try {
		delete manager.__piCustomSessionRecency;
		manager.list = async () => [parent, child];
		manager.listAll = async () => [parent, child];
		sessionRecency();

		const sessions = await manager.list();
		assert.equal(sessions[0].modified.getTime(), 2_000);
		assert.equal(sessions[0].__piOwnModified?.getTime(), 1_000);
		assert.equal(sessions[1].__piOwnModified?.getTime(), 2_000);
	} finally {
		manager.list = originalList;
		manager.listAll = originalListAll;
		if (originalMarker === undefined) delete manager.__piCustomSessionRecency;
		else manager.__piCustomSessionRecency = originalMarker;
	}
});


test("bubbling does not reorder a child-first native list when parent and child become equal", async () => {
	const manager = SessionManager as any;
	const originalList = manager.list;
	const originalListAll = manager.listAll;
	const originalMarker = manager.__piCustomSessionRecency;
	const parent = { path: "/tmp/order-parent.jsonl", modified: new Date(1_000) };
	const child = { path: "/tmp/order-child.jsonl", parentSessionPath: parent.path, modified: new Date(2_000) };
	try {
		delete manager.__piCustomSessionRecency;
		manager.list = async () => [child, parent];
		manager.listAll = async () => [child, parent];
		sessionRecency();
		const sessions = await manager.list();
		assert.deepEqual(sessions.map((session: any) => session.path), [child.path, parent.path]);
		assert.equal(sessions[0].modified.getTime(), sessions[1].modified.getTime());
	} finally {
		manager.list = originalList;
		manager.listAll = originalListAll;
		if (originalMarker === undefined) delete manager.__piCustomSessionRecency;
		else manager.__piCustomSessionRecency = originalMarker;
	}
});

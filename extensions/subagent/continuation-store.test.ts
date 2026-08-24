import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	acquireContinuationLease,
	CONTINUATION_MANIFEST_VERSION,
	listContinuationManifests,
	readContinuationManifest,
	removeContinuation,
	writeContinuationManifest,
	type ContinuationManifest,
} from "./continuation-store.ts";

test("continuation manifests use private permissions and atomic same-directory replacement", () => {
	const temporary = mkdtempSync(path.join(os.tmpdir(), "pi-continuation-store-"));
	const root = path.join(temporary, "runs");
	try {
		let manifest: ContinuationManifest<{ task: string }, { value: number }> = {
			version: CONTINUATION_MANIFEST_VERSION,
			id: "call/unsafe-id",
			parentSessionId: "session-1",
			parentSessionFile: "/tmp/session.jsonl",
			parentBranchAnchor: "entry-1",
			parentToolCallId: "call/unsafe-id",
			mode: "single",
			args: { task: "work" },
			details: { value: 1 },
			status: "pending",
			createdAt: 1,
			updatedAt: 1,
		};
		const first = writeContinuationManifest(manifest, root);
		assert.equal(statSync(root).mode & 0o777, 0o700);
		assert.equal(statSync(first.dir).mode & 0o777, 0o700);
		assert.equal(statSync(first.filePath).mode & 0o777, 0o600);
		assert.equal(path.dirname(first.dir), root);
		assert.equal(path.basename(first.dir).includes("/"), false);

		for (let value = 2; value <= 50; value++) {
			manifest = { ...manifest, details: { value }, updatedAt: value };
			writeContinuationManifest(manifest, root);
			assert.equal(readContinuationManifest<typeof manifest.args, typeof manifest.details>(manifest.id, root)?.details.value, value);
			assert.deepEqual(readdirSync(first.dir), ["manifest.json"]);
		}
		const release = acquireContinuationLease(manifest.id, manifest.parentSessionId, root);
		assert.throws(() => acquireContinuationLease(manifest.id, manifest.parentSessionId, root), /already running/);
		release();
		acquireContinuationLease(manifest.id, manifest.parentSessionId, root)();

		const secondManifest = { ...manifest, parentSessionId: "session-2", details: { value: 99 }, updatedAt: 99 };
		const second = writeContinuationManifest(secondManifest, root);
		assert.notEqual(second.dir, first.dir);
		assert.equal(listContinuationManifests(root).length, 2);
		assert.equal(readContinuationManifest<typeof manifest.args, typeof manifest.details>(manifest.id, root, "session-1")?.details.value, 50);
		assert.equal(readContinuationManifest<typeof manifest.args, typeof manifest.details>(manifest.id, root, "session-2")?.details.value, 99);
		removeContinuation(manifest.id, manifest.parentSessionId, root);
		removeContinuation(secondManifest.id, secondManifest.parentSessionId, root);
		assert.equal(existsSync(first.dir), false);
		assert.equal(existsSync(second.dir), false);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

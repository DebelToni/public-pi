import assert from "node:assert/strict";
import test from "node:test";
import { QueuedDraftTracker } from "./queue-tracker.ts";

test("recall follows Pi's steering-then-follow-up queue order", () => {
	const tracker = new QueuedDraftTracker();
	tracker.track("follow one", "followUp");
	tracker.track("steer one", "steer");
	tracker.track("follow two", "followUp");
	assert.deepEqual(
		tracker.recall("steer one\n\nfollow one\n\nfollow two"),
		["steer one", "follow one", "follow two"],
	);
	assert.equal(tracker.size, 0);
});

test("delivered messages are removed before recall", () => {
	const tracker = new QueuedDraftTracker();
	tracker.track("first", "followUp");
	tracker.track("second", "followUp");
	tracker.consume("first");
	assert.deepEqual(tracker.recall("second"), ["second"]);
});

test("expanded skills and templates restore as their original separate drafts", () => {
	const tracker = new QueuedDraftTracker();
	tracker.track("/template one", "followUp");
	tracker.track("/skill:two", "followUp");
	assert.deepEqual(tracker.recall("expanded one\n\nexpanded two"), ["/template one", "/skill:two"]);
});

test("expanded delivered text consumes the next queued draft by queue order", () => {
	const tracker = new QueuedDraftTracker();
	tracker.track("/template one", "followUp");
	tracker.track("plain second", "followUp");
	tracker.consume("expanded template content");
	assert.deepEqual(tracker.recall("plain second"), ["plain second"]);
});

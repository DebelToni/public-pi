import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import btwExtension, {
	BtwOverlay,
	parentCompletionProblem,
	sideThreadModeForStopReason,
	streamEventForLog,
	waitForCompletedParent,
} from "./index.ts";

test("/status passes the exact status question to /btw", async () => {
	type Command = {
		description?: string;
		handler: (args: string, ctx: unknown) => unknown;
	};
	const commands = new Map<string, Command>();
	btwExtension({
		on() {},
		registerCommand(name: string, command: Command) { commands.set(name, command); },
	} as unknown as ExtensionAPI);

	const btw = commands.get("btw");
	const status = commands.get("status");
	assert.ok(btw);
	assert.ok(status);
	let received: { args: string; ctx: unknown } | undefined;
	btw.handler = (args, ctx) => { received = { args, ctx }; };
	const context = { marker: true };
	await status.handler("ignored arguments", context);
	assert.deepEqual(received, { args: "status and eta?", ctx: context });
});

test("wait-for-ready ignores early stream deltas until parent completion", async () => {
	const capsule: { completedAt?: number; stopReason?: string } = { stopReason: "pending" };
	let delayCalls = 0;
	const result = await waitForCompletedParent(capsule, () => capsule, new AbortController().signal, {
		now: () => 100,
		delay: async () => {
			delayCalls++;
			capsule.completedAt = 101;
			capsule.stopReason = "stop";
			return true;
		},
	});
	assert.equal(delayCalls, 1);
	assert.equal(result, capsule);
});

test("failed parent completion is returned promptly instead of hanging", async () => {
	const capsule = { completedAt: 101, stopReason: "error" };
	const result = await waitForCompletedParent(capsule, () => capsule, new AbortController().signal, {
		now: () => 101,
		delay: async () => { throw new Error("completion should not poll"); },
	});
	assert.equal(result?.stopReason, "error");
});

test("completed parent tool use is accepted only for a prefix-only fork", () => {
	assert.equal(sideThreadModeForStopReason("toolUse"), "parallel-prefix-fork");
	assert.equal(parentCompletionProblem("parallel-prefix-fork", { stopReason: "toolUse" }), undefined);
	assert.match(
		parentCompletionProblem("completed-continuation", { stopReason: "toolUse", responseId: "response" }) ?? "",
		/no clean stop/,
	);
});

test("completed continuation requires a clean stop and response id", () => {
	assert.equal(sideThreadModeForStopReason("stop"), "completed-continuation");
	assert.equal(parentCompletionProblem("completed-continuation", { stopReason: "stop", responseId: "response" }), undefined);
	assert.match(parentCompletionProblem("completed-continuation", { stopReason: "stop" }) ?? "", /continuation id/);
});

const usage = {
	input: 100,
	output: 10,
	cacheRead: 90,
	cacheWrite: 0,
	cost: { total: 0 },
};

function overlayHarness(copyText?: (text: string) => Promise<void>) {
	let renders = 0;
	let closes = 0;
	const followUps: string[] = [];
	const copied: string[] = [];
	const tui = {
		terminal: { rows: 40 },
		requestRender() { renders++; },
	} as unknown as TUI;
	const theme = {
		fg: (_color: string, text: string) => text,
	} as unknown as Theme;
	const copy = copyText ?? (async (text: string) => { copied.push(text); });
	const overlay = new BtwOverlay(
		tui,
		theme,
		"initial",
		() => { closes++; },
		(question) => followUps.push(question),
		copy,
	);
	return { overlay, followUps, copied, get renders() { return renders; }, get closes() { return closes; } };
}

test("completed /btw answers accept sequential follow-ups in the same overlay", () => {
	const harness = overlayHarness();
	const { overlay, followUps } = harness;
	overlay.focused = true;
	overlay.enableFollowUps();
	overlay.setAnswer("first answer");
	overlay.setDone(usage, false);

	for (const char of "first follow-up") overlay.handleInput(char);
	overlay.handleInput("\r");
	assert.deepEqual(followUps, ["first follow-up"]);
	assert.equal(overlay.turnCount, 2);
	assert.equal(overlay.isLoading, true);

	for (const char of "ignored while loading") overlay.handleInput(char);
	overlay.setAnswer("second answer");
	overlay.setDone(usage, false);
	for (const char of "second follow-up") overlay.handleInput(char);
	overlay.handleInput("\r");
	assert.deepEqual(followUps, ["first follow-up", "second follow-up"]);
	assert.equal(overlay.turnCount, 3);
	assert.ok(harness.renders > 0);
});

test("completed overlay renders a focused follow-up input within its width", () => {
	const harness = overlayHarness();
	harness.overlay.focused = true;
	harness.overlay.enableFollowUps();
	harness.overlay.setDone(usage, false);
	const lines = harness.overlay.render(60);
	assert.ok(lines.every((line) => visibleWidth(line) <= 60));
	assert.match(lines.join("\n"), /Enter sends follow-up/);
	assert.match(lines.join("\n"), /Ctrl\+X copies all/);
});

test("cache miss stays visible as a warning while follow-ups remain enabled", () => {
	const harness = overlayHarness();
	harness.overlay.focused = true;
	harness.overlay.enableFollowUps();
	harness.overlay.setDone({ ...usage, cacheRead: 0 }, "The provider reported a parent cache miss.");
	for (const char of "follow up") harness.overlay.handleInput(char);
	harness.overlay.handleInput("\r");
	assert.deepEqual(harness.followUps, ["follow up"]);
	const rendered = harness.overlay.render(100).join("\n");
	assert.match(rendered, /cache MISS/);
	assert.doesNotMatch(rendered, /Side thread stopped/);
});

test("poor cache coverage stays visible as a warning while follow-ups remain enabled", () => {
	const harness = overlayHarness();
	harness.overlay.focused = true;
	harness.overlay.enableFollowUps();
	harness.overlay.setDone({ ...usage, cacheRead: 899 }, "poor parent cache coverage: 89.90%");
	harness.overlay.handleInput("follow up");
	harness.overlay.handleInput("\r");
	assert.deepEqual(harness.followUps, ["follow up"]);
	const rendered = harness.overlay.render(120).join("\n");
	assert.match(rendered, /poor parent cache coverage: 89\.90%/);
	assert.doesNotMatch(rendered, /Side thread stopped/);
});

test("ctrl+x copies the whole multi-turn side conversation without closing it", async () => {
	const harness = overlayHarness();
	const { overlay, followUps, copied } = harness;
	overlay.focused = true;
	overlay.enableFollowUps();
	overlay.setAnswer("first answer");
	overlay.setDone(usage, false);
	for (const char of "second question") overlay.handleInput(char);
	overlay.handleInput("\r");
	assert.deepEqual(followUps, ["second question"]);
	overlay.setAnswer("second answer\nwith another line");
	overlay.setDone(usage, false);

	overlay.handleInput("\x18");
	await new Promise((resolve) => setImmediate(resolve));

	assert.deepEqual(copied, [
		"Q1:\ninitial\n\nA1:\nfirst answer\n\n---\n\n" +
		"Q2:\nsecond question\n\nA2:\nsecond answer\nwith another line",
	]);
	assert.equal(overlay.isClosed, false);
	assert.match(overlay.render(100).join("\n"), /Copied whole conversation to clipboard \+ OSC 52/);
});

test("ctrl+x can copy the current partial response while streaming", async () => {
	const harness = overlayHarness();
	harness.overlay.appendText("partial answer");
	harness.overlay.handleInput("\x18");
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(harness.copied, [
		"Q1:\ninitial\n\nA1:\npartial answer\n\n[response still streaming]",
	]);
});

test("option arrows scroll the /btw transcript without recalling queued messages", () => {
	const harness = overlayHarness();
	harness.overlay.focused = true;
	harness.overlay.enableFollowUps();
	harness.overlay.setDone(usage, false);
	for (let index = 0; index < 12; index++) {
		for (const char of `follow up ${index}`) harness.overlay.handleInput(char);
		harness.overlay.handleInput("\r");
		harness.overlay.setDone(usage, false);
	}
	const bottom = harness.overlay.render(60).find((line) => /\d+-\d+ \/ \d+ lines/.test(line));
	harness.overlay.handleInput("\x1bp");
	const above = harness.overlay.render(60).find((line) => /\d+-\d+ \/ \d+ lines/.test(line));
	assert.ok(bottom);
	assert.ok(above);
	assert.notEqual(above, bottom);
	assert.equal(harness.followUps.length, 12);
	assert.match(harness.overlay.render(60).join("\n"), /Option\+↑\/↓ scroll/);

	harness.overlay.handleInput("\x1bn");
	const returned = harness.overlay.render(60).find((line) => /\d+-\d+ \/ \d+ lines/.test(line));
	assert.equal(returned, bottom);
	assert.equal(harness.followUps.length, 12);
});

test("streaming preserves a user-selected transcript position", () => {
	const harness = overlayHarness();
	harness.overlay.focused = true;
	harness.overlay.enableFollowUps();
	harness.overlay.setDone(usage, false);
	for (let index = 0; index < 12; index++) {
		harness.overlay.handleInput(`follow up ${index}`);
		harness.overlay.handleInput("\r");
		harness.overlay.setDone(usage, false);
	}
	harness.overlay.render(60);
	harness.overlay.handleInput("\x1b[5~");
	const before = harness.overlay.render(60).find((line) => /\d+-\d+ \/ \d+ lines/.test(line));
	harness.overlay.appendText("late delta");
	const after = harness.overlay.render(60).find((line) => /\d+-\d+ \/ \d+ lines/.test(line));
	assert.ok(before);
	assert.equal(after, before);
});

test("final result replaces an inconsistent streamed transcript", () => {
	const harness = overlayHarness();
	harness.overlay.appendText("draft text");
	harness.overlay.setAnswer("final text");
	harness.overlay.setDone(usage, false);
	const output = harness.overlay.render(60).join("\n");
	assert.match(output, /final text/);
	assert.doesNotMatch(output, /draft text/);
});

test("stream logs omit cumulative partial copies while preserving deltas", () => {
	const event = {
		type: "text_delta" as const,
		contentIndex: 0,
		delta: "new text",
		partial: { role: "assistant" as const, content: [{ type: "text" as const, text: "old new text" }] },
	};
	assert.deepEqual(streamEventForLog(event as unknown as Parameters<typeof streamEventForLog>[0]), {
		type: "text_delta",
		contentIndex: 0,
		delta: "new text",
	});
});

test("blocked tool attempts retain their partial tool-call data in logs", () => {
	const toolCall = { type: "toolCall" as const, id: "call-1", name: "bash", arguments: { command: "echo no" } };
	const event = {
		type: "toolcall_start" as const,
		contentIndex: 0,
		partial: { role: "assistant" as const, content: [toolCall] },
	};
	assert.deepEqual(streamEventForLog(event as unknown as Parameters<typeof streamEventForLog>[0]), {
		type: "toolcall_start",
		contentIndex: 0,
		partialContent: toolCall,
	});
});

test("escape closes the whole side thread", () => {
	const harness = overlayHarness();
	harness.overlay.handleInput("\x1b");
	assert.equal(harness.overlay.isClosed, true);
	assert.equal(harness.overlay.signal.aborted, true);
	assert.equal(harness.closes, 1);
});

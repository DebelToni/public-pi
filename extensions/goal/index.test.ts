import assert from "node:assert/strict";
import test from "node:test";
import goalExtension, { formatGoalStatus, latestAssistantSegment } from "./index.ts";

test("goal status puts the run count and one human-readable timestamp per line under the armed goal", () => {
	const timestamps = [Date.UTC(2026, 6, 14, 12, 34, 56), Date.UTC(2026, 6, 15, 1, 2, 3)];
	const lines = formatGoalStatus("ship it", timestamps).split("\n");

	assert.deepEqual(lines.slice(0, 2), ["Goal armed: ship it", "Runs: 2"]);
	assert.equal(lines.length, 4);
	assert.equal(lines[2], `1. ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(timestamps[0])}`);
	assert.equal(lines[3], `2. ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(timestamps[1])}`);
});

test("goal evaluation is skipped when the latest real message is from the user", () => {
	const ctx = {
		sessionManager: {
			getBranch: () => [
				{ type: "message", id: "assistant-1", message: { role: "assistant", content: [] } },
				{ type: "message", id: "user-1", message: { role: "user", content: [] } },
				{ type: "custom", customType: "unrelated-state", data: {} },
			],
		},
	} as any;

	assert.equal(latestAssistantSegment(ctx), undefined);
});

test("arming a goal records and persists its first run for /goal status", async () => {
	const commands = new Map<string, any>();
	const handlers = new Map<string, any[]>();
	const entries: Array<{ customType: string; data: any }> = [];
	const sent: string[] = [];
	const notifications: string[] = [];
	const pi = {
		on(event: string, handler: any) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
		registerCommand(name: string, command: any) { commands.set(name, command); },
		appendEntry(customType: string, data: any) { entries.push({ customType, data }); },
		sendUserMessage(message: string) { sent.push(message); },
	} as any;
	goalExtension(pi);
	const ctx = {
		isIdle: () => true,
		sessionManager: { getBranch: () => [] },
		ui: { notify(message: string) { notifications.push(message); } },
	} as any;

	await handlers.get("session_start")![0]({}, ctx);
	await commands.get("goal").handler("ship it", ctx);
	await commands.get("goal").handler("status", ctx);

	assert.equal(sent.length, 1);
	assert.equal(entries.at(-1)?.customType, "pi-goal-state");
	assert.equal(entries.at(-1)?.data.runTimestamps.length, 1);
	assert.equal(typeof entries.at(-1)?.data.runTimestamps[0], "number");
	const statusLines = notifications.at(-1)!.split("\n");
	assert.deepEqual(statusLines.slice(0, 2), ["Goal armed: ship it", "Runs: 1"]);
	assert.equal(statusLines.length, 3);
	assert.match(statusLines[2], /^1\. .+/);
});

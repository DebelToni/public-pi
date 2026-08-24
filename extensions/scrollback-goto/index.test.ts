import assert from "node:assert/strict";
import test from "node:test";
import { materializeBranch } from "./index.ts";

test("materializeBranch preserves full native entries and adds only jump markers", () => {
	const entries = [
		{
			type: "message",
			id: "old-user",
			message: { role: "user", content: [{ type: "text", text: "old prompt before compaction" }] },
		},
		{
			type: "message",
			id: "old-assistant",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "private **reasoning**" },
					{ type: "text", text: "# Old answer\n\nMarkdown body" },
					{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "printf 'one\\ntwo'\nprintf done" } },
				],
			},
		},
		{ type: "compaction", id: "compact-1", summary: "summary checkpoint", tokensBefore: 123 },
		{
			type: "custom_message",
			id: "hidden-reminder",
			customType: "hidden",
			content: "must stay hidden",
			display: false,
		},
		{
			type: "custom",
			id: "old-materialization",
			customType: "scrollback-goto-full-branch",
			data: { token: "obsolete" },
		},
		{
			type: "message",
			id: "new-user",
			message: { role: "user", content: [{ type: "text", text: "new prompt after compaction" }] },
		},
		{
			type: "message",
			id: "tool-result",
			message: {
				role: "toolResult",
				toolName: "bash",
				toolCallId: "call-1",
				content: [{ type: "text", text: "complete tool output" }],
			},
		},
	];

	const snapshot = materializeBranch(entries, "deadbeef");
	assert.equal(snapshot.entryCount, entries.length);
	assert.equal(snapshot.userMessageCount, 2);
	assert.equal(snapshot.endMarker, "GOTOEND:deadbeef");
	assert.equal(snapshot.entries.includes(entries[1]), true);
	assert.equal(snapshot.entries.includes(entries[2]), true);
	assert.equal(snapshot.entries.includes(entries[3]), true);
	assert.equal(snapshot.entries.includes(entries[4]), false);

	const markers = snapshot.entries
		.filter((entry) => entry.customType === "scrollback-goto-marker")
		.map((entry) => entry.data.text);
	assert.deepEqual(markers, [
		"GOTOSTART:deadbeef",
		"USER #1 · old-user",
		"USER #2 · new-user",
		"GOTOEND:deadbeef",
	]);
	assert.ok(snapshot.entries.indexOf(entries[1]) < snapshot.entries.indexOf(entries[2]));
	assert.ok(snapshot.entries.indexOf(entries[2]) < snapshot.entries.indexOf(entries[5]));
	assert.deepEqual((entries[1] as any).message.content[2].arguments, {
		command: "printf 'one\\ntwo'\nprintf done",
	});
});

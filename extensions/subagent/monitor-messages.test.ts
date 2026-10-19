import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { AssistantMessageComponent, UserMessageComponent, ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { MonitorMessageRenderer, monitorToolRenderers, LOCAL_TRANSCRIPT_VISIBILITY } from "./monitor-messages.ts";
import { SubagentMonitorStore } from "./monitor.ts";

initTheme("dark", false);

function fixture() {
	const store = new SubagentMonitorStore();
	const id = store.queueRun({ orchestrationId: "call", sessionId: "session", kind: "one-off", mode: "single", agent: "general", task: "Delegated prompt", cwd: "/nonexistent-monitor-cwd" });
	return { store, id, run: store.getRun(id)! };
}

const text = (lines: string[]) => stripVTControlCharacters(lines.join("\n"));

test("history reuses public native Pi message classes and removes prompt-zone escapes", () => {
	const { store, id, run } = fixture();
	store.observeJsonEvent(id, { type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "Visible thought" }, { type: "text", text: "A **note**" }] } });
	const renderer = new MonitorMessageRenderer();
	for (const entry of run.transcript) {
		const rows = renderer.render(entry, run, 60, false, false);
		assert.ok(rows.every((line) => !line.includes("\x1b]133;")));
	}
	const cache = (renderer as any).cache as Map<number, any>;
	assert.ok(cache.get(run.transcript[0]!.id).component instanceof UserMessageComponent);
	assert.ok(cache.get(run.transcript[1]!.id).component instanceof AssistantMessageComponent);
	assert.ok(cache.get(run.transcript[2]!.id).component instanceof AssistantMessageComponent);
	assert.ok([...cache.values()].every((entry) => entry.component[LOCAL_TRANSCRIPT_VISIBILITY]));
	renderer.clear();
	assert.equal(cache.size, 0);
});

test("native tool rendering has no executable methods, live clocks, or edit filesystem previews", () => {
	const { store, id, run } = fixture();
	store.observeJsonEvent(id, { type: "tool_execution_start", toolCallId: "edit", toolName: "edit", args: { path: "missing.ts", edits: [{ oldText: "OLD_ARGUMENT_SENTINEL", newText: "NEW_ARGUMENT_SENTINEL" }] } });
	store.observeJsonEvent(id, { type: "tool_execution_start", toolCallId: "bash", toolName: "bash", args: { command: "sleep 100" } });
	store.observeJsonEvent(id, { type: "tool_execution_update", toolCallId: "bash", toolName: "bash", partialResult: { content: [{ type: "text", text: "LIVE_PARTIAL" }] } });
	const renderer = new MonitorMessageRenderer();
	const cache = (renderer as any).cache as Map<number, any>;
	for (const entry of run.transcript.filter((entry) => entry.type === "tool")) {
		const rows = renderer.render(entry, run, 70, true, false);
		const component = cache.get(entry.id).component;
		assert.ok(component instanceof ToolExecutionComponent);
		const tool = run.tools.find((tool) => tool.id === entry.toolId)!;
		assert.equal("execute" in monitorToolRenderers(tool, run.cwd!), false);
		assert.equal((component as any).rendererState.interval, undefined);
		assert.equal((component as any).rendererState.startedAt, undefined);
		if (tool.name === "edit") {
			assert.match(text(rows), /OLD_ARGUMENT_SENTINEL/);
			assert.match(text(rows), /NEW_ARGUMENT_SENTINEL/);
			const preview = (component as any).rendererState.callComponent;
			assert.equal(preview?.previewPending, false);
			assert.equal(preview?.preview, undefined);
			component.invalidate();
			assert.equal(preview?.previewPending, false);
		} else assert.match(text(rows), /LIVE_PARTIAL/);
	}
	store.observeJsonEvent(id, { type: "tool_execution_end", toolCallId: "edit", toolName: "edit", result: { content: [{ type: "text", text: "Edit failed: no match" }] }, isError: true });
	const edit = run.transcript.find((entry) => entry.type === "tool" && entry.toolId === "edit")!;
	const failed = text(renderer.render(edit, run, 70, true, false));
	assert.match(failed, /Edit failed: no match/);
	assert.match(failed, /OLD_ARGUMENT_SENTINEL/);
	assert.match(failed, /NEW_ARGUMENT_SENTINEL/);
	store.observeJsonEvent(id, { type: "tool_execution_end", toolCallId: "edit", toolName: "edit", result: { content: [{ type: "text", text: "updated" }], details: { diff: "-1 before\n+1 after" } }, isError: false });
	assert.match(text(renderer.render(edit, run, 70, true, false)), /before/);
	assert.match(text(renderer.render(edit, run, 70, true, false)), /after/);
});

test("unknown child tools render full arguments and expand textual results without parent registration", () => {
	const { store, id, run } = fixture();
	store.observeJsonEvent(id, { type: "tool_execution_start", toolCallId: "remote", toolName: "remote.custom_tool", args: { nested: { value: "ARGUMENT_TAIL" } } });
	store.observeJsonEvent(id, { type: "tool_execution_end", toolCallId: "remote", toolName: "remote.custom_tool", result: { content: [{ type: "text", text: Array.from({ length: 40 }, (_, index) => `ROW_${index}`).join("\n") }, { type: "image", data: "IMAGE_BYTES", mimeType: "image/jpeg" }] }, isError: false });
	const renderer = new MonitorMessageRenderer();
	const entry = run.transcript.find((entry) => entry.type === "tool")!;
	assert.match(text(renderer.render(entry, run, 45, false, false)), /ARGUMENT_TAIL/);
	assert.doesNotMatch(text(renderer.render(entry, run, 45, false, false)), /ROW_39/);
	const full = text(renderer.render(entry, run, 45, true, false));
	assert.match(full, /ROW_39/);
	assert.match(full, /image omitted/);
	assert.doesNotMatch(full, /IMAGE_BYTES/);
});

test("native user message rendering clearly labels creation instructions and numbered tasks", () => {
	const store = new SubagentMonitorStore();
	const id = store.queueRun({
		orchestrationId: "labels", sessionId: "session", kind: "named", mode: "single", agent: "worker",
		task: "follow up", creationInstructions: "Use the private template body.", tasks: ["start here", "follow up"],
	});
	const run = store.getRun(id)!;
	const renderer = new MonitorMessageRenderer();
	const rendered = run.transcript.map((entry) => text(renderer.render(entry, run, 72, false, false))).join("\n");
	assert.match(rendered, /Creation instructions[\s\S]*Use the private template body\./);
	assert.match(rendered, /Initial task[\s\S]*start here/);
	assert.match(rendered, /Follow-up task 1[\s\S]*follow up/);
	const cache = (renderer as any).cache as Map<number, any>;
	assert.ok([...cache.values()].every((entry) => entry.component instanceof UserMessageComponent));
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { runSingleAgent } from "./index.ts";
import {
	formatMonitorDuration,
	formatMonitorStatus,
	installSubagentMonitorUI,
	renderNamedInvokeResult,
	renderSubagentResult,
	SubagentMonitorComponent,
} from "./monitor-ui.ts";
import { SubagentMonitorStore } from "./monitor.ts";

initTheme("dark", false);
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const plain = (lines: string[]) => stripVTControlCharacters(lines.join("\n"));

function allPages(component: SubagentMonitorComponent, width: number) {
	component.handleInput("\x1b[H");
	let text = "";
	for (let page = 0; page < 200; page++) {
		text += `\n${plain(component.render(width))}`;
		const view = (component as any).views.get((component as any).selectedRunId);
		if (view.atEnd) break;
		component.handleInput("\x1b[6~");
	}
	return text;
}

function queue(store: SubagentMonitorStore, agent: string, slot = 0) {
	return store.queueRun({
		orchestrationId: "orchestration",
		sessionId: "session",
		kind: "one-off",
		mode: "parallel",
		agent,
		task: `inspect ${agent}`,
		slot,
	});
}

function theme() {
	return {
		fg(_color: string, text: string) { return text; },
		bg(_color: string, text: string) { return text; },
		bold(text: string) { return text; },
	} as any;
}

test("monitor reducer tracks live work and removes terminal runs", () => {
	let now = 1_000;
	const store = new SubagentMonitorStore(() => now);
	const first = queue(store, "domain", 0);
	const second = queue(store, "frontend", 1);
	assert.deepEqual(store.getSummary("session"), { total: 2, queued: 2, active: 0 });

	now = 1_100;
	store.markStarting(first);
	store.markSpawned(first, 42);
	store.observeJsonEvent(first, { type: "agent_start" });
	store.observeJsonEvent(first, { type: "turn_start" });
	store.observeJsonEvent(first, {
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", delta: "Pi-visible thinking summary" },
	});
	now = 1_250;
	store.observeJsonEvent(first, {
		type: "tool_execution_start",
		toolCallId: "tool-1",
		toolName: "bash",
		args: { command: "pnpm test" },
	});
	assert.equal(store.getRun(first)?.currentLabel, "tool bash · pnpm test");
	assert.ok(store.getRun(first)?.transcript.some((entry) => entry.type === "thinking" && entry.text === "Pi-visible thinking summary"));

	now = 1_300;
	store.observeJsonEvent(first, {
		type: "tool_execution_start",
		toolCallId: "tool-2",
		toolName: "read",
		args: { path: "README.md" },
	});
	now = 1_500;
	store.observeJsonEvent(first, {
		type: "tool_execution_end",
		toolCallId: "tool-1",
		toolName: "bash",
		isError: false,
	});
	assert.equal(store.getRun(first)?.currentLabel, "tool read");
	now = 2_500;
	store.observeJsonEvent(first, {
		type: "tool_execution_end",
		toolCallId: "tool-2",
		toolName: "read",
		isError: false,
	});
	const run = store.getRun(first)!;
	assert.equal(run.tools[0]?.endedAt! - run.tools[0]?.startedAt!, 250);
	assert.equal(run.tools[1]?.endedAt! - run.tools[1]?.startedAt!, 1_200);
	assert.ok(run.activities.some((activity) => activity.label.includes("bash · pnpm test") && activity.durationMs === 250));
	store.finishFromResult(first, { exitCode: 0, status: "completed", model: "gpt-6-luna" });
	store.finishRun(second, "interrupted", "not started");
	assert.equal(store.getRun(first), undefined);
	assert.deepEqual(store.getSummary("session"), { total: 0, queued: 0, active: 0 });
});

test("monitor history and tool spans remain bounded", () => {
	let now = 0;
	const store = new SubagentMonitorStore(() => ++now);
	const runId = queue(store, "bounded");
	store.markStarting(runId);
	for (let index = 0; index < 150; index++) store.observeJsonEvent(runId, { type: "turn_start" });
	for (let index = 0; index < 100; index++) {
		store.observeJsonEvent(runId, { type: "tool_execution_start", toolCallId: `tool-${index}`, toolName: "read", args: { path: `${index}.txt` } });
		store.observeJsonEvent(runId, { type: "tool_execution_end", toolCallId: `tool-${index}`, toolName: "read", isError: false });
	}
	assert.equal(store.getRun(runId)?.activities.length, 120);
	assert.equal(store.getRun(runId)?.tools.length, 80);
});

test("native component cache drops evicted tools and finished runs", () => {
	const store = new SubagentMonitorStore();
	const first = queue(store, "first");
	const second = queue(store, "second", 1);
	store.markStarting(first);
	store.markStarting(second);
	const component = new SubagentMonitorComponent(
		store,
		"session",
		{ terminal: { rows: 20 }, requestRender() {} } as any,
		theme(),
		() => {},
	);
	component.handleInput("\x0f");
	for (let index = 0; index < 100; index++) {
		store.observeJsonEvent(first, { type: "tool_execution_start", toolCallId: `tool-${index}`, toolName: "bash", args: { command: `echo ${index}` } });
		store.observeJsonEvent(first, { type: "tool_execution_end", toolCallId: `tool-${index}`, toolName: "bash", isError: false, result: { content: [{ type: "text", text: `output ${index}` }] } });
		component.render(70);
	}
	const cache = (component as any).messages.cache as Map<number, unknown>;
	const liveIds = new Set(store.getRun(first)!.transcript.map((entry) => entry.id));
	assert.ok([...cache.keys()].every((id) => liveIds.has(id)));
	store.finishRun(first, "completed");
	component.render(70);
	assert.ok([...cache.keys()].every((id) => !liveIds.has(id)));
	assert.equal((component as any).views.has(first), false);
	component.dispose();
});

test("full-screen monitor is width-safe, navigable, and throttles streaming redraws", async () => {
	const store = new SubagentMonitorStore();
	const first = queue(store, "domain", 0);
	const second = queue(store, "frontend", 1);
	store.markStarting(first);
	let renders = 0;
	let closed = 0;
	const tui = {
		terminal: { rows: 22 },
		requestRender() { renders++; },
	} as any;
	const component = new SubagentMonitorComponent(store, "session", tui, theme(), () => { closed++; });
	const initial = component.render(80);
	assert.equal(initial.length, 22);
	assert.ok(initial.every((line) => visibleWidth(line) <= 80));
	assert.match(plain(initial), /\[● 1:domain\]/);

	component.handleInput("\x1b[C");
	const moved = component.render(80);
	assert.match(plain(moved), /\[○ 2:frontend\]/);
	store.finishRun(second, "completed");
	assert.ok(component.render(80).every((line) => !line.includes("frontend")));
	renders = 0;

	const cached = component.render(80);
	for (let index = 0; index < 30; index++) {
		store.observeJsonEvent(first, {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: String(index % 10) },
		});
	}
	assert.equal(renders, 0);
	assert.equal(component.render(80), cached, "token events should keep the cached frame until the throttle fires");
	await wait(250);
	assert.equal(renders, 1);
	(tui.terminal as any).rows = 4;
	component.invalidate();
	const tiny = component.render(12);
	assert.equal(tiny.length, 4);
	assert.ok(tiny.every((line) => visibleWidth(line) <= 12));

	component.handleInput("q");
	assert.equal(closed, 1);
	component.dispose();
});

test("working subagents retain insertion order as their activity changes", () => {
	const store = new SubagentMonitorStore();
	const first = store.queueRun({ orchestrationId: "first-call", sessionId: "session", kind: "one-off", mode: "single", agent: "first", task: "first" });
	const second = store.queueRun({ orchestrationId: "second-call", sessionId: "session", kind: "one-off", mode: "single", agent: "second", task: "second" });
	store.markStarting(first);
	store.markStarting(second);
	const component = new SubagentMonitorComponent(
		store,
		"session",
		{ terminal: { rows: 18 }, requestRender() {} } as any,
		theme(),
		() => {},
	);
	const ordered = () => {
		const tabs = plain(component.render(80)).split("\n")[0]!;
		return [tabs.indexOf("1:first"), tabs.indexOf("2:second")];
	};
	const before = ordered();
	store.observeJsonEvent(first, { type: "tool_execution_start", toolCallId: "tool", toolName: "bash", args: { command: "sleep 1" } });
	const after = ordered();
	assert.ok(before[0] < before[1]);
	assert.ok(after[0] < after[1]);
	component.dispose();
});

test("short overlays stay compact with several current runs", () => {
	let now = Date.now();
	const store = new SubagentMonitorStore(() => ++now);
	const selected = queue(store, "selected", 0);
	queue(store, "second", 1);
	queue(store, "third", 2);
	queue(store, "fourth", 3);
	store.markStarting(selected);
	for (let index = 0; index < 12; index++) store.observeJsonEvent(selected, { type: "turn_start" });
	const component = new SubagentMonitorComponent(
		store,
		"session",
		{ terminal: { rows: 14 }, requestRender() {} } as any,
		theme(),
		() => {},
	);
	const lines = component.render(80);
	assert.equal(lines.length, 14);
	assert.ok(lines.some((line) => line.includes("selected")));
	assert.doesNotMatch(plain(lines), /Ctrl\+O|Home\/End|q\/Esc|Timeline|[╭╮╰╯│├┤─]/);
	const view = (component as any).views.get(selected);
	assert.equal(view.pageSize, 12, "only tabs and metadata should occupy short-screen rows");
	assert.equal(view.width, 80, "history should use the full terminal width");
	component.dispose();
});

test("selected runs always expose the active or most recent command", () => {
	let now = Date.now();
	const store = new SubagentMonitorStore(() => ++now);
	const runId = queue(store, "command-agent");
	store.markStarting(runId);
	store.observeJsonEvent(runId, { type: "tool_execution_start", toolCallId: "bash-1", toolName: "bash", args: { command: "sleep 30" } });
	const tui = { terminal: { rows: 14 }, requestRender() {} } as any;
	const component = new SubagentMonitorComponent(store, "session", tui, theme(), () => {});
	assert.match(plain(component.render(80)), /\$ sleep 30/);
	store.observeJsonEvent(runId, { type: "tool_execution_end", toolCallId: "bash-1", toolName: "bash", isError: false });
	assert.match(plain(component.render(80)), /\$ sleep 30/);
	component.dispose();
});

test("expanded arguments remain reachable when a tool name exceeds narrow width", () => {
	const store = new SubagentMonitorStore();
	const runId = queue(store, "narrow");
	store.markStarting(runId);
	store.observeJsonEvent(runId, {
		type: "tool_execution_start",
		toolCallId: "parallel",
		toolName: "multi_tool_use.parallel",
		args: { tasks: [{ command: `${"segment ".repeat(20)}ARGUMENT_TAIL` }] },
	});
	const component = new SubagentMonitorComponent(
		store,
		"session",
		{ terminal: { rows: 18 }, requestRender() {} } as any,
		theme(),
		() => {},
	);
	component.handleInput("\x0f");
	let pages = "";
	for (let page = 0; page < 20; page++) {
		const lines = component.render(30);
		assert.ok(lines.every((line) => visibleWidth(line) <= 30));
		pages += `\n${plain(lines)}`;
		component.handleInput("\x1b[1;3A");
	}
	assert.match(pages, /ARGUMENT_TAIL/);
	component.dispose();
});

test("Ctrl+O exposes full wrapped work in chronological order", () => {
	let now = Date.now();
	const store = new SubagentMonitorStore(() => ++now);
	const runId = queue(store, "expanded-tools");
	store.updateMetadata(runId, { task: `${"task-segment ".repeat(30)}TASK_TAIL` });
	store.markStarting(runId);
	const firstCommand = `printf '${"command-segment ".repeat(90)}COMMAND_TAIL'`;
	store.observeJsonEvent(runId, { type: "tool_execution_start", toolCallId: "first", toolName: "bash", args: { command: firstCommand } });
	store.observeJsonEvent(runId, {
		type: "tool_execution_end",
		toolCallId: "first",
		toolName: "bash",
		isError: false,
		result: { content: [{ type: "text", text: `${"output-segment ".repeat(900)}OUTPUT_TAIL` }] },
	});
	store.observeJsonEvent(runId, { type: "tool_execution_start", toolCallId: "second", toolName: "bash", args: { command: "second command" } });
	store.observeJsonEvent(runId, { type: "tool_execution_start", toolCallId: "third", toolName: "bash", args: { command: "third command" } });
	store.observeJsonEvent(runId, {
		type: "tool_execution_start",
		toolCallId: "fourth",
		toolName: "write",
		args: { path: "output.txt", content: `${"argument-content ".repeat(30)}ARGUMENT_TAIL` },
	});
	store.observeJsonEvent(runId, {
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: "FIRST_VISIBLE_MESSAGE" }] },
	});
	store.observeJsonEvent(runId, {
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: `${"visible-output ".repeat(30)}VISIBLE_TAIL` }] },
	});
	const component = new SubagentMonitorComponent(
		store,
		"session",
		{ terminal: { rows: 24 }, requestRender() {} } as any,
		theme(),
		() => {},
	);
	const compact = allPages(component, 52);
	assert.doesNotMatch(compact, /Expanded work|Tool history|Timeline/);
	assert.ok(compact.indexOf("second command") < compact.indexOf("third command"), "new concurrent tools should be appended downward");

	component.handleInput("\x0f");
	const expandedHistory = allPages(component, 52);
	assert.match(expandedHistory, /TASK_TAIL/);
	assert.match(expandedHistory, /COMMAND_TAIL/);
	assert.match(expandedHistory, /OUTPUT_TAIL/);
	assert.match(expandedHistory, /ARGUMENT_TAIL/);
	assert.match(expandedHistory, /FIRST_VISIBLE_MESSAGE/);
	assert.match(expandedHistory, /VISIBLE_TAIL/);
	component.handleInput("\x0f");
	assert.doesNotMatch(component.render(52).join("\n"), /Expanded work|Tool history|Timeline/);
	component.dispose();
});

test("prompt, notes, thinking and tools share native chronological history with independent toggles", () => {
	const store = new SubagentMonitorStore();
	const runId = queue(store, "reader");
	store.markStarting(runId);
	store.observeJsonEvent(runId, {
		type: "message_end",
		message: { role: "assistant", content: [
			{ type: "text", text: "NOTE_BEFORE" },
			{ type: "thinking", thinking: "VISIBLE_THINKING" },
			{ type: "toolCall", id: "read", name: "read", arguments: { path: "example.ts" } },
			{ type: "text", text: "NOTE_AFTER" },
		] },
	});
	store.observeJsonEvent(runId, { type: "tool_execution_start", toolCallId: "read", toolName: "read", args: { path: "example.ts" } });
	store.observeJsonEvent(runId, { type: "tool_execution_end", toolCallId: "read", toolName: "read", result: { content: [{ type: "text", text: "const TOOL_OUTPUT = 42;" }] }, isError: false });
	const before = JSON.stringify(store.getRun(runId));
	const component = new SubagentMonitorComponent(store, "session", { terminal: { rows: 30 }, requestRender() {} } as any, theme(), () => {});
	const history = allPages(component, 95);
	assert.ok(history.indexOf("inspect reader") < history.indexOf("NOTE_BEFORE"));
	assert.ok(history.indexOf("NOTE_BEFORE") < history.indexOf("VISIBLE_THINKING"));
	assert.ok(history.indexOf("VISIBLE_THINKING") < history.indexOf("read example.ts"));
	assert.ok(history.indexOf("read example.ts") < history.indexOf("NOTE_AFTER"));
	assert.doesNotMatch(history, /TOOL_OUTPUT/);
	component.handleInput("\x0f");
	assert.match(allPages(component, 95), /TOOL_OUTPUT/);
	component.handleInput("\x14");
	const collapsedThinking = allPages(component, 95);
	assert.doesNotMatch(collapsedThinking, /VISIBLE_THINKING/);
	assert.match(collapsedThinking, /Thinking…/);
	component.handleInput("\x1b\x0f");
	const notesOnly = allPages(component, 95);
	assert.match(notesOnly, /inspect reader/);
	assert.match(notesOnly, /NOTE_BEFORE/);
	assert.match(notesOnly, /NOTE_AFTER/);
	assert.doesNotMatch(notesOnly, /read example.ts|TOOL_OUTPUT|VISIBLE_THINKING|Thinking…/);
	component.handleInput("\x14"); // saved preference changes without leaving notes-only
	assert.doesNotMatch(allPages(component, 95), /VISIBLE_THINKING/);
	component.handleInput("\x1b[111;7u"); // Kitty Ctrl+Alt+O
	const restored = allPages(component, 95);
	assert.match(restored, /TOOL_OUTPUT/);
	assert.match(restored, /VISIBLE_THINKING/);
	assert.equal(JSON.stringify(store.getRun(runId)), before, "view controls must not mutate child state");
	component.dispose();
});

test("tabs overflow in queue order and every selection opens at the latest work", () => {
	const store = new SubagentMonitorStore();
	const ids = Array.from({ length: 7 }, (_, index) => queue(store, `agent${index + 1}`, index));
	for (const id of ids) {
		store.markStarting(id);
		for (let line = 0; line < 50; line++) {
			store.observeJsonEvent(id, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `ROW_${line}` }] } });
		}
	}
	const component = new SubagentMonitorComponent(store, "session", { terminal: { rows: 20 }, requestRender() {} } as any, theme(), () => {});
	assert.match(plain(component.render(40)), /›/);
	const views = (component as any).views;
	const scrollAway = () => {
		component.handleInput("\x1b[H");
		component.render(40);
		assert.equal(views.get((component as any).selectedRunId).followTail, false);
	};
	scrollAway();
	for (let index = 0; index < 6; index++) component.handleInput("\x1b[C");
	const lastTab = plain(component.render(40));
	assert.match(lastTab, /\[● 7:agent7\]/);
	assert.match(lastTab, /‹/);
	scrollAway();
	for (const key of ["\x1b[C", "\x1b[D", "\t", "\x1b[Z"]) {
		component.handleInput(key);
		assert.match(plain(component.render(40)), /ROW_49/);
		assert.equal(views.get((component as any).selectedRunId).followTail, true);
		scrollAway();
	}
	store.finishRun(ids[6]!, "completed");
	assert.match(plain(component.render(40)), /ROW_49/);
	assert.equal((component as any).selectedRunId, ids[0]);
	assert.equal(views.get(ids[0]).followTail, true, "selection after a run finishes also starts at the bottom");
	component.dispose();
});

test("Up and Down scroll a viewport minus two lines and immediately settle at the bottom", () => {
	const store = new SubagentMonitorStore();
	const id = queue(store, "pager");
	store.observeJsonEvent(id, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: Array.from({ length: 100 }, (_, index) => `ROW_${index}`).join("\n") }] } });
	for (const height of [8, 20]) {
		const component = new SubagentMonitorComponent(store, "session", { terminal: { rows: height }, requestRender() {} } as any, theme(), () => {});
		(component as any).messages.render = (entry: any) => entry.text.split("\n");
		const body = () => plain(component.render(80)).split("\n").slice(height >= 16 ? 3 : 2);
		const tail = body();
		const view = (component as any).views.get(id);
		component.handleInput("\x1b[H");
		const first = body();
		assert.equal(first.length, view.pageSize);
		component.handleInput("\x1b[B");
		assert.deepEqual(body().slice(0, 2), first.slice(-2));
		component.handleInput("\x1b[A");
		assert.deepEqual(body(), first);
		for (let page = 0; page < 100 && !view.followTail; page++) {
			component.handleInput("\x1b[B");
			body();
		}
		assert.equal(view.followTail, true);
		assert.deepEqual(body(), tail, "reaching the bottom must not leave a partly empty viewport until the next tick");
		component.handleInput("\x1b[A");
		assert.deepEqual(body().slice(-2), tail.slice(0, 2));
		component.dispose();
	}
});

test("latest view follows new tools and streaming output but leaves deliberate scrollback alone", async () => {
	const store = new SubagentMonitorStore();
	const id = queue(store, "follower");
	store.markStarting(id);
	store.observeJsonEvent(id, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "An earlier note.\n\n".repeat(30) }] } });
	const component = new SubagentMonitorComponent(store, "session", { terminal: { rows: 20 }, requestRender() {} } as any, theme(), () => {});
	component.handleInput("\x0f");
	component.render(80);
	const view = (component as any).views.get(id);
	store.observeJsonEvent(id, { type: "tool_execution_start", toolCallId: "bash", toolName: "bash", args: { command: "NEW_TOOL_SENTINEL" } });
	assert.match(plain(component.render(80)), /NEW_TOOL_SENTINEL/);
	const output = Array.from({ length: 50 }, (_, index) => `OUTPUT_${index}`).join("\n");
	store.observeJsonEvent(id, { type: "tool_execution_update", toolCallId: "bash", toolName: "bash", partialResult: { content: [{ type: "text", text: output }] } });
	await wait(250);
	assert.match(plain(component.render(80)), /OUTPUT_49/);
	assert.equal(view.followTail, true);
	component.handleInput("\x1b[A");
	const reading = plain(component.render(80)).split("\n").slice(3);
	assert.equal(view.followTail, false);
	store.observeJsonEvent(id, { type: "tool_execution_update", toolCallId: "bash", toolName: "bash", partialResult: { content: [{ type: "text", text: `${output}\nSTREAM_TAIL` }] } });
	store.observeJsonEvent(id, { type: "tool_execution_start", toolCallId: "read", toolName: "read", args: { path: "NEWEST_TOOL_SENTINEL" } });
	assert.deepEqual(plain(component.render(80)).split("\n").slice(3), reading);
	component.handleInput("\x1b[F");
	const latest = plain(component.render(80));
	assert.match(latest, /STREAM_TAIL/);
	assert.match(latest, /NEWEST_TOOL_SENTINEL/);
	assert.equal(view.followTail, true);
	component.dispose();
});

test("scrolling and elapsed ticks reuse native render caches; narrow Unicode/code lines wrap", () => {
	const store = new SubagentMonitorStore();
	const id = queue(store, "中文-agent-🚀");
	store.observeJsonEvent(id, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `\`\`\`ts\n${"界".repeat(70)}CODE_TAIL\n\`\`\`` }] } });
	const tui = { terminal: { rows: 25 }, requestRender() {} } as any;
	const component = new SubagentMonitorComponent(store, "session", tui, theme(), () => {});
	const content = allPages(component, 30);
	assert.match(content, /CODE_TAIL/);
	const cache = (component as any).messages.cache as Map<number, any>;
	const cached = [...cache.values()].map((entry) => entry.lines);
	component.handleInput("\x1b[A");
	component.render(30);
	(component as any).clockRevision++;
	component.render(30);
	assert.deepEqual([...cache.values()].map((entry) => entry.lines), cached);
	assert.ok([...cache.values()].every((entry, index) => entry.lines === cached[index]));
	for (const width of [0, 1, 7, 8, 14, 30, 80, 120]) {
		for (const height of [1, 2, 3, 4, 9, 14, 25]) {
			tui.terminal.rows = height;
			const lines = component.render(width);
			assert.equal(lines.length, height);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			assert.ok(lines.every((line) => !line.includes("\x1b]133;")));
		}
	}
	component.dispose();
});

test("expansion and resize leave offscreen tool components unmaterialized and unchanged", () => {
	const store = new SubagentMonitorStore();
	const id = queue(store, "reader");
	const output = Array.from({ length: 100 }, (_, index) => `OUTPUT_ROW_${index}`).join("\n");
	for (let index = 0; index < 80; index++) {
		store.observeJsonEvent(id, { type: "tool_execution_start", toolCallId: `read-${index}`, toolName: "read", args: { path: "output.txt" } });
		store.observeJsonEvent(id, { type: "tool_execution_end", toolCallId: `read-${index}`, toolName: "read", result: { content: [{ type: "text", text: output }] }, isError: false });
	}
	const component = new SubagentMonitorComponent(store, "session", { terminal: { rows: 24 }, requestRender() {} } as any, theme(), () => {});
	component.handleInput("\x1b[H");
	component.render(100);
	const cache = (component as any).messages.cache as Map<number, any>;
	const tools = store.getRun(id)!.transcript.filter((entry) => entry.type === "tool");
	const first = cache.get(tools[0]!.id);
	assert.ok(first);
	const firstLines = first.lines;
	component.handleInput("\x1b[F");
	component.render(100);
	component.handleInput("\x0f");
	assert.match(plain(component.render(100)), /OUTPUT_ROW_99/);
	component.render(90);
	assert.equal(cache.has(tools[40]!.id), false);
	assert.ok(cache.size < 30, "only blocks near visited viewports should be created");
	assert.equal(first.expanded, false);
	assert.equal(first.width, 100);
	assert.equal(first.lines, firstLines, "offscreen rows should not be wrapped at the new width");
	component.dispose();
});

test("one-row viewports still scroll across empty entries without phantom rows", () => {
	const store = new SubagentMonitorStore();
	const id = queue(store, "reader");
	for (const text of ["FIRST", "", "", "LAST"]) {
		store.observeJsonEvent(id, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
	}
	const component = new SubagentMonitorComponent(store, "session", { terminal: { rows: 3 }, requestRender() {} } as any, theme(), () => {});
	(component as any).messages.render = (entry: any) => entry.text ? [entry.text] : [];
	const expected = ["inspect reader", "", "FIRST", "", "LAST", ""];
	const row = () => plain(component.render(80)).split("\n")[2]!.trim();
	component.handleInput("\x1b[H");
	for (const text of expected) {
		assert.equal(row(), text);
		component.handleInput("\x1b[B");
	}
	component.handleInput("\x1b[F");
	for (const text of expected.toReversed()) {
		assert.equal(row(), text);
		component.handleInput("\x1b[A");
	}
	component.dispose();
});

test("monitor status and durations stay compact", () => {
	assert.equal(formatMonitorDuration(18), "18ms");
	assert.equal(formatMonitorDuration(1_250), "1.3s");
	assert.equal(formatMonitorDuration(65_000), "1:05");
	assert.equal(formatMonitorStatus({ total: 3, active: 2, queued: 1 }), "agents 2 active · 1 queued · Alt+A");
	assert.equal(formatMonitorStatus({ total: 0, active: 0, queued: 0 }), undefined);
});

test("expanded monitored cards preserve complete result output", () => {
	const store = new SubagentMonitorStore();
	const runId = store.queueRun({ orchestrationId: "expanded", sessionId: "session", kind: "one-off", mode: "single", agent: "domain", task: "inspect" });
	store.markStarting(runId);
	store.finishRun(runId, "completed");
	const output = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n");
	const component = renderSubagentResult(
		{
			content: [{ type: "text", text: output }],
			details: { results: [{ agent: "domain", task: "inspect", exitCode: 0, status: "completed", messages: [{ role: "assistant", content: [{ type: "text", text: output }] }] }] },
		},
		{ expanded: true },
		theme(),
		{ toolCallId: "expanded" },
		store,
	);
	assert.match(component.render(120).join("\n"), /line 10/);
});

test("expanded monitored cards preserve stderr beyond the monitor preview", () => {
	const store = new SubagentMonitorStore();
	const runId = store.queueRun({ orchestrationId: "stderr", sessionId: "session", kind: "one-off", mode: "single", agent: "domain", task: "fail" });
	store.markStarting(runId);
	store.finishRun(runId, "failed", "short preview");
	const stderr = `${"x".repeat(300)} END`;
	const component = renderSubagentResult(
		{
			content: [{ type: "text", text: "failed" }],
			details: { results: [{ agent: "domain", task: "fail", exitCode: 1, status: "failed", stderr, messages: [] }] },
		},
		{ expanded: true },
		theme(),
		{ toolCallId: "stderr" },
		store,
	);
	assert.match(component.render(400).join("\n"), / END/);
	const fallback = renderSubagentResult(
		{ content: [{ type: "text", text: "failed" }], details: { results: [{ agent: "domain", task: "fail", exitCode: 1, status: "failed", stderr, messages: [] }] } },
		{ expanded: true },
		theme(),
		{ toolCallId: "unmonitored" },
	);
	assert.match(fallback.render(400).join("\n"), / END/);

	const namedStore = new SubagentMonitorStore();
	const namedRun = namedStore.queueRun({ orchestrationId: "named-recovery", sessionId: "session", kind: "named", mode: "single", agent: "domain", task: "new prompt" });
	namedStore.markStarting(namedRun);
	namedStore.finishRun(namedRun, "failed", "short preview");
	const named = renderNamedInvokeResult(
		{ content: [{ type: "text", text: "failed" }], details: { name: "domain", result: { agent: "domain", task: "older recovery task", exitCode: 1, status: "failed", stderr, messages: [] } } },
		{ expanded: true },
		theme(),
		{ toolCallId: "named-recovery" },
		namedStore,
	);
	assert.match(named.render(400).join("\n"), / END/);
});

test("tool-level errors override missing run details in transcript cards", () => {
	const component = renderSubagentResult(
		{ content: [{ type: "text", text: "spawn failed" }] },
		{ expanded: false },
		theme(),
		{ toolCallId: "missing", isError: true },
	);
	assert.match(component.render(80).join("\n"), /^✗ agents failed/);
});

test("monitor opens only for current work and closes when the final run ends", async () => {
	const commands = new Map<string, any>();
	const shortcuts = new Map<string, any>();
	const pi = {
		registerCommand(name: string, value: any) { commands.set(name, value); },
		registerShortcut(name: string, value: any) { shortcuts.set(name, value); },
		on() {},
	} as any;
	let overlayOptions: unknown;
	let component: SubagentMonitorComponent | undefined;
	let customCalls = 0;
	const notifications: string[] = [];
	const ui = {
		custom(factory: any, options: unknown) {
			customCalls++;
			overlayOptions = options;
			return new Promise<void>((resolve) => {
				component = factory(
					{ terminal: { rows: 20 }, requestRender() {} },
					theme(),
					{},
					() => {
						component?.dispose();
						resolve();
					},
				);
			});
		},
		notify(message: string) { notifications.push(message); },
	} as any;
	const store = new SubagentMonitorStore();
	const controller = installSubagentMonitorUI(pi, store);
	const context = { mode: "tui", ui, sessionManager: { getSessionId: () => "session" } };
	await commands.get("subagents").handler("", context);
	assert.equal(customCalls, 0);
	assert.deepEqual(notifications, ["No current subagents."]);

	const runId = queue(store, "live");
	const opening = commands.get("subagents").handler("", context);
	await Promise.resolve();
	assert.equal(controller.isOpen(), true);
	assert.deepEqual(overlayOptions, {
		overlay: true,
		overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 },
	});
	assert.ok(shortcuts.has("alt+a"));
	store.finishRun(runId, "completed");
	await opening;
	assert.equal(controller.isOpen(), false);
});

test("runSingleAgent feeds raw child tool lifecycle events into the monitor", async (t) => {
	const root = mkdtempSync("/tmp/pi-subagent-monitor-");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const child = join(root, "child.mjs");
	writeFileSync(child, `
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } };
const message = { role: "assistant", content: [{ type: "text", text: "done" }], api: "fake", provider: "fake", model: "fake-model", usage, stopReason: "stop", timestamp: Date.now() };
const user = { role: "user", content: [{ type: "text", text: process.argv.at(-1) }], timestamp: Date.now() };
const emit = value => process.stdout.write(JSON.stringify(value) + "\\n");
emit({ type: "agent_start" });
emit({ type: "message_end", message: user });
emit({ type: "turn_start" });
emit({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "README.md" } });
setTimeout(() => {
  emit({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", args: { path: "README.md" }, result: {}, isError: false });
  emit({ type: "message_end", message });
}, 10);
setTimeout(() => process.exit(0), 20);
`);
	const agent = {
		name: "test-agent",
		description: "test",
		systemPrompt: "ACTUAL CHILD CREATION INSTRUCTIONS",
		source: "user" as const,
		filePath: child,
	};
	const store = new SubagentMonitorStore();
	const runId = store.queueRun({
		orchestrationId: "integration",
		sessionId: "session",
		kind: "one-off",
		mode: "single",
		agent: agent.name,
		task: "inspect",
		creationInstructions: agent.systemPrompt,
	});
	let observed: any;
	const unsubscribe = store.subscribe(() => {
		const current = store.getRun(runId);
		if (current) observed = structuredClone(current);
	});
	const result = await runSingleAgent(
		root,
		[agent],
		agent.name,
		"inspect",
		undefined,
		"none",
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		(results) => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results }),
		{
			runsRoot: join(root, "runs"),
			invocation: (args) => ({ command: process.execPath, args: [child, ...args] }),
			retainTerminalSession: true,
			monitor: { store, runId },
		},
	);
	unsubscribe();
	assert.equal(result.exitCode, 0);
	assert.equal(observed.model, "fake-model");
	assert.deepEqual(observed.transcript.slice(0, 2).map((entry: any) => [entry.label, entry.text]), [
		["Creation instructions", "ACTUAL CHILD CREATION INSTRUCTIONS"],
		["Initial task", "inspect"],
	]);
	assert.equal(observed.transcript.filter((entry: any) => entry.label === "Creation instructions").length, 1);
	assert.equal(observed.tools[0]?.name, "read");
	assert.equal(observed.tools[0]?.preview, "README.md");
	assert.equal(observed.latestText, "done");
	assert.equal(store.getRun(runId), undefined);
	assert.ok(result.resume);

	const recoveryRunId = store.queueRun({
		orchestrationId: "integration-recovery", sessionId: "session", kind: "continuation", mode: "single",
		agent: agent.name, task: "inspect", creationInstructions: agent.systemPrompt,
	});
	let recoveryObserved: any;
	const unsubscribeRecovery = store.subscribe(() => {
		const current = store.getRun(recoveryRunId);
		if (current) recoveryObserved = structuredClone(current);
	});
	await runSingleAgent(
		root, [agent], agent.name, "inspect", undefined, "none", undefined, undefined, undefined, undefined, undefined,
		(results) => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results }),
		{
			resumeFrom: result,
			invocation: (args) => ({ command: process.execPath, args: [child, ...args] }),
			monitor: { store, runId: recoveryRunId },
		},
	);
	unsubscribeRecovery();
	assert.deepEqual(
		recoveryObserved.transcript.filter((entry: any) => entry.type === "prompt").map((entry: any) => [entry.label, entry.text]),
		[
			["Creation instructions", "ACTUAL CHILD CREATION INSTRUCTIONS"],
			["Initial task", "inspect"],
			["Recovery prompt", "Task: inspect"],
		],
	);
	assert.deepEqual(store.getSummary("session"), { total: 0, queued: 0, active: 0 });
});

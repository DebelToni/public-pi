import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import toolSwitchboard from "./index.ts";

function harness(t: { after: (fn: () => void) => void }, initial = ["read", "set_reasoning", "bash"], extra: string[] = []) {
	const dir = mkdtempSync(join(tmpdir(), "pi-tool-switchboard-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	});
	let active = [...initial];
	const all = ["read", "set_reasoning", "bash", ...extra];
	const handlers = new Map<string, () => void>();
	let command: (args: string, ctx: any) => Promise<void>;
	const selected: Array<string | undefined> = [];
	const notifications: string[] = [];
	const labels: string[][] = [];
	const pi = {
		on(event: string, handler: () => void) { handlers.set(event, handler); },
		registerCommand(name: string, config: { handler: typeof command }) {
			assert.equal(name, "tools");
			command = config.handler;
		},
		getActiveTools() { return [...active]; },
		getAllTools() { return all.map((name) => ({ name })); },
		setActiveTools(names: string[]) { active = [...names]; },
	} as unknown as ExtensionAPI;
	toolSwitchboard(pi);
	const ctx = {
		hasUI: true,
		ui: {
			notify(message: string) { notifications.push(message); },
			async select(_title: string, options: string[]) {
				labels.push(options);
				return selected.shift();
			},
		},
	};
	return {
		path: join(dir, "disabled-tools.json"),
		get active() { return active; },
		get notifications() { return notifications; },
		get labels() { return labels; },
		select(...choices: Array<string | undefined>) { selected.push(...choices); },
		fire(event: string) { handlers.get(event)?.(); },
		async run(args: string) { await command(args, ctx); },
		async renderTui(rows: number) {
			let height = 0;
			await command("", {
				...ctx,
				mode: "tui",
				ui: {
					...ctx.ui,
					async custom(factory: any) {
						const component = factory(
							{ terminal: { rows }, requestRender() {} },
							{ fg: (_color: string, text: string) => text },
							{},
							() => {},
						);
						height = component.render(80).length;
						component.handleInput("\r");
					},
				},
			});
			return height;
		},
		setActive(names: string[]) { active = names; },
	};
}

test("blocks configured tools at startup and restores them through /tools", async (t) => {
	const h = harness(t);
	writeFileSync(h.path, '["set_reasoning"]');
	h.fire("session_start");
	assert.deepEqual(h.active, ["read", "bash"]);
	await h.run("set_reasoning on");
	assert.deepEqual(h.active, ["read", "bash", "set_reasoning"]);
	assert.deepEqual(JSON.parse(readFileSync(h.path, "utf8")), []);
	await h.run("set_reasoning off");
	assert.deepEqual(h.active, ["read", "bash"]);
	assert.deepEqual(JSON.parse(readFileSync(h.path, "utf8")), ["set_reasoning"]);
});

test("menu toggles tools and persists globally across extension instances", async (t) => {
	const h = harness(t);
	h.fire("session_start");
	h.select("allowed  set_reasoning", undefined);
	await h.run("");
	assert.deepEqual(JSON.parse(readFileSync(h.path, "utf8")), ["set_reasoning"]);
	assert.ok(h.labels[1].includes("blocked  set_reasoning"));
	assert.deepEqual(h.active, ["read", "bash"]);
	// The blocked list survives a session restart.
	h.fire("session_start");
	assert.deepEqual(h.active, ["read", "bash"]);
});

test("reconciles changes from another session before each model call", async (t) => {
	const h = harness(t);
	h.fire("session_start");
	writeFileSync(h.path, '["set_reasoning"]');
	h.fire("context");
	assert.deepEqual(h.active, ["read", "bash"]);
	writeFileSync(h.path, "[]");
	h.fire("before_agent_start");
	assert.deepEqual(h.active, ["read", "bash", "set_reasoning"]);
});

test("does not activate a tool absent from the session's loadout", async (t) => {
	const h = harness(t, ["read", "bash"]);
	writeFileSync(h.path, '["set_reasoning"]');
	h.fire("session_start");
	await h.run("set_reasoning on");
	assert.deepEqual(h.active, ["read", "bash"]);
	await h.run("no_such_tool off");
	assert.deepEqual(JSON.parse(readFileSync(h.path, "utf8")), []);
	assert.match(h.notifications.at(-1)!, /Usage/);
});

test("TUI selector fits short terminals and toggles without reopening", async (t) => {
	const h = harness(t, ["read", "set_reasoning", "bash"], Array.from({ length: 40 }, (_, i) => `tool_${i}`));
	h.fire("session_start");
	const height = await h.renderTui(16);
	assert.ok(height <= 16 - 6, `selector occupied ${height} of 16 rows`);
	assert.deepEqual(JSON.parse(readFileSync(h.path, "utf8")), ["bash"]);
});

test("filters tools activated after startup on the next provider request", (t) => {
	const h = harness(t);
	writeFileSync(h.path, '["set_reasoning"]');
	h.fire("session_start");
	h.setActive(["read", "bash", "set_reasoning"]);
	h.fire("context");
	assert.deepEqual(h.active, ["read", "bash"]);
});

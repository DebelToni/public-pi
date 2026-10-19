import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import manageReasoning, { installReasoningManagement, TOOL_DESCRIPTION } from "./index.ts";

const firstModel = { provider: "codex-a", id: "gpt-6.1-sol" };
const secondModel = { provider: "codex-b", id: "gpt-6-luna" };
const thirdModel = { provider: "codex-c", id: "gpt-6-astra" };

function harness(initialThinkingLevel = "medium", initialModel = firstModel) {
	let thinkingLevel = initialThinkingLevel;
	let runtimeReady = false;
	let model = initialModel;
	let scopedModels: any[] = [];
	let shortcut: any;
	let tool: any;
	const handlers = new Map<string, (event: any, ctx: any) => void>();
	const changes: string[] = [];
	const context = () => ({ model, scopedModels });
	const fire = (event: string, value: any) => handlers.get(event)?.(value, context());
	const pi = {
		on(event: string, handler: (value: any, ctx: any) => void) {
			handlers.set(event, handler);
		},
		registerShortcut(key: string, value: any) { shortcut = { key, ...value }; },
		registerTool(value: any) { tool = value; },
		setThinkingLevel(level: string) {
			if (level === thinkingLevel) return;
			const previousLevel = thinkingLevel;
			thinkingLevel = level;
			changes.push(level);
			fire("thinking_level_select", { type: "thinking_level_select", level, previousLevel });
		},
		getThinkingLevel() {
			if (!runtimeReady) throw new Error("Extension runtime not initialized");
			return thinkingLevel;
		},
	} as unknown as ExtensionAPI;
	installReasoningManagement(pi);
	return {
		get tool() { return tool; },
		get shortcut() { assert.ok(shortcut); return shortcut; },
		start(reason = "startup") {
			runtimeReady = true;
			fire("session_start", { type: "session_start", reason });
		},
		setThinking(level: string) { (pi as any).setThinkingLevel(level); },
		cycleThinking() { shortcut.handler(context()); },
		selectModel(nextModel: typeof firstModel, resetLevel: string, source = "set") {
			const previousModel = model;
			model = nextModel;
			(pi as any).setThinkingLevel(resetLevel);
			fire("model_select", { type: "model_select", model: nextModel, previousModel, source });
		},
		restoreModel(nextModel: typeof firstModel, restoredLevel: string) {
			const previousModel = model;
			model = nextModel;
			(pi as any).setThinkingLevel(restoredLevel);
			fire("model_select", { type: "model_select", model: nextModel, previousModel, source: "restore" });
		},
		pinScopedModel(target: typeof firstModel, level: string) {
			scopedModels = [{ model: target, thinkingLevel: level }];
		},
		get level() { return thinkingLevel; },
		changes,
	};
}

test("session startup keeps Pi's configured or restored reasoning level", () => {
	for (const reason of ["startup", "new", "resume", "fork", "reload"]) {
		const h = harness("medium");
		h.start(reason);
		assert.equal(h.level, "medium");
		assert.deepEqual(h.changes, []);
	}
});

test("model selection preserves the current session reasoning level", () => {
	const h = harness("medium");
	h.start();
	h.setThinking("high");
	h.selectModel(secondModel, "medium");
	assert.equal(h.level, "high");
	h.selectModel(thirdModel, "medium");
	assert.equal(h.level, "high");
	assert.deepEqual(h.changes, ["high", "medium", "high", "medium", "high"]);
});

test("manual reasoning changes replace the level preserved by later model selections", () => {
	const h = harness("medium");
	h.start();
	h.setThinking("high");
	h.setThinking("low");
	h.selectModel(secondModel, "medium");
	assert.equal(h.level, "low");
});

test("scoped model cycles retain their explicit reasoning level", () => {
	const h = harness("medium");
	h.start();
	h.pinScopedModel(secondModel, "high");
	h.selectModel(secondModel, "high", "cycle");
	assert.equal(h.level, "high");
	h.selectModel(thirdModel, "medium");
	assert.equal(h.level, "high");
});

test("session restoration accepts the reasoning level restored by Pi", () => {
	const h = harness("medium");
	h.start();
	h.restoreModel(secondModel, "low");
	assert.equal(h.level, "low");
	h.selectModel(thirdModel, "medium");
	assert.equal(h.level, "low");
});

test("Shift+Tab cycles Astra through high and max only", () => {
	const h = harness("low", thirdModel);
	h.start();
	assert.equal(h.shortcut.key, "shift+tab");
	h.cycleThinking();
	assert.equal(h.level, "high");
	h.cycleThinking();
	assert.equal(h.level, "max");
	h.cycleThinking();
	assert.equal(h.level, "high");
	assert.deepEqual(h.changes, ["high", "max", "high"]);
});

test("Shift+Tab keeps Sol and Luna at high", () => {
	for (const model of [firstModel, secondModel]) {
		const h = harness("low", model);
		h.start();
		h.cycleThinking();
		assert.equal(h.level, "high");
		h.cycleThinking();
		assert.equal(h.level, "high");
		assert.deepEqual(h.changes, ["high"]);
	}
});

test("the tool requires a low, high, or max reasoning level", async () => {
	for (const level of ["low", "high", "max"]) {
		const h = harness("medium");
		h.start();
		assert.equal(h.tool.name, "set_reasoning");
		assert.equal(h.tool.description, TOOL_DESCRIPTION);
		assert.deepEqual(h.tool.parameters.required, ["level"]);
		assert.deepEqual(h.tool.parameters.properties.level.enum, ["low", "high", "max"]);
		const result = await h.tool.execute("call", { level }, new AbortController().signal, () => {}, {});
		assert.equal(h.level, level);
		assert.equal(result.content[0].text, `Reasoning level switched to ${level}.`);
		assert.deepEqual(result.details, { thinkingLevel: level });
		assert.deepEqual(h.changes, [level]);
	}
});

test("the tool's choice survives later model selections", async () => {
	for (const level of ["low", "high", "max"]) {
		const h = harness("medium");
		h.start();
		await h.tool.execute("call", { level }, new AbortController().signal, () => {}, {});
		h.selectModel(secondModel, "medium");
		assert.equal(h.level, level);
	}
});

test("subagent processes receive neither the preservation hooks nor the tool", () => {
	const previous = process.env.PI_SUBAGENT;
	process.env.PI_SUBAGENT = "1";
	let registrations = 0;
	const pi = {
		on() { registrations++; },
		registerTool() { registrations++; },
	} as unknown as ExtensionAPI;
	try {
		manageReasoning(pi);
		assert.equal(registrations, 0);
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENT;
		else process.env.PI_SUBAGENT = previous;
	}
});

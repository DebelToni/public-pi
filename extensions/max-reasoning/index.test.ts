import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import maxReasoning, { installMaxReasoning, TOOL_DESCRIPTION } from "./index.ts";

function harness() {
	let thinkingLevel = "max";
	let tool: any;
	let sessionStart: ((event: any) => void) | undefined;
	const changes: string[] = [];
	const pi = {
		on(event: string, handler: (value: any) => void) {
			if (event === "session_start") sessionStart = handler;
		},
		registerTool(value: any) { tool = value; },
		setThinkingLevel(level: string) { thinkingLevel = level; changes.push(level); },
		getThinkingLevel() { return thinkingLevel; },
	} as unknown as ExtensionAPI;
	installMaxReasoning(pi);
	return {
		get tool() { assert.ok(tool); return tool; },
		start(reason: string) { assert.ok(sessionStart); sessionStart({ type: "session_start", reason }); },
		get level() { return thinkingLevel; },
		changes,
	};
}

test("every opened conversation starts at high regardless of its saved selection", () => {
	for (const reason of ["startup", "new", "resume", "fork"]) {
		const h = harness();
		h.start(reason);
		assert.equal(h.level, "high");
	}
});

test("reload preserves an in-conversation max switch", () => {
	const h = harness();
	h.start("reload");
	assert.equal(h.level, "max");
	assert.deepEqual(h.changes, []);
});

test("the parameterless tool performs the one-way max switch", async () => {
	const h = harness();
	h.start("startup");
	assert.equal(h.tool.name, "switch_to_max_reasoning");
	assert.equal(h.tool.description, TOOL_DESCRIPTION);
	assert.deepEqual(h.tool.parameters.properties, {});
	const result = await h.tool.execute("call", {}, new AbortController().signal, () => {}, {});
	assert.equal(h.level, "max");
	assert.equal(result.content[0].text, "Reasoning level switched to max.");
	assert.deepEqual(h.changes, ["high", "max"]);
});

test("subagent processes receive neither the reset hook nor the tool", () => {
	const previous = process.env.PI_SUBAGENT;
	process.env.PI_SUBAGENT = "1";
	let registrations = 0;
	const pi = {
		on() { registrations++; },
		registerTool() { registrations++; },
	} as unknown as ExtensionAPI;
	try {
		maxReasoning(pi);
		assert.equal(registrations, 0);
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENT;
		else process.env.PI_SUBAGENT = previous;
	}
});

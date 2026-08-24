import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import deepThink from "./index.ts";

function load(enabled: boolean) {
	const flags: unknown[] = [];
	const tools: any[] = [];
	let sessionStart: (() => void) | undefined;
	deepThink({
		registerFlag: (...args: unknown[]) => flags.push(args),
		getFlag: () => enabled,
		registerTool: (tool: unknown) => tools.push(tool),
		on: (event: string, handler: () => void) => {
			if (event === "session_start") sessionStart = handler;
		},
	} as unknown as ExtensionAPI);
	return { flags, tools, start: () => sessionStart?.() };
}

test("deep_think is disabled by default", () => {
	const extension = load(false);
	extension.start();
	assert.equal(extension.flags.length, 1);
	assert.equal(extension.tools.length, 0);
});

test("--deep_think enables one plaintext-only no-output tool", async () => {
	const extension = load(true);
	assert.equal(extension.tools.length, 0);
	extension.start();
	assert.equal(extension.tools.length, 1);
	const tool = extension.tools[0];
	assert.equal(tool.name, "deep_think");
	assert.equal(tool.description, "Write your reasoning scratchpad here.");
	assert.deepEqual(Object.keys(tool.parameters.properties), ["text"]);
	assert.equal(tool.parameters.additionalProperties, false);
	assert.deepEqual(await tool.execute(), { content: [] });
});

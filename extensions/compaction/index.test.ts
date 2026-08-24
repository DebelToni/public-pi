import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import compactionExtension, { FAST_COMPACTION_MODEL, resolveCompactionModelConfig } from "./index.ts";

test("current compaction provider follows the active subscription account", () => {
	assert.deepEqual(
		resolveCompactionModelConfig(
			{ compactionProvider: "current", compactionModel: "gpt-5.6-sol", compactionThinkingLevel: "high" },
			{ provider: "codex-pi6", id: "gpt-5.6-sol" },
		),
		{ provider: "codex-pi6", model: "gpt-5.6-sol", reasoning: "high" },
	);
});

test("explicit compaction providers remain available", () => {
	assert.deepEqual(
		resolveCompactionModelConfig(
			{ compactionProvider: "openai-codex", compactionModel: "gpt-5.6-sol" },
			{ provider: "codex-pi6", id: "gpt-5.6-sol" },
		),
		{ provider: "openai-codex", model: "gpt-5.6-sol", reasoning: "high" },
	);
});

test("provider-qualified model setting takes precedence", () => {
	assert.deepEqual(
		resolveCompactionModelConfig(
			{ compactionProvider: "current", compactionModel: "codex-pi3/gpt-5.6-luna" },
			{ provider: "codex-pi6", id: "gpt-5.6-sol" },
		),
		{ provider: "codex-pi3", model: "gpt-5.6-luna", reasoning: "high" },
	);
});

test("manual /compact fast uses Luna only for that compaction", async (t) => {
	const root = mkdtempSync("/tmp/pi-compaction-fast-");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(`${root}/.pi`);
	writeFileSync(`${root}/.pi/settings.json`, JSON.stringify({
		piCustom: { compactionProvider: "current", compactionModel: "gpt-5.6-sol" },
	}));

	const handlers = new Map<string, any[]>();
	let registeredCommands = 0;
	const pi = {
		registerCommand() { registeredCommands++; },
		on(event: string, handler: any) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
	} as any;
	compactionExtension(pi);

	const modelLookups: Array<[string, string]> = [];
	const context = {
		cwd: root,
		model: { provider: "codex-pro", id: "gpt-5.6-sol" },
		modelRegistry: {
			find(provider: string, model: string) {
				modelLookups.push([provider, model]);
				return undefined;
			},
		},
		ui: { notify() {} },
	} as any;
	const beforeCompact = handlers.get("session_before_compact")![0];
	const event = { preparation: {}, signal: new AbortController().signal };

	await beforeCompact({ ...event, reason: "manual", customInstructions: "fast" }, context);
	assert.deepEqual(modelLookups.at(-1), ["codex-pro", FAST_COMPACTION_MODEL]);

	await beforeCompact({ ...event, reason: "manual", customInstructions: "keep implementation details" }, context);
	assert.deepEqual(modelLookups.at(-1), ["codex-pro", "gpt-5.6-sol"]);

	await beforeCompact({ ...event, reason: "threshold", customInstructions: "fast" }, context);
	assert.deepEqual(modelLookups.at(-1), ["codex-pro", "gpt-5.6-sol"]);
	assert.equal(registeredCommands, 0, "the extension must leave the built-in /compact command in control");
});

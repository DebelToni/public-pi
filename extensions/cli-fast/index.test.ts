import assert from "node:assert/strict";
import test from "node:test";
import { applyCliFast, supportsCliFast } from "./index.ts";

const model = {
	provider: "openai-codex",
	api: "openai-codex-responses",
	reasoning: true,
};

test("--fast preserves the targeted model and forces medium priority", () => {
	const payload = {
		model: "gpt-5.6-sol-targeted",
		reasoning: { effort: "max", summary: "auto" },
		input: [{ role: "user", content: "test" }],
	};
	assert.deepEqual(applyCliFast(payload, model, true), {
		...payload,
		reasoning: { effort: "medium", summary: "auto" },
		service_tier: "priority",
	});
});

test("--fast follows Ctrl+F eligibility and stays invocation-scoped", () => {
	assert.equal(supportsCliFast({ ...model, provider: "codex-pi7" }), true);
	assert.equal(applyCliFast({}, model, false), undefined);
	assert.equal(applyCliFast({}, { ...model, reasoning: false }, true), undefined);
	assert.equal(applyCliFast({}, { ...model, provider: "anthropic" }, true), undefined);
	assert.equal(applyCliFast({}, { ...model, api: "openai-completions" }, true), undefined);
});
